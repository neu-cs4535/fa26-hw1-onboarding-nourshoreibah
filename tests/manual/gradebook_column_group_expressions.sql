-- Proof harness for 20260920120000_gradebook_column_groups.sql (the gradebook_column_group_expressions section).
--
-- Run from the repo root against a freshly seeded local Supabase; everything happens in one
-- transaction that ends in ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_column_group_expressions.sql
--
-- Each block raises if its claim is false, so a clean run ending in ROLLBACK is a pass:
--   1. A column joining a referenced group is appended to the dependent's dependencies,
--      and the dependent's rows are enqueued for every student.
--   2. The dependent's own id is never appended, so a total can sit inside its own group.
--   3. A column that already depends on the dependent cannot join the group.
--   4. Changing a referenced slug, or deleting a referenced group, is refused and names the column.
--   5. anon and authenticated cannot execute the new trigger and helper functions.
\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE fx ON COMMIT DROP AS
SELECT g.id AS gradebook_id, g.class_id,
       (SELECT id FROM public.gradebook_columns c WHERE c.gradebook_id = g.id ORDER BY id LIMIT 1) AS existing_column_id
  FROM public.gradebooks g
 WHERE EXISTS (SELECT 1 FROM public.gradebook_column_students s WHERE s.gradebook_id = g.id)
 ORDER BY g.id
 LIMIT 1;

INSERT INTO public.gradebook_column_groups (class_id, gradebook_id, name, slug, sort_order)
SELECT class_id, gradebook_id, 'Homework', 'harness-homework',
       (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM public.gradebook_column_groups g
         WHERE g.gradebook_id = fx.gradebook_id AND NOT g.is_default)
  FROM fx;

ALTER TABLE fx ADD COLUMN group_id bigint;
UPDATE fx SET group_id = (SELECT id FROM public.gradebook_column_groups WHERE slug = 'harness-homework'
                            AND gradebook_id = fx.gradebook_id);

\echo '=== a total column inside the group it totals ==='
INSERT INTO public.gradebook_columns
  (class_id, gradebook_id, name, slug, max_score, score_expression, dependencies, gradebook_column_group_id)
SELECT class_id, gradebook_id, 'Homework total', 'harness-hw-total', 100,
       'mean(gradebook_column_group("harness-homework"))',
       jsonb_build_object('gradebook_column_groups', jsonb_build_array(group_id), 'gradebook_columns', '[]'::jsonb),
       group_id
  FROM fx;
ALTER TABLE fx ADD COLUMN total_id bigint;
UPDATE fx SET total_id = (SELECT id FROM public.gradebook_columns WHERE slug = 'harness-hw-total'
                            AND gradebook_id = fx.gradebook_id);

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM fx;
  ASSERT (SELECT count(*) FROM public.gradebook_column_students WHERE gradebook_column_id = f.total_id) > 0,
    'fixture: the total column has no student rows to recalculate';
  ASSERT NOT (SELECT dependencies -> 'gradebook_columns' FROM public.gradebook_columns WHERE id = f.total_id)
             @> jsonb_build_array(f.total_id),
    'the total listed itself as a dependency on insert';
END $$;

\echo '=== 1 + 2. a new column joins the group ==='
UPDATE public.gradebook_row_recalc_state s SET dirty = false FROM fx WHERE s.gradebook_id = fx.gradebook_id;

INSERT INTO public.gradebook_columns (class_id, gradebook_id, name, slug, max_score, gradebook_column_group_id)
SELECT class_id, gradebook_id, 'HW 1', 'harness-hw-1', 10, group_id FROM fx;

DO $$
DECLARE
  f record;
  v_hw1 bigint;
  v_deps jsonb;
  v_students integer;
  v_dirty integer;
BEGIN
  SELECT * INTO f FROM fx;
  SELECT id INTO v_hw1 FROM public.gradebook_columns WHERE slug = 'harness-hw-1' AND gradebook_id = f.gradebook_id;
  SELECT dependencies INTO v_deps FROM public.gradebook_columns WHERE id = f.total_id;
  ASSERT v_deps -> 'gradebook_columns' @> jsonb_build_array(v_hw1),
    format('joining column %s missing from dependencies %s', v_hw1, v_deps);
  ASSERT NOT v_deps -> 'gradebook_columns' @> jsonb_build_array(f.total_id),
    format('total appended its own id: %s', v_deps);
  ASSERT v_deps -> 'gradebook_column_groups' = jsonb_build_array(f.group_id),
    format('group list changed: %s', v_deps);

  SELECT count(*) INTO v_students FROM (
    SELECT DISTINCT student_id, is_private FROM public.gradebook_column_students WHERE gradebook_column_id = f.total_id
  ) t;
  SELECT count(*) INTO v_dirty FROM public.gradebook_row_recalc_state s
   WHERE s.gradebook_id = f.gradebook_id AND s.dirty
     AND EXISTS (SELECT 1 FROM public.gradebook_column_students g
                  WHERE g.gradebook_column_id = f.total_id AND g.student_id = s.student_id
                    AND g.is_private = s.is_private);
  -- A new column's cells start NULL, but countif counts every member it is given, so even an
  -- empty join can change a dependent's score. Every dependent row is enqueued.
  ASSERT v_students > 0, 'fixture total has no student rows';
  ASSERT v_dirty = v_students, format('%s of %s dependent rows enqueued by a join by insert', v_dirty, v_students);
  RAISE NOTICE 'appended %, enqueued all % dependent rows for an empty new column', v_hw1, v_students;
END $$;

\echo '=== 1. an existing column moves into the group ==='
UPDATE public.gradebook_row_recalc_state s SET dirty = false FROM fx WHERE s.gradebook_id = fx.gradebook_id;
UPDATE public.gradebook_columns c
   SET gradebook_column_group_id = fx.group_id,
       position_in_group = 100
  FROM fx
 WHERE c.id = fx.existing_column_id;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM fx;
  ASSERT (SELECT dependencies -> 'gradebook_columns' FROM public.gradebook_columns WHERE id = f.total_id)
         @> jsonb_build_array(f.existing_column_id),
    'moved column missing from dependencies';
  ASSERT (SELECT count(*) FROM public.gradebook_row_recalc_state s WHERE s.gradebook_id = f.gradebook_id AND s.dirty) > 0,
    'moving a column into the group enqueued nothing';
END $$;

\echo '=== 3. a column that depends on the total cannot join the group ==='
INSERT INTO public.gradebook_columns (class_id, gradebook_id, name, slug, max_score, score_expression, dependencies)
SELECT class_id, gradebook_id, 'Final', 'harness-final', 100, 'gradebook_columns("harness-hw-total")',
       jsonb_build_object('gradebook_columns', jsonb_build_array(total_id))
  FROM fx;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM fx;
  BEGIN
    UPDATE public.gradebook_columns SET gradebook_column_group_id = f.group_id, position_in_group = 200
     WHERE slug = 'harness-final' AND gradebook_id = f.gradebook_id;
    RAISE EXCEPTION 'harness: moving harness-final into the group was allowed';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'Cycle detected:%harness-final%harness-hw-total%', SQLERRM;
    RAISE NOTICE 'refused: %', SQLERRM;
  END;
END $$;

\echo '=== changing an existing member between a total and a manual column ==='
INSERT INTO public.gradebook_columns
  (class_id, gradebook_id, name, slug, max_score, score_expression, dependencies, gradebook_column_group_id)
SELECT class_id, gradebook_id, 'Second total', 'harness-second-total', 100,
       'mean(gradebook_column_group("harness-homework"))',
       jsonb_build_object('gradebook_column_groups', jsonb_build_array(group_id)), group_id
  FROM fx;

DO $$
DECLARE f record; v_second bigint;
BEGIN
  SELECT * INTO f FROM fx;
  SELECT id INTO v_second FROM public.gradebook_columns
   WHERE gradebook_id = f.gradebook_id AND slug = 'harness-second-total';
  ASSERT NOT COALESCE((SELECT dependencies -> 'gradebook_columns' FROM public.gradebook_columns WHERE id = f.total_id), '[]'::jsonb)
             @> jsonb_build_array(v_second), 'a total counted another total';

  UPDATE public.gradebook_columns SET score_expression = NULL, dependencies = NULL WHERE id = v_second;
  ASSERT (SELECT dependencies -> 'gradebook_columns' FROM public.gradebook_columns WHERE id = f.total_id)
             @> jsonb_build_array(v_second), 'the former total did not become a dependency';

  UPDATE public.gradebook_columns
     SET score_expression = 'mean(gradebook_column_group("harness-homework"))',
         dependencies = jsonb_build_object('gradebook_column_groups', jsonb_build_array(f.group_id))
   WHERE id = v_second;
  ASSERT NOT (SELECT dependencies -> 'gradebook_columns' FROM public.gradebook_columns WHERE id = f.total_id)
             @> jsonb_build_array(v_second), 'converting a member to a total left its old dependency';
END $$;

\echo '=== reordering members enqueues group expressions ==='
UPDATE public.gradebook_row_recalc_state s SET dirty = false FROM fx WHERE s.gradebook_id = fx.gradebook_id;
UPDATE public.gradebook_columns c SET position_in_group = 0 FROM fx
 WHERE c.id = fx.existing_column_id;
DO $$
DECLARE f record; v_expected integer; v_dirty integer;
BEGIN
  SELECT * INTO f FROM fx;
  SELECT count(DISTINCT (student_id, is_private)) INTO v_expected
    FROM public.gradebook_column_students WHERE gradebook_column_id = f.total_id;
  SELECT count(*) INTO v_dirty FROM public.gradebook_row_recalc_state s
   WHERE s.gradebook_id = f.gradebook_id AND s.dirty
     AND EXISTS (SELECT 1 FROM public.gradebook_column_students c
                  WHERE c.gradebook_column_id = f.total_id AND c.student_id = s.student_id
                    AND c.is_private = s.is_private);
  ASSERT v_expected > 0 AND v_dirty = v_expected, 'member reordering did not enqueue the dependent rows';
END $$;

\echo '=== 4. referenced slugs and groups are protected ==='
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM fx;
  BEGIN
    UPDATE public.gradebook_column_groups SET slug = 'harness-renamed' WHERE id = f.group_id;
    RAISE EXCEPTION 'harness: renaming a referenced slug was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%Homework total (harness-hw-total)%', SQLERRM;
    RAISE NOTICE 'refused: %', SQLERRM;
  END;

  -- A name change is not a slug change.
  UPDATE public.gradebook_column_groups SET name = 'Homework (renamed)' WHERE id = f.group_id;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', (SELECT user_id FROM public.user_roles
                               WHERE class_id = f.class_id AND role = 'instructor' LIMIT 1), 'role', 'authenticated')::text,
    true);
  BEGIN
    PERFORM public.gradebook_column_group_delete(f.group_id);
    RAISE EXCEPTION 'harness: deleting a referenced group was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE 'Cannot delete group%Homework total (harness-hw-total)%', SQLERRM;
    RAISE NOTICE 'refused: %', SQLERRM;
  END;
END $$;

\echo '=== 5. new functions are not executable by anon or authenticated ==='
DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.gradebook_columns_sync_group_dependents()',
    'public.gradebook_column_groups_protect_referenced_slug()',
    'public._gradebook_column_group_assert_unreferenced(bigint, text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      ASSERT NOT has_function_privilege(r, fn, 'EXECUTE'), format('%s can execute %s', r, fn);
    END LOOP;
  END LOOP;
END $$;

SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public._gradebook_column_group_assert_unreferenced(1, 'probe');
  RAISE EXCEPTION 'harness: anon executed _gradebook_column_group_assert_unreferenced';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'anon refused: %', SQLERRM;
END $$;
RESET ROLE;

\echo '=== all claims hold; rolling back ==='
ROLLBACK;
