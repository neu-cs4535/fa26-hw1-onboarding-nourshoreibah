CREATE OR REPLACE FUNCTION public.gradebook_column_group_for_slug(
  p_gradebook_id bigint, p_class_id bigint, p_slug text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_id   bigint;
BEGIN
  v_base := public.gradebook_column_base_group_name(p_slug);

  SELECT g.id INTO v_id
    FROM public.gradebook_column_groups g
   WHERE g.gradebook_id = p_gradebook_id
     AND g.auto_assign_slug_base = v_base
   ORDER BY g.sort_order DESC, g.id DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.gradebook_column_groups
         (class_id, gradebook_id, name, slug, sort_order, auto_assign_slug_base)
  VALUES (p_class_id, p_gradebook_id,
          public.gradebook_column_group_display_name(v_base),
          v_base,
          COALESCE((SELECT MAX(sort_order) + 1
                      FROM public.gradebook_column_groups
                     WHERE gradebook_id = p_gradebook_id AND NOT is_default), 0),
          v_base)
  ON CONFLICT (gradebook_id, slug) DO UPDATE SET slug = EXCLUDED.slug
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION public.gradebook_column_group_for_slug(bigint, bigint, text) IS
  'Picks the group a newly created column belongs to, by the slug base the group advertises in auto_assign_slug_base.';

REVOKE ALL ON FUNCTION public.gradebook_column_group_for_slug(bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gradebook_column_group_for_slug(bigint, bigint, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.gradebook_columns_assign_default_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.gradebook_column_group_id IS NULL THEN
    NEW.gradebook_column_group_id :=
      public.gradebook_column_group_for_slug(NEW.gradebook_id, NEW.class_id, NEW.slug);
  END IF;
  RETURN NEW;
END $$;

-- Must sort before gradebook_columns_enforce_sort_order_tr: Postgres fires BEFORE ROW triggers in name order.
DROP TRIGGER IF EXISTS gradebook_columns_assign_default_group_tr ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_assign_default_group_tr
  BEFORE INSERT ON public.gradebook_columns
  FOR EACH ROW EXECUTE FUNCTION public.gradebook_columns_assign_default_group();

CREATE OR REPLACE FUNCTION public.gradebook_columns_enforce_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Avoid re-entrant work when our own UPDATEs fire the trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF current_setting('pawtograder.bypass_sort_order_trigger_' || NEW.gradebook_id::text, true) = 'true' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(NEW.gradebook_id);

  IF NEW.position_in_group IS NULL OR NEW.position_in_group < 0 THEN
    SELECT COALESCE(MAX(position_in_group), -1) + 1
      INTO NEW.position_in_group
      FROM public.gradebook_columns
     WHERE gradebook_column_group_id = NEW.gradebook_column_group_id
       AND id <> NEW.id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE public.gradebook_columns
       SET position_in_group = position_in_group + 1
     WHERE gradebook_column_group_id = NEW.gradebook_column_group_id
       AND position_in_group >= NEW.position_in_group
       AND id <> NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.gradebook_column_group_id IS DISTINCT FROM OLD.gradebook_column_group_id THEN
      UPDATE public.gradebook_columns
         SET position_in_group = position_in_group - 1
       WHERE gradebook_column_group_id = OLD.gradebook_column_group_id
         AND position_in_group > OLD.position_in_group
         AND id <> NEW.id;

      UPDATE public.gradebook_columns
         SET position_in_group = position_in_group + 1
       WHERE gradebook_column_group_id = NEW.gradebook_column_group_id
         AND position_in_group >= NEW.position_in_group
         AND id <> NEW.id;

    ELSIF NEW.position_in_group IS DISTINCT FROM OLD.position_in_group THEN
      UPDATE public.gradebook_columns
         SET position_in_group = position_in_group + 1
       WHERE gradebook_column_group_id = NEW.gradebook_column_group_id
         AND position_in_group >= NEW.position_in_group
         AND id <> NEW.id;

      UPDATE public.gradebook_columns
         SET position_in_group = position_in_group - 1
       WHERE gradebook_column_group_id = NEW.gradebook_column_group_id
         AND position_in_group > OLD.position_in_group
         AND id <> NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gradebook_columns_enforce_sort_order_tr ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_enforce_sort_order_tr
BEFORE INSERT OR UPDATE OF position_in_group, gradebook_id, gradebook_column_group_id
ON public.gradebook_columns
FOR EACH ROW
EXECUTE FUNCTION public.gradebook_columns_enforce_sort_order();

CREATE OR REPLACE FUNCTION public.gradebooks_create_default_column_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.gradebook_column_groups
         (class_id, gradebook_id, name, slug, sort_order, is_default)
  VALUES (NEW.class_id, NEW.id, 'Ungrouped', 'ungrouped', 2147483647, true)
  ON CONFLICT (gradebook_id, slug) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gradebooks_create_default_column_group_tr ON public.gradebooks;
CREATE TRIGGER gradebooks_create_default_column_group_tr
  AFTER INSERT ON public.gradebooks
  FOR EACH ROW EXECUTE FUNCTION public.gradebooks_create_default_column_group();

CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_gradebook_id bigint;
    v_group_id bigint;
    v_position integer;
    new_col_id bigint;
BEGIN
    SELECT g.id INTO v_gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id
    ORDER BY g.id
    LIMIT 1;

    IF v_gradebook_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(v_gradebook_id);

    v_group_id := public.gradebook_column_group_for_slug(
                    v_gradebook_id, NEW.class_id, 'assignment-' || NEW.slug);

    SELECT COALESCE(MAX(position_in_group), -1) + 1 INTO v_position
      FROM public.gradebook_columns
     WHERE gradebook_column_group_id = v_group_id;

    INSERT INTO public.gradebook_columns (
        name, max_score, slug, class_id, gradebook_id,
        score_expression, released, dependencies,
        gradebook_column_group_id, position_in_group
    ) VALUES (
        NEW.title,
        NEW.total_points,
        'assignment-' || NEW.slug,
        NEW.class_id,
        v_gradebook_id,
        'assignments("' || NEW.slug || '")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.id)),
        v_group_id,
        v_position
    ) RETURNING id INTO new_col_id;

    UPDATE public.assignments
    SET gradebook_column_id = new_col_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$function$;

ALTER TABLE public.gradebooks
  ADD COLUMN IF NOT EXISTS column_layout_version bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.gradebooks_bump_layout_version_new()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.gradebooks g SET column_layout_version = g.column_layout_version + 1
   WHERE g.id IN (SELECT gradebook_id FROM new_table);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.gradebooks_bump_layout_version_old()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.gradebooks g SET column_layout_version = g.column_layout_version + 1
   WHERE g.id IN (SELECT gradebook_id FROM old_table);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.gradebooks_bump_layout_version_if_moved()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.gradebooks g SET column_layout_version = g.column_layout_version + 1
   WHERE g.id IN (
     SELECT n.gradebook_id
       FROM new_table n
       JOIN old_table o ON o.id = n.id
      WHERE n.position_in_group IS DISTINCT FROM o.position_in_group
         OR n.gradebook_column_group_id IS DISTINCT FROM o.gradebook_column_group_id
   );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_insert ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_bump_layout_insert
  AFTER INSERT ON public.gradebook_columns
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_new();

DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_update ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_bump_layout_update
  AFTER UPDATE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_if_moved();

DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_delete ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_bump_layout_delete
  AFTER DELETE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_old();

DROP TRIGGER IF EXISTS gradebook_column_groups_bump_layout_insert ON public.gradebook_column_groups;
CREATE TRIGGER gradebook_column_groups_bump_layout_insert
  AFTER INSERT ON public.gradebook_column_groups
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_new();

DROP TRIGGER IF EXISTS gradebook_column_groups_bump_layout_update ON public.gradebook_column_groups;
CREATE TRIGGER gradebook_column_groups_bump_layout_update
  AFTER UPDATE ON public.gradebook_column_groups
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_new();

DROP TRIGGER IF EXISTS gradebook_column_groups_bump_layout_delete ON public.gradebook_column_groups;
CREATE TRIGGER gradebook_column_groups_bump_layout_delete
  AFTER DELETE ON public.gradebook_column_groups
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.gradebooks_bump_layout_version_old();

CREATE OR REPLACE FUNCTION public._gradebook_columns_apply_positions(
  p_gradebook_id bigint, p_group_id bigint, p_ordered_column_ids bigint[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'true', true);
  BEGIN
    UPDATE public.gradebook_columns gc
       SET position_in_group = t.ordinality - 1
      FROM unnest(p_ordered_column_ids) WITH ORDINALITY AS t(id, ordinality)
     WHERE gc.id = t.id
       AND gc.gradebook_column_group_id = p_group_id
       AND gc.position_in_group IS DISTINCT FROM t.ordinality - 1;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
END $$;

REVOKE ALL ON FUNCTION public._gradebook_columns_apply_positions(bigint, bigint, bigint[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.gradebook_column_move_left(p_column_id bigint)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_neighbor_pos integer;
  v_group_order integer;
  v_prev_group_id bigint;
  v_prev_group_order integer;
BEGIN
  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id FOR UPDATE;
  IF v_col.id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_col.gradebook_id);

  SELECT id, position_in_group INTO v_neighbor_id, v_neighbor_pos
    FROM public.gradebook_columns
   WHERE gradebook_column_group_id = v_col.gradebook_column_group_id
     AND position_in_group < v_col.position_in_group
   ORDER BY position_in_group DESC
   LIMIT 1;

  IF v_neighbor_id IS NOT NULL THEN
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'true', true);
    BEGIN
      UPDATE public.gradebook_columns SET position_in_group = v_col.position_in_group
       WHERE id = v_neighbor_id;
      UPDATE public.gradebook_columns SET position_in_group = v_neighbor_pos
       WHERE id = p_column_id;
    EXCEPTION
      WHEN OTHERS THEN
        PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'false', true);
        RAISE;
    END;
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'false', true);
  ELSE
    SELECT sort_order INTO v_group_order
      FROM public.gradebook_column_groups WHERE id = v_col.gradebook_column_group_id;

    SELECT id, sort_order INTO v_prev_group_id, v_prev_group_order
      FROM public.gradebook_column_groups
     WHERE gradebook_id = v_col.gradebook_id
       AND NOT is_default
       AND sort_order < v_group_order
     ORDER BY sort_order DESC
     LIMIT 1;

    IF v_prev_group_id IS NOT NULL THEN
      UPDATE public.gradebook_column_groups SET sort_order = v_group_order WHERE id = v_prev_group_id;
      UPDATE public.gradebook_column_groups SET sort_order = v_prev_group_order
       WHERE id = v_col.gradebook_column_group_id;
    END IF;
  END IF;

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$$;

CREATE OR REPLACE FUNCTION public.gradebook_column_move_right(p_column_id bigint)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_neighbor_pos integer;
  v_group_order integer;
  v_next_group_id bigint;
  v_next_group_order integer;
BEGIN
  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id FOR UPDATE;
  IF v_col.id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_col.gradebook_id);

  SELECT id, position_in_group INTO v_neighbor_id, v_neighbor_pos
    FROM public.gradebook_columns
   WHERE gradebook_column_group_id = v_col.gradebook_column_group_id
     AND position_in_group > v_col.position_in_group
   ORDER BY position_in_group ASC
   LIMIT 1;

  IF v_neighbor_id IS NOT NULL THEN
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'true', true);
    BEGIN
      UPDATE public.gradebook_columns SET position_in_group = v_col.position_in_group
       WHERE id = v_neighbor_id;
      UPDATE public.gradebook_columns SET position_in_group = v_neighbor_pos
       WHERE id = p_column_id;
    EXCEPTION
      WHEN OTHERS THEN
        PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'false', true);
        RAISE;
    END;
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_col.gradebook_id::text, 'false', true);
  ELSE
    SELECT sort_order INTO v_group_order
      FROM public.gradebook_column_groups WHERE id = v_col.gradebook_column_group_id;

    SELECT id, sort_order INTO v_next_group_id, v_next_group_order
      FROM public.gradebook_column_groups
     WHERE gradebook_id = v_col.gradebook_id
       AND NOT is_default
       AND sort_order > v_group_order
     ORDER BY sort_order ASC
     LIMIT 1;

    IF v_next_group_id IS NOT NULL THEN
      UPDATE public.gradebook_column_groups SET sort_order = v_group_order WHERE id = v_next_group_id;
      UPDATE public.gradebook_column_groups SET sort_order = v_next_group_order
       WHERE id = v_col.gradebook_column_group_id;
    END IF;
  END IF;

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$$;

CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'gradebook_columns_reorder no longer describes a gradebook layout'
    USING HINT = 'Column order is now two levels. Use gradebook_columns_reorder_in_group(group_id, ordered_ids, expected_version) to order columns inside a group, and gradebook_column_groups_reorder(gradebook_id, ordered_group_ids, expected_version) to order the groups.',
          ERRCODE = 'feature_not_supported';
END $$;

CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder_in_group(
  p_group_id bigint, p_ordered_column_ids bigint[], p_expected_version bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gradebook_id bigint;
  v_class_id bigint;
  v_version bigint;
  v_member_count integer;
  v_given_count integer;
BEGIN
  SELECT gradebook_id, class_id INTO v_gradebook_id, v_class_id
    FROM public.gradebook_column_groups WHERE id = p_group_id;
  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column group % not found', p_group_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  SELECT column_layout_version INTO v_version
    FROM public.gradebooks WHERE id = v_gradebook_id FOR UPDATE;
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'gradebook layout changed underneath this reorder (expected %, found %)',
      p_expected_version, v_version
      USING ERRCODE = '40001';
  END IF;

  SELECT count(*) INTO v_member_count
    FROM public.gradebook_columns WHERE gradebook_column_group_id = p_group_id;

  SELECT count(*) INTO v_given_count
    FROM (SELECT DISTINCT unnest(p_ordered_column_ids)) t;

  IF v_given_count <> array_length(p_ordered_column_ids, 1) THEN
    RAISE EXCEPTION 'reorder list contains duplicate column ids';
  END IF;
  IF v_given_count <> v_member_count THEN
    RAISE EXCEPTION 'reorder list has % columns but group % has %',
      v_given_count, p_group_id, v_member_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_ordered_column_ids) AS t(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.gradebook_columns gc
                        WHERE gc.id = t.id AND gc.gradebook_column_group_id = p_group_id)
  ) THEN
    RAISE EXCEPTION 'reorder list names a column that is not in group %', p_group_id;
  END IF;

  PERFORM public._gradebook_columns_apply_positions(v_gradebook_id, p_group_id, p_ordered_column_ids);

  SELECT column_layout_version INTO v_version FROM public.gradebooks WHERE id = v_gradebook_id;
  RETURN v_version;
END $$;

CREATE OR REPLACE FUNCTION public.gradebook_column_groups_reorder(
  p_gradebook_id bigint, p_ordered_group_ids bigint[], p_expected_version bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class_id bigint;
  v_version bigint;
  v_group_count integer;
  v_given_count integer;
BEGIN
  SELECT class_id INTO v_class_id FROM public.gradebooks WHERE id = p_gradebook_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', p_gradebook_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  PERFORM pg_advisory_xact_lock(p_gradebook_id);

  SELECT column_layout_version INTO v_version
    FROM public.gradebooks WHERE id = p_gradebook_id FOR UPDATE;
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'gradebook layout changed underneath this reorder (expected %, found %)',
      p_expected_version, v_version
      USING ERRCODE = '40001';
  END IF;

  SELECT count(*) INTO v_group_count
    FROM public.gradebook_column_groups WHERE gradebook_id = p_gradebook_id AND NOT is_default;
  SELECT count(*) INTO v_given_count
    FROM (SELECT DISTINCT unnest(p_ordered_group_ids)) t;

  IF v_given_count <> COALESCE(array_length(p_ordered_group_ids, 1), 0) THEN
    RAISE EXCEPTION 'reorder list contains duplicate group ids';
  END IF;
  IF v_given_count <> v_group_count THEN
    RAISE EXCEPTION 'reorder list has % groups but gradebook % has %',
      v_given_count, p_gradebook_id, v_group_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_ordered_group_ids) AS t(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.gradebook_column_groups g
                        WHERE g.id = t.id AND g.gradebook_id = p_gradebook_id AND NOT g.is_default)
  ) THEN
    RAISE EXCEPTION 'reorder list names a group that is not in gradebook %', p_gradebook_id;
  END IF;

  UPDATE public.gradebook_column_groups g
     SET sort_order = t.ordinality - 1
    FROM unnest(p_ordered_group_ids) WITH ORDINALITY AS t(id, ordinality)
   WHERE g.id = t.id;

  UPDATE public.gradebook_column_groups
     SET sort_order = COALESCE(array_length(p_ordered_group_ids, 1), 0)
   WHERE gradebook_id = p_gradebook_id AND is_default;

  SELECT column_layout_version INTO v_version FROM public.gradebooks WHERE id = p_gradebook_id;
  RETURN v_version;
END $$;

CREATE OR REPLACE FUNCTION public.gradebook_column_assign_group(
  p_column_id bigint, p_group_id bigint, p_position integer DEFAULT NULL)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_col public.gradebook_columns;
  v_group public.gradebook_column_groups;
BEGIN
  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id FOR UPDATE;
  IF v_col.id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  SELECT * INTO v_group FROM public.gradebook_column_groups WHERE id = p_group_id;
  IF v_group.id IS NULL THEN
    RAISE EXCEPTION 'gradebook column group % not found', p_group_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_col.class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_col.class_id;
  END IF;

  IF v_group.gradebook_id <> v_col.gradebook_id THEN
    RAISE EXCEPTION 'group % belongs to a different gradebook than column %', p_group_id, p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_col.gradebook_id);

  UPDATE public.gradebook_columns
     SET gradebook_column_group_id = p_group_id,
         position_in_group = COALESCE(
           p_position,
           (SELECT COALESCE(MAX(position_in_group), -1) + 1
              FROM public.gradebook_columns
             WHERE gradebook_column_group_id = p_group_id AND id <> p_column_id))
   WHERE id = p_column_id;

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END $$;

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
      SELECT id, ROW_NUMBER() OVER (ORDER BY is_default, sort_order, id) - 1 AS pos
        FROM public.gradebook_column_groups
       WHERE gradebook_id = v_group.gradebook_id
    ) sub
   WHERE g.id = sub.id AND g.sort_order IS DISTINCT FROM sub.pos;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_columns_reorder_in_group(bigint, bigint[], bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gradebook_column_groups_reorder(bigint, bigint[], bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gradebook_column_assign_group(bigint, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gradebook_column_group_delete(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.gradebook_columns_reorder_in_group(bigint, bigint[], bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gradebook_column_groups_reorder(bigint, bigint[], bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gradebook_column_assign_group(bigint, bigint, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gradebook_column_group_delete(bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_gradebook_records_for_all_students(p_class_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    IF NOT public.authorizeforclassgrader(p_class_id) THEN
        RETURN '[]'::jsonb;
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(student_data ORDER BY student_id), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_build_object(
                    'private_profile_id', gcs.student_id::text,
                    'entries', jsonb_agg(
                        jsonb_build_object(
                            'gcs_id', gcs.id,
                            'gc_id', gcs.gradebook_column_id,
                            'is_private', gcs.is_private,
                            'score', gcs.score,
                            'score_override', gcs.score_override,
                            'is_missing', gcs.is_missing,
                            'is_excused', gcs.is_excused,
                            'is_droppable', gcs.is_droppable,
                            'released', gcs.released,
                            'score_override_note', gcs.score_override_note,
                            'is_recalculating', gcs.is_recalculating,
                            'incomplete_values', gcs.incomplete_values,
                            'updated_at', to_jsonb(gcs.updated_at)
                        ) ORDER BY gcg.sort_order ASC, gc.position_in_group ASC, gc.id ASC
                    )
                ) as student_data
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            INNER JOIN public.gradebook_column_groups gcg ON gcg.id = gc.gradebook_column_group_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) grouped_data
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_gradebook_records_for_all_students_array(p_class_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    -- Early authorization guard - return immediately if unauthorized
    IF NOT public.authorizeforclassgrader(p_class_id) THEN
        RETURN '[]'::jsonb;
    END IF;
    
    -- Only execute heavy query if authorized
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'private_profile_id', student_id::text,
                'entries', entries_array
            ) ORDER BY student_id
        ), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_agg(
                    ARRAY[
                        gcs.id::text,
                        gcs.gradebook_column_id::text, 
                        gcs.is_private::text,
                        COALESCE(gcs.score::text, ''),
                        COALESCE(gcs.score_override::text, ''),
                        gcs.is_missing::text,
                        gcs.is_excused::text,
                        gcs.is_droppable::text,
                        gcs.released::text,
                        COALESCE(gcs.score_override_note, ''),
                        gcs.is_recalculating::text,
                        COALESCE(gcs.incomplete_values::text, '')
                    ] ORDER BY gcg.sort_order ASC, gc.position_in_group ASC, gc.id ASC
                ) as entries_array
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            INNER JOIN public.gradebook_column_groups gcg ON gcg.id = gc.gradebook_column_group_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) array_data
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gradebook_auto_layout(p_gradebook_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class_id bigint;
  v_placed bigint[] := '{}';
  v_next bigint[];
  v_rank integer := 0;
  v_remaining integer;
BEGIN
  SELECT class_id INTO v_class_id FROM public.gradebooks WHERE id = p_gradebook_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', p_gradebook_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  PERFORM pg_advisory_xact_lock(p_gradebook_id);
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'true', true);

  BEGIN
    WITH ordered_cols AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY gradebook_column_group_id
               ORDER BY regexp_replace(slug, '\d+', '', 'g'),
                        COALESCE((regexp_match(slug, '\d+'))[1]::integer, 0),
                        slug
             ) - 1 AS pos
        FROM public.gradebook_columns
       WHERE gradebook_id = p_gradebook_id
    )
    UPDATE public.gradebook_columns gc
       SET position_in_group = oc.pos
      FROM ordered_cols oc
     WHERE gc.id = oc.id
       AND gc.position_in_group IS DISTINCT FROM oc.pos;

    DROP TABLE IF EXISTS _al_edges;
    DROP TABLE IF EXISTS _al_rank;

    CREATE TEMP TABLE _al_edges ON COMMIT DROP AS
    SELECT DISTINCT dep.gradebook_column_group_id AS from_group,
                    gc.gradebook_column_group_id  AS to_group
      FROM public.gradebook_columns gc
      CROSS JOIN LATERAL jsonb_array_elements_text(
                   COALESCE(gc.dependencies -> 'gradebook_columns', '[]'::jsonb)) AS d(dep_id)
      JOIN public.gradebook_columns dep ON dep.id = d.dep_id::bigint
     WHERE gc.gradebook_id = p_gradebook_id
       AND dep.gradebook_id = p_gradebook_id
       AND dep.gradebook_column_group_id <> gc.gradebook_column_group_id;

    CREATE TEMP TABLE _al_rank (group_id bigint PRIMARY KEY, rank integer NOT NULL) ON COMMIT DROP;

    LOOP
      SELECT array_agg(g.id ORDER BY g.is_default, g.sort_order, g.id) INTO v_next
        FROM public.gradebook_column_groups g
       WHERE g.gradebook_id = p_gradebook_id
         AND NOT (g.id = ANY (v_placed))
         AND NOT EXISTS (
           SELECT 1 FROM _al_edges e
            WHERE e.to_group = g.id
              AND NOT (e.from_group = ANY (v_placed))
         );

      EXIT WHEN v_next IS NULL OR array_length(v_next, 1) = 0;

      INSERT INTO _al_rank (group_id, rank)
      SELECT t.id, v_rank + (t.ordinality - 1)::integer
        FROM unnest(v_next) WITH ORDINALITY AS t(id, ordinality);

      v_rank   := v_rank + array_length(v_next, 1);
      v_placed := v_placed || v_next;
    END LOOP;

    SELECT count(*) INTO v_remaining
      FROM public.gradebook_column_groups g
     WHERE g.gradebook_id = p_gradebook_id AND NOT (g.id = ANY (v_placed));

    IF v_remaining > 0 THEN
      RAISE WARNING 'Circular dependency between column groups in gradebook %. Leaving % group(s) where they were.',
        p_gradebook_id, v_remaining;
      INSERT INTO _al_rank (group_id, rank)
      SELECT g.id, v_rank + ROW_NUMBER() OVER (ORDER BY g.sort_order, g.id)
        FROM public.gradebook_column_groups g
       WHERE g.gradebook_id = p_gradebook_id AND NOT (g.id = ANY (v_placed));
    END IF;

    UPDATE public.gradebook_column_groups g
       SET sort_order = sub.pos
      FROM (
        SELECT r.group_id,
               ROW_NUMBER() OVER (ORDER BY gg.is_default, r.rank, r.group_id) - 1 AS pos
          FROM _al_rank r
          JOIN public.gradebook_column_groups gg ON gg.id = r.group_id
      ) sub
     WHERE g.id = sub.group_id
       AND g.sort_order IS DISTINCT FROM sub.pos;

  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
      RAISE;
  END;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
