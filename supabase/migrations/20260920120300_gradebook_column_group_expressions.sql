-- gradebook_column_group("<slug>") in score expressions.
--
-- Evaluators expand a group call into its member columns at evaluation time, and the
-- saved dependencies carry both the group id (dependencies.gradebook_column_groups) and
-- the member ids (dependencies.gradebook_columns). The existing recalculation joins read
-- only the member ids, so this migration keeps them current as columns join a group.

-- Columns whose score expressions name the group, as "Name (slug)" text for error messages.
CREATE OR REPLACE FUNCTION public._gradebook_column_group_assert_unreferenced(p_group_id bigint, p_action text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slug text;
  v_dependents text;
BEGIN
  SELECT string_agg(format('%s (%s)', gc.name, gc.slug), ', ' ORDER BY gc.id)
    INTO v_dependents
    FROM public.gradebook_columns gc
   WHERE gc.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(p_group_id);

  IF v_dependents IS NOT NULL THEN
    SELECT slug INTO v_slug FROM public.gradebook_column_groups WHERE id = p_group_id;
    RAISE EXCEPTION 'Cannot % group "%": it is referenced by the score expression of %. Edit those expressions first.',
      p_action, v_slug, v_dependents
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public._gradebook_column_group_assert_unreferenced(bigint, text) FROM PUBLIC, anon, authenticated;

-- Expressions name groups by slug, so a referenced slug must not change underneath them.
CREATE OR REPLACE FUNCTION public.gradebook_column_groups_protect_referenced_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    PERFORM public._gradebook_column_group_assert_unreferenced(OLD.id, 'change the slug of');
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_column_groups_protect_referenced_slug() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS gradebook_column_groups_protect_referenced_slug_tr ON public.gradebook_column_groups;
CREATE TRIGGER gradebook_column_groups_protect_referenced_slug_tr
  BEFORE UPDATE OF slug ON public.gradebook_column_groups
  FOR EACH ROW EXECUTE FUNCTION public.gradebook_column_groups_protect_referenced_slug();

-- When a column joins, leaves or is deleted from a group, the columns whose expressions
-- name that group are recalculated for every student. A joining column's id is appended
-- to each dependent's dependencies.gradebook_columns so the recalculator loads its values
-- and later edits to its scores reach the dependent. Ids are never removed on leave or
-- delete: evaluation expands membership live, so a stale id only costs an unneeded
-- recalculation, while removing it could drop a dependency the expression names directly.
CREATE OR REPLACE FUNCTION public.gradebook_columns_sync_group_dependents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changes jsonb;
  v_cycle record;
  v_rows jsonb[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', n.id, 'gradebook_id', n.gradebook_id,
             'joined_group_id', n.gradebook_column_group_id, 'left_group_id', NULL))
      INTO v_changes
      FROM new_table n;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', n.id, 'gradebook_id', n.gradebook_id,
             'joined_group_id', n.gradebook_column_group_id, 'left_group_id', o.gradebook_column_group_id))
      INTO v_changes
      FROM new_table n
      JOIN old_table o ON o.id = n.id
     WHERE n.gradebook_column_group_id IS DISTINCT FROM o.gradebook_column_group_id;
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', o.id, 'gradebook_id', o.gradebook_id,
             'joined_group_id', NULL, 'left_group_id', o.gradebook_column_group_id))
      INTO v_changes
      FROM old_table o;
  END IF;

  IF v_changes IS NULL THEN
    RETURN NULL;
  END IF;

  -- A column joining a group whose dependent it already depends on (directly or through
  -- other columns) would make that dependent read itself.
  WITH RECURSIVE joins AS (
    SELECT c.column_id, d.id AS dependent_id
      FROM jsonb_to_recordset(v_changes) AS c(column_id bigint, gradebook_id bigint, joined_group_id bigint)
      JOIN public.gradebook_columns d
        ON d.gradebook_id = c.gradebook_id
       AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(c.joined_group_id)
     WHERE c.joined_group_id IS NOT NULL
       AND d.id <> c.column_id
  ),
  reach(column_id, dependent_id, reached_id) AS (
    SELECT j.column_id, j.dependent_id, dep.value::bigint
      FROM joins j
      JOIN public.gradebook_columns gc ON gc.id = j.column_id
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(gc.dependencies -> 'gradebook_columns', '[]'::jsonb)) AS dep
    UNION
    SELECT r.column_id, r.dependent_id, dep.value::bigint
      FROM reach r
      JOIN public.gradebook_columns gc ON gc.id = r.reached_id
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(gc.dependencies -> 'gradebook_columns', '[]'::jsonb)) AS dep
  )
  SELECT joiner.name AS joiner_name, joiner.slug AS joiner_slug, dependent.name AS dependent_name,
         dependent.slug AS dependent_slug
    INTO v_cycle
    FROM reach r
    JOIN public.gradebook_columns joiner ON joiner.id = r.column_id
    JOIN public.gradebook_columns dependent ON dependent.id = r.dependent_id
   WHERE r.reached_id = r.dependent_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cycle detected: % (%) depends on % (%), so it cannot join a group that %''s score expression includes',
      v_cycle.joiner_name, v_cycle.joiner_slug, v_cycle.dependent_name, v_cycle.dependent_slug,
      v_cycle.dependent_name
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.gradebook_columns d
     SET dependencies = jsonb_set(
           COALESCE(d.dependencies, '{}'::jsonb),
           '{gradebook_columns}',
           COALESCE(d.dependencies -> 'gradebook_columns', '[]'::jsonb) || to_jsonb(additions.ids))
    FROM (
      SELECT d2.id, array_agg(DISTINCT c.column_id ORDER BY c.column_id) AS ids
        FROM jsonb_to_recordset(v_changes) AS c(column_id bigint, gradebook_id bigint, joined_group_id bigint)
        JOIN public.gradebook_columns d2
          ON d2.gradebook_id = c.gradebook_id
         AND d2.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(c.joined_group_id)
       WHERE c.joined_group_id IS NOT NULL
         AND d2.id <> c.column_id
         AND NOT COALESCE(d2.dependencies -> 'gradebook_columns', '[]'::jsonb) @> jsonb_build_array(c.column_id)
       GROUP BY d2.id
    ) additions
   WHERE d.id = additions.id;

  SELECT array_agg(jsonb_build_object(
           'class_id', r.class_id,
           'gradebook_id', r.gradebook_id,
           'student_id', r.student_id,
           'is_private', r.is_private,
           'source', 'deps_update'))
    INTO v_rows
    FROM (
      SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
        FROM (
          SELECT c.gradebook_id, g.group_id
            FROM jsonb_to_recordset(v_changes)
                   AS c(gradebook_id bigint, joined_group_id bigint, left_group_id bigint)
            CROSS JOIN LATERAL (VALUES (c.joined_group_id), (c.left_group_id)) AS g(group_id)
           WHERE g.group_id IS NOT NULL
        ) affected
        JOIN public.gradebook_columns d
          ON d.gradebook_id = affected.gradebook_id
         AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(affected.group_id)
        JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = d.id
       WHERE d.score_expression IS NOT NULL
    ) r;

  IF array_length(v_rows, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(v_rows);
  END IF;

  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_columns_sync_group_dependents() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_insert ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_sync_group_dependents_insert
  AFTER INSERT ON public.gradebook_columns
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebook_columns_sync_group_dependents();

-- Transition tables cannot be combined with a column list, so this fires on every UPDATE
-- statement and filters to rows whose group changed.
DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_update ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_sync_group_dependents_update
  AFTER UPDATE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebook_columns_sync_group_dependents();

DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_delete ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_sync_group_dependents_delete
  AFTER DELETE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebook_columns_sync_group_dependents();

-- Same as 20260920120100, plus the refusal to delete a group an expression names.
CREATE OR REPLACE FUNCTION public.gradebook_column_group_delete(p_group_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.gradebook_column_groups;
  v_default_id bigint;
  v_base integer;
BEGIN
  SELECT * INTO v_group FROM public.gradebook_column_groups WHERE id = p_group_id;
  IF v_group.id IS NULL THEN
    RAISE EXCEPTION 'gradebook column group % not found', p_group_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_group.class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_group.class_id;
  END IF;

  IF v_group.is_default THEN
    RAISE EXCEPTION 'the default group cannot be deleted; it is where columns go when nothing else claims them';
  END IF;

  PERFORM public._gradebook_column_group_assert_unreferenced(p_group_id, 'delete');

  PERFORM pg_advisory_xact_lock(v_group.gradebook_id);

  SELECT id INTO v_default_id
    FROM public.gradebook_column_groups
   WHERE gradebook_id = v_group.gradebook_id AND is_default;

  SELECT COALESCE(MAX(position_in_group), -1) + 1 INTO v_base
    FROM public.gradebook_columns WHERE gradebook_column_group_id = v_default_id;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_group.gradebook_id::text, 'true', true);
  BEGIN
    UPDATE public.gradebook_columns gc
       SET gradebook_column_group_id = v_default_id,
           position_in_group = v_base + sub.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position_in_group, id) - 1 AS rn
          FROM public.gradebook_columns
         WHERE gradebook_column_group_id = p_group_id
      ) sub
     WHERE gc.id = sub.id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_group.gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_group.gradebook_id::text, 'false', true);

  DELETE FROM public.gradebook_column_groups WHERE id = p_group_id;

  UPDATE public.gradebook_column_groups g
     SET sort_order = sub.pos
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1 AS pos
        FROM public.gradebook_column_groups
       WHERE gradebook_id = v_group.gradebook_id AND NOT is_default
    ) sub
   WHERE g.id = sub.id AND g.sort_order IS DISTINCT FROM sub.pos;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_column_group_delete(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gradebook_column_group_delete(bigint) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
