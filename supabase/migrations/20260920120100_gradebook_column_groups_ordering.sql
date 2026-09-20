-- Two-level column ordering: the routines.
--
-- 20260920120000 created gradebook_column_groups, backfilled it, and dropped
-- gradebook_columns.sort_order in favour of position_in_group. Everything that used to read or
-- write a single global sequence per gradebook has to be rewritten against the two levels. This
-- migration does that, and adds the routing that puts a newly created column into a group without
-- any caller having to know groups exist.
--
-- Where the old code was careful about something, the new code stays careful about it in the same
-- way: the per-gradebook advisory lock, the bypass GUC around bulk writes, and the
-- pg_trigger_depth() guard are all still here. One thing is deliberately tidied: auto-layout used
-- to take pg_advisory_xact_lock(17031, gradebook_id) while every other path took
-- pg_advisory_xact_lock(gradebook_id), so the two did not actually exclude each other. They all
-- use the one-argument form now.

-- ---------------------------------------------------------------------------------------------
-- 1. Routing a new column to a group
-- ---------------------------------------------------------------------------------------------

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

  -- Rightmost group that accepts this base. Rightmost rather than leftmost because a new column
  -- in a family belongs at the end of it, and because the backfill can legitimately leave more
  -- than one group carrying the same base when an instructor has since split one by hand.
  SELECT g.id INTO v_id
    FROM public.gradebook_column_groups g
   WHERE g.gradebook_id = p_gradebook_id
     AND g.auto_assign_slug_base = v_base
   ORDER BY g.sort_order DESC, g.id DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Nothing claims this base yet, so start a group for it, immediately left of the default group.
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

-- Callable from the app so that code creating a column can ask where it should go, rather than
-- reimplementing the routing rule in TypeScript. The rule lives in one place.
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

-- Deliberately has no pg_trigger_depth() guard. Columns inserted from inside another trigger,
-- which is how every assignment-backed column arrives, still need a group.
--
-- The name matters. Postgres fires BEFORE ROW triggers in name order, and this one has to run
-- before gradebook_columns_enforce_sort_order_tr, which reads the group to work out what the
-- next free position in it is. 'gradebook_columns_assign...' sorts before
-- 'gradebook_columns_enforce...' on the 'a' < 'e'. Renaming either one breaks the other.
DROP TRIGGER IF EXISTS gradebook_columns_assign_default_group_tr ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_assign_default_group_tr
  BEFORE INSERT ON public.gradebook_columns
  FOR EACH ROW EXECUTE FUNCTION public.gradebook_columns_assign_default_group();

-- ---------------------------------------------------------------------------------------------
-- 2. Position enforcement, scoped to the group
-- ---------------------------------------------------------------------------------------------
--
-- Same shape as the old gradebook_columns_enforce_sort_order, with every WHERE narrowed from
-- "this gradebook" to "this group". Appending to a group is now O(1) and disturbs nothing, which
-- is the main practical win of the two-level model: inserting a column in the middle of a
-- gradebook used to renumber every column to its right.

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

  -- Negative means "wherever, put it at the end", which is what the column's DEFAULT of -1
  -- produces when a caller omits the field. An explicit caller never passes a negative.
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
      -- Close the gap in the group it left.
      UPDATE public.gradebook_columns
         SET position_in_group = position_in_group - 1
       WHERE gradebook_column_group_id = OLD.gradebook_column_group_id
         AND position_in_group > OLD.position_in_group
         AND id <> NEW.id;

      -- Make room in the group it joined.
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

-- ---------------------------------------------------------------------------------------------
-- 3. Every gradebook gets a default group
-- ---------------------------------------------------------------------------------------------
--
-- A trigger on gradebooks rather than an edit to classes_populate_default_structures, so a
-- gradebook created by any other path gets one too. The FK on gradebook_columns is NOT NULL, so
-- a gradebook without this row is a gradebook you cannot add a column to.

CREATE OR REPLACE FUNCTION public.gradebooks_create_default_column_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Parked at the far right. Real groups are numbered from 0 upwards as they are created, so a
  -- default group sitting at 0 would collide with the first of them on the
  -- (gradebook_id, sort_order) unique. Reorder and delete both renumber it back into range.
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

-- ---------------------------------------------------------------------------------------------
-- 4. Assignment-backed columns
-- ---------------------------------------------------------------------------------------------
--
-- The old version computed MAX(sort_order) + 1 across the whole class and wrote it, because the
-- pg_trigger_depth() > 1 guard means the enforce trigger declines to do anything for a column
-- inserted from inside this trigger. Under two levels there is nothing to compute: appending to
-- a group needs no position arithmetic and disturbs no other row, so this just names the group
-- and lets the column land at the end of it.
--
-- create_gradebook_column_for_code_walk_rubric needs no change for the same reason: it never set
-- sort_order, and the routing trigger now gives it a group.

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

    -- Same lock namespace as every other ordering path, which the old class_id lock was not.
    PERFORM pg_advisory_xact_lock(v_gradebook_id);

    -- Resolve the group here rather than leaning on the BEFORE INSERT trigger, so that the
    -- position below is computed against the group the row will actually land in.
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

-- ---------------------------------------------------------------------------------------------
-- 5. Optimistic concurrency for layout changes
-- ---------------------------------------------------------------------------------------------
--
-- Two people reordering at once used to serialize on the advisory lock and then silently
-- last-writer-wins: the loser's permutation was computed against a snapshot taken before the
-- winner's write, and every check it passed was a check against stale data. With groups in the
-- picture that is worse than a lost drag, because a stale permutation can be internally valid and
-- still split a group the winner just created.
--
-- Statement-level so a 200-row reorder bumps the version once rather than 200 times.

ALTER TABLE public.gradebooks
  ADD COLUMN IF NOT EXISTS column_layout_version bigint NOT NULL DEFAULT 0;

-- Two functions rather than one, because a statement trigger can only reference the transition
-- tables its own definition declares: an INSERT trigger has no old_table to read.
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

-- Postgres refuses a column list on a trigger that declares transition tables, so this one fires
-- on any UPDATE and decides for itself whether the layout actually moved. Bumping on every column
-- edit would make an unrelated rename invalidate someone else's in-flight drag.
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


-- ---------------------------------------------------------------------------------------------
-- 6. One place that writes an order
-- ---------------------------------------------------------------------------------------------
--
-- The lock-and-bypass dance was copy-pasted into four functions, each with its own EXCEPTION
-- block to reset the GUC. It lives here once now.

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

-- ---------------------------------------------------------------------------------------------
-- 7. Move left / move right
-- ---------------------------------------------------------------------------------------------
--
-- The old version swapped with whatever column was visually adjacent, which is exactly the
-- operation that breaks groups: the leftmost column of one group moving left lands in the middle
-- of the group before it. Now a move inside a group swaps two positions, and a move off the edge
-- of a group moves the whole group past its neighbour. Neither ever writes
-- gradebook_column_group_id, so neither can change what a column belongs to.
--
-- Still SECURITY INVOKER, and still relying on the existing "instructors and graders edit"
-- UPDATE policy on gradebook_columns, so graders keep the nudge rights they have today.

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
    -- Already first in its group: move the group itself past the one before it.
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

-- ---------------------------------------------------------------------------------------------
-- 8. Reorder
-- ---------------------------------------------------------------------------------------------
--
-- The old gradebook_columns_reorder took one flat array of every column in the gradebook, which
-- under two levels cannot say anything about where the group boundaries fall. Rather than leave a
-- function that would accept such an array and quietly do something arbitrary with it, it now
-- raises and names its replacements.

CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'gradebook_columns_reorder no longer describes a gradebook layout'
    USING HINT = 'Column order is now two levels. Use gradebook_columns_reorder_in_group(group_id, ordered_ids, expected_version) to order columns inside a group, and gradebook_column_groups_reorder(gradebook_id, ordered_group_ids, expected_version) to order the groups.',
          ERRCODE = 'feature_not_supported';
END $$;

-- Order the columns inside one group. This cannot change what any column belongs to: it writes
-- position_in_group and nothing else, and it refuses an array that reaches outside the group.
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

-- Order the groups. One integer per group, rather than renumbering every column in the gradebook.
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

  -- The default group keeps to the right-hand end.
  UPDATE public.gradebook_column_groups
     SET sort_order = COALESCE(array_length(p_ordered_group_ids, 1), 0)
   WHERE gradebook_id = p_gradebook_id AND is_default;

  SELECT column_layout_version INTO v_version FROM public.gradebooks WHERE id = p_gradebook_id;
  RETURN v_version;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 9. Group CRUD that the UI needs
-- ---------------------------------------------------------------------------------------------

-- Moving a column between groups is a different operation from reordering, on purpose. A drag
-- that reorders cannot reach this; something has to say explicitly that membership changes.
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

  -- The composite foreign key would catch this too; catching it here gives a better message.
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

-- The FK is ON DELETE RESTRICT, so a group with columns in it cannot simply be deleted. This
-- moves the members into the default group, keeping their relative order, and then deletes.
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

  -- Close the gap the deleted group left.
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

-- ---------------------------------------------------------------------------------------------
-- 10. The bulk fetch RPCs
-- ---------------------------------------------------------------------------------------------
--
-- These two are why the old column was dropped rather than reinterpreted. Both order a payload by
-- gradebook_columns.sort_order, and get_gradebook_records_for_all_students_array returns a bare
-- array per student whose element order IS the column order. A client that zipped that array
-- against a separately fetched column list would have misaligned every score by some number of
-- places, silently, with no error anywhere. Reinterpreting sort_order in place would have done
-- exactly that; dropping it turned both into a hard failure until they were fixed here.
--
-- Everything except the join and the ORDER BY is unchanged from the previous definitions.

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

-- ---------------------------------------------------------------------------------------------
-- 11. Auto-layout
-- ---------------------------------------------------------------------------------------------
--
-- The old version walked every column in one global sequence and, for each, looked up the
-- sort_order of its already-placed dependencies so it could sit one to their right. That only
-- works while "to the right of" is a single comparable integer across the whole gradebook, and
-- it is not any more. Dependencies also routinely cross families: a `total-labs` column depends
-- on every lab column.
--
-- So auto-layout now orders both levels. Within a group it does what it always did: natural sort
-- by slug, so lab-2 comes before lab-10. Across groups it lifts each column dependency to an edge
-- between the groups those columns belong to, drops the self-edges that produces, and topologically
-- sorts the resulting graph, so a group of summary columns lands to the right of the group it
-- summarises.
--
-- A cycle between groups is more likely than a cycle between columns, because lifting merges
-- edges: two groups that each contain a column depending on the other are a cycle even when no
-- column depends on itself. That is not a broken gradebook, so it warns and keeps the order it
-- already had rather than failing, which is what the old code did for column cycles.

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

  -- One lock namespace for every ordering path. The old two-argument form here did not exclude
  -- the one-argument form every other function took, so auto-layout could interleave with a
  -- reorder.
  PERFORM pg_advisory_xact_lock(p_gradebook_id);
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'true', true);

  BEGIN
    -- Phase A: natural sort within each group.
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

    -- Phase B: the group graph. Edge g1 -> g2 means "a column in g2 reads a column in g1", so g1
    -- has to come first.
    -- Dropped explicitly as well as ON COMMIT, so calling auto-layout twice in one transaction
    -- does not trip over the previous call's scratch tables.
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
      -- Every group whose prerequisites are all placed, taking the ones that were already
      -- leftmost first so a gradebook with no dependencies keeps the order it had.
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

    -- Phase C: dense group positions, default group last.
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
