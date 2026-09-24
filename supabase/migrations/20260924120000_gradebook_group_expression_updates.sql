-- Keep group expressions consistent after an instructor edits a member or its position.
-- The previous migration handled moves between groups but missed changes to a member's
-- eligibility. A total excludes other totals of the same group.
--
-- Treat a regular member becoming a total as leaving, and the reverse as joining.
-- A position change keeps the same inputs but enqueues recalculation because an expression
-- can select a member by index. Updates to the expanded column ids leave eligibility and
-- position unchanged, so nested dependency updates return without repeating this work.

CREATE OR REPLACE FUNCTION public.gradebook_columns_sync_group_dependents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changes jsonb;
  v_new_edges jsonb;
  v_cycle record;
  v_rows jsonb[];
  v_cleaned_gradebooks bigint[];
  v_gradebook_id bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', n.id, 'gradebook_id', n.gradebook_id,
             'joined_group_id', n.gradebook_column_group_id, 'left_group_id', NULL,
             'slug', n.slug, 'old_slug', n.slug,
             'column_groups', n.dependencies -> 'gradebook_column_groups',
             'old_column_groups', n.dependencies -> 'gradebook_column_groups'))
      INTO v_changes
      FROM new_table n;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', n.id, 'gradebook_id', n.gradebook_id,
             'joined_group_id', CASE
               WHEN NOT COALESCE(n.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
                          @> jsonb_build_array(n.gradebook_column_group_id)
               THEN n.gradebook_column_group_id END,
             'left_group_id', CASE
               WHEN NOT COALESCE(o.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
                          @> jsonb_build_array(o.gradebook_column_group_id)
               THEN o.gradebook_column_group_id END,
             'slug', n.slug, 'old_slug', o.slug,
             'column_groups', n.dependencies -> 'gradebook_column_groups',
             'old_column_groups', o.dependencies -> 'gradebook_column_groups'))
      INTO v_changes
      FROM new_table n
      JOIN old_table o ON o.id = n.id
     WHERE n.gradebook_column_group_id IS DISTINCT FROM o.gradebook_column_group_id
        OR (COALESCE(n.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
              @> jsonb_build_array(n.gradebook_column_group_id)) IS DISTINCT FROM
           (COALESCE(o.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
              @> jsonb_build_array(o.gradebook_column_group_id))
        OR (n.position_in_group IS DISTINCT FROM o.position_in_group
            AND NOT COALESCE(n.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
                      @> jsonb_build_array(n.gradebook_column_group_id));
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
             'column_id', o.id, 'gradebook_id', o.gradebook_id,
             'joined_group_id', NULL, 'left_group_id', o.gradebook_column_group_id,
             'slug', o.slug, 'old_slug', o.slug,
             'column_groups', o.dependencies -> 'gradebook_column_groups',
             'old_column_groups', o.dependencies -> 'gradebook_column_groups'))
      INTO v_changes
      FROM old_table o;
  END IF;

  IF v_changes IS NULL THEN
    RETURN NULL;
  END IF;

  -- Leave: drop the id from dependents it no longer counts for.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    WITH leaving AS (
      SELECT c.*
        FROM jsonb_to_recordset(v_changes)
               AS c(column_id bigint, gradebook_id bigint, joined_group_id bigint, left_group_id bigint,
                    slug text, old_slug text, column_groups jsonb)
       WHERE c.left_group_id IS NOT NULL
    ),
    removals AS (
      SELECT d.id, array_agg(DISTINCT l.column_id::text) AS ids
        FROM leaving l
        JOIN public.gradebook_columns d
          ON d.gradebook_id = l.gradebook_id
         AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(l.left_group_id)
         AND d.dependencies -> 'gradebook_columns' @> jsonb_build_array(l.column_id)
       WHERE d.id <> l.column_id
         AND NOT (l.joined_group_id IS NOT NULL
                  AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(l.joined_group_id)
                  AND NOT COALESCE(l.column_groups, '[]'::jsonb) @> jsonb_build_array(l.joined_group_id))
         AND NOT public._gradebook_expression_names_slug(d.score_expression, l.slug)
         AND NOT public._gradebook_expression_names_slug(d.score_expression, l.old_slug)
       GROUP BY d.id
    )
    UPDATE public.gradebook_columns d
       SET dependencies = jsonb_set(
             d.dependencies,
             '{gradebook_columns}',
             COALESCE((SELECT jsonb_agg(e.value ORDER BY e.ord)
                         FROM jsonb_array_elements(d.dependencies -> 'gradebook_columns')
                                WITH ORDINALITY AS e(value, ord)
                        WHERE NOT ((e.value #>> '{}') = ANY (r.ids))),
                      '[]'::jsonb))
      FROM removals r
     WHERE d.id = r.id;
  END IF;

  -- Join: append the id to dependents it now counts for.
  WITH joins AS (
    SELECT d2.id AS dependent_id, c.column_id
      FROM jsonb_to_recordset(v_changes)
             AS c(column_id bigint, gradebook_id bigint, joined_group_id bigint, column_groups jsonb)
      JOIN public.gradebook_columns d2
        ON d2.gradebook_id = c.gradebook_id
       AND d2.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(c.joined_group_id)
     WHERE c.joined_group_id IS NOT NULL
       AND d2.id <> c.column_id
       AND NOT COALESCE(c.column_groups, '[]'::jsonb) @> jsonb_build_array(c.joined_group_id)
       AND NOT COALESCE(d2.dependencies -> 'gradebook_columns', '[]'::jsonb) @> jsonb_build_array(c.column_id)
  ),
  additions AS (
    SELECT j.dependent_id, array_agg(DISTINCT j.column_id ORDER BY j.column_id) AS ids
      FROM joins j
     GROUP BY j.dependent_id
  ),
  upd AS (
    UPDATE public.gradebook_columns d
       SET dependencies = jsonb_set(
             COALESCE(d.dependencies, '{}'::jsonb),
             '{gradebook_columns}',
             COALESCE(d.dependencies -> 'gradebook_columns', '[]'::jsonb) || to_jsonb(a.ids))
      FROM additions a
     WHERE d.id = a.dependent_id
    RETURNING d.id
  )
  SELECT jsonb_agg(jsonb_build_object('dependent_id', a.dependent_id, 'column_id', x.column_id))
    INTO v_new_edges
    FROM additions a
    JOIN upd u ON u.id = a.dependent_id
    CROSS JOIN LATERAL unnest(a.ids) AS x(column_id);

  -- A new edge dependent -> joiner closes a cycle when the joiner, over the edges as they
  -- stand after the edits above, already reaches the dependent.
  IF v_new_edges IS NOT NULL THEN
    WITH RECURSIVE reach(dependent_id, column_id, reached_id) AS (
      SELECT e.dependent_id, e.column_id, e.column_id
        FROM jsonb_to_recordset(v_new_edges) AS e(dependent_id bigint, column_id bigint)
      UNION
      SELECT r.dependent_id, r.column_id, dep.value::numeric::bigint
        FROM reach r
        JOIN public.gradebook_columns gc ON gc.id = r.reached_id
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(gc.dependencies -> 'gradebook_columns') = 'array'
               THEN gc.dependencies -> 'gradebook_columns' ELSE '[]'::jsonb END) AS dep(value)
       WHERE r.reached_id <> r.dependent_id
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
  END IF;

  -- Leave: delete routed groups left empty and unreferenced, then close the gap in sort_order
  -- the way gradebook_column_group_delete does.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    FOR v_gradebook_id IN
      SELECT DISTINCT c.gradebook_id
        FROM jsonb_to_recordset(v_changes) AS c(gradebook_id bigint, left_group_id bigint)
       WHERE c.left_group_id IS NOT NULL
       ORDER BY c.gradebook_id
    LOOP
      PERFORM pg_advisory_xact_lock(v_gradebook_id);
    END LOOP;

    WITH gone AS (
      DELETE FROM public.gradebook_column_groups g
       WHERE g.id IN (
               SELECT c.left_group_id
                 FROM jsonb_to_recordset(v_changes) AS c(left_group_id bigint)
                WHERE c.left_group_id IS NOT NULL)
         AND NOT g.is_default
         AND g.auto_assign_slug_base IS NOT NULL
         AND g.name = ANY (public.gradebook_column_group_generated_names(g.auto_assign_slug_base))
         AND EXISTS (SELECT 1 FROM public.gradebooks gb WHERE gb.id = g.gradebook_id)
         AND NOT EXISTS (SELECT 1 FROM public.gradebook_columns m WHERE m.gradebook_column_group_id = g.id)
         AND NOT EXISTS (
               SELECT 1 FROM public.gradebook_columns d
                WHERE d.gradebook_id = g.gradebook_id
                  AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(g.id))
      RETURNING g.gradebook_id
    )
    SELECT array_agg(DISTINCT gone.gradebook_id) INTO v_cleaned_gradebooks FROM gone;

    IF v_cleaned_gradebooks IS NOT NULL THEN
      UPDATE public.gradebook_column_groups g
         SET sort_order = sub.pos
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY gradebook_id ORDER BY sort_order, id) - 1 AS pos
            FROM public.gradebook_column_groups
           WHERE gradebook_id = ANY (v_cleaned_gradebooks) AND NOT is_default
        ) sub
       WHERE g.id = sub.id AND g.sort_order IS DISTINCT FROM sub.pos;
    END IF;
  END IF;

  SELECT array_agg(jsonb_build_object(
           'class_id', r.class_id,
           'gradebook_id', r.gradebook_id,
           'student_id', r.student_id,
           'is_private', r.is_private,
           'source', 'gradebook_column_group_membership'))
    INTO v_rows
    FROM (
      SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
        FROM (
          SELECT c.column_id, c.gradebook_id, g.group_id
            FROM jsonb_to_recordset(v_changes)
                   AS c(column_id bigint, gradebook_id bigint, joined_group_id bigint, left_group_id bigint,
                        column_groups jsonb, old_column_groups jsonb)
            CROSS JOIN LATERAL (VALUES (c.joined_group_id, c.column_groups),
                                       (c.left_group_id, c.old_column_groups)) AS g(group_id, groups_of_column)
           WHERE g.group_id IS NOT NULL
             AND NOT COALESCE(g.groups_of_column, '[]'::jsonb) @> jsonb_build_array(g.group_id)
        ) affected
        JOIN public.gradebook_columns d
          ON d.gradebook_id = affected.gradebook_id
         AND d.dependencies -> 'gradebook_column_groups' @> jsonb_build_array(affected.group_id)
        JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = d.id
       WHERE d.score_expression IS NOT NULL
         AND d.id <> affected.column_id
    ) r;

  IF array_length(v_rows, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(v_rows);
  END IF;

  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_columns_sync_group_dependents() FROM PUBLIC, anon, authenticated;
