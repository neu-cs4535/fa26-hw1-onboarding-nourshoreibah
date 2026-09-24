-- Proof harness for 20260920120000_gradebook_column_groups.sql: row-level security as seeded
-- users, the constraints that keep a grouping well formed, and the routed-group cleanup rule.
--
-- Run against a seeded local Supabase with at least two classes; everything happens in one
-- transaction that ends in ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_column_groups_rls_constraints.sql
--
-- Each block raises if its claim is false, so a clean run ending in ROLLBACK is a pass:
--   1. A student sees the groups that hold a column they can see, and none of a class they are not in.
--   2. A student can create, rename and delete no group.
--   3. An instructor cannot put a group in another class, directly or through a mismatched gradebook.
--   4. The schema refuses a column in another gradebook's group, two columns in one slot, a second
--      pinned-last group, a malformed slug, deleting the default group, and deleting a non-empty group.
--   5. Emptying a routed group deletes it, unless an instructor renamed it.
--   6. gradebook_column_assign_group refuses a stale layout version and returns the new one.
--   7. The student SELECT policy's plan, for reading (printed, not asserted).
\set ON_ERROR_STOP on
\timing off

BEGIN;

-- The class with the most groups, and any other class.
SELECT g.class_id AS class_id, g.gradebook_id AS gradebook_id
  FROM public.gradebook_column_groups g
 GROUP BY g.class_id, g.gradebook_id
 ORDER BY count(*) DESC, g.class_id
 LIMIT 1 \gset
SELECT gb.class_id AS other_class_id, gb.id AS other_gradebook_id
  FROM public.gradebooks gb WHERE gb.class_id <> :class_id ORDER BY gb.id LIMIT 1 \gset
SELECT user_id AS student_uid FROM public.user_roles
 WHERE class_id = :class_id AND role = 'student' ORDER BY user_id LIMIT 1 \gset
SELECT user_id AS instructor_uid FROM public.user_roles
 WHERE class_id = :class_id AND role = 'instructor' ORDER BY user_id LIMIT 1 \gset
-- For section 3: an instructor of one class who holds no role in another.
SELECT a.user_id AS outsider_uid, a.class_id AS own_class_id, ga.id AS own_gradebook_id,
       gb.class_id AS foreign_class_id, gb.id AS foreign_gradebook_id
  FROM public.user_roles a
  JOIN public.gradebooks ga ON ga.class_id = a.class_id
  JOIN public.gradebooks gb ON gb.class_id <> a.class_id
 WHERE a.role = 'instructor'
   AND NOT EXISTS (SELECT 1 FROM public.user_roles o WHERE o.user_id = a.user_id AND o.class_id = gb.class_id)
 ORDER BY a.class_id, a.user_id LIMIT 1 \gset

-- One group whose every column is instructor-only and unreleased: its name must stay hidden.
SELECT g.id AS hidden_group_id FROM public.gradebook_column_groups g
 WHERE g.gradebook_id = :gradebook_id AND NOT g.is_default
   AND EXISTS (SELECT 1 FROM public.gradebook_columns c WHERE c.gradebook_column_group_id = g.id)
 ORDER BY g.sort_order DESC LIMIT 1 \gset
UPDATE public.gradebook_columns SET instructor_only = true, released = false
 WHERE gradebook_column_group_id = :hidden_group_id;

SELECT count(*) AS expected_visible FROM public.gradebook_column_groups g
 WHERE g.class_id = :class_id
   AND EXISTS (SELECT 1 FROM public.gradebook_columns c
                WHERE c.gradebook_column_group_id = g.id
                  AND (NOT COALESCE(c.instructor_only, false) OR c.released)) \gset

-- psql does not expand :variables inside DO bodies, so they read these settings instead.
SELECT set_config('harness.class_id', :'class_id', true), set_config('harness.gradebook_id', :'gradebook_id', true),
       set_config('harness.other_class_id', :'other_class_id', true),
       set_config('harness.other_gradebook_id', :'other_gradebook_id', true),
       set_config('harness.hidden_group_id', :'hidden_group_id', true),
       set_config('harness.expected_visible', :'expected_visible', true),
       set_config('harness.own_class_id', :'own_class_id', true),
       set_config('harness.foreign_class_id', :'foreign_class_id', true),
       set_config('harness.foreign_gradebook_id', :'foreign_gradebook_id', true) \gset ignored_

\echo '=== 1. what a student sees ==='
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'student_uid', 'role', 'authenticated')::text, true) \gset ignored_
-- Seeded students can be enrolled in several classes, so "elsewhere" means a class they are not in.
SELECT count(*) FILTER (WHERE class_id = :class_id) AS seen,
       count(*) FILTER (WHERE class_id NOT IN (SELECT class_id FROM public.user_roles
                                                WHERE user_id = :'student_uid')) AS seen_elsewhere,
       count(*) FILTER (WHERE id = :hidden_group_id) AS seen_hidden
  FROM public.gradebook_column_groups \gset
SELECT set_config('harness.seen', :'seen', true), set_config('harness.seen_elsewhere', :'seen_elsewhere', true),
       set_config('harness.seen_hidden', :'seen_hidden', true) \gset ignored_
DO $$ BEGIN
  ASSERT current_setting('harness.seen')::bigint = current_setting('harness.expected_visible')::bigint, format('student sees %s groups, expected %s', current_setting('harness.seen')::bigint, current_setting('harness.expected_visible')::bigint);
  ASSERT current_setting('harness.seen_elsewhere')::bigint = 0, format('student sees %s groups of another class', current_setting('harness.seen_elsewhere')::bigint);
  ASSERT current_setting('harness.seen_hidden')::bigint = 0, 'student sees a group that holds only hidden columns';
  RAISE NOTICE 'student sees % groups of the class, none of a class they are not in, not the hidden one', current_setting('harness.seen')::bigint;
END $$;

\echo '=== 2. a student cannot change groups ==='
DO $$ BEGIN
  BEGIN
    INSERT INTO public.gradebook_column_groups (class_id, gradebook_id, name, slug)
    VALUES (current_setting('harness.class_id')::bigint, current_setting('harness.gradebook_id')::bigint, 'Student group', 'student-group');
    RAISE EXCEPTION 'harness: a student created a group';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'student insert refused: %', SQLERRM;
  END;
END $$;
WITH u AS (UPDATE public.gradebook_column_groups SET name = 'Renamed by student' WHERE class_id = :class_id RETURNING 1),
     d AS (DELETE FROM public.gradebook_column_groups WHERE class_id = :class_id RETURNING 1)
SELECT (SELECT count(*) FROM u) AS student_updates, (SELECT count(*) FROM d) AS student_deletes \gset
SELECT set_config('harness.student_updates', :'student_updates', true),
       set_config('harness.student_deletes', :'student_deletes', true) \gset ignored_
DO $$ BEGIN
  ASSERT current_setting('harness.student_updates')::bigint = 0 AND current_setting('harness.student_deletes')::bigint = 0,
    format('student updated %s and deleted %s groups', current_setting('harness.student_updates')::bigint, current_setting('harness.student_deletes')::bigint);
  RAISE NOTICE 'student rename and delete touched no rows';
END $$;

\echo '=== 3. an instructor stays in their class ==='
SELECT set_config('request.jwt.claims', json_build_object('sub', :'outsider_uid', 'role', 'authenticated')::text, true) \gset ignored_
DO $$ BEGIN
  BEGIN
    INSERT INTO public.gradebook_column_groups (class_id, gradebook_id, name, slug)
    VALUES (current_setting('harness.foreign_class_id')::bigint, current_setting('harness.foreign_gradebook_id')::bigint, 'Elsewhere', 'elsewhere');
    RAISE EXCEPTION 'harness: an instructor created a group in another class';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'other class refused: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO public.gradebook_column_groups (class_id, gradebook_id, name, slug)
    VALUES (current_setting('harness.own_class_id')::bigint, current_setting('harness.foreign_gradebook_id')::bigint, 'Mismatched', 'mismatched');
    RAISE EXCEPTION 'harness: an instructor created a group under another class''s gradebook';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'mismatched gradebook refused: %', SQLERRM;
  END;
END $$;

\echo '=== 7. the student SELECT policy plan ==='
SELECT set_config('request.jwt.claims', json_build_object('sub', :'student_uid', 'role', 'authenticated')::text, true) \gset ignored_
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT * FROM public.gradebook_column_groups WHERE gradebook_id = :gradebook_id;
RESET ROLE;

\echo '=== 4. constraints ==='
DO $$
DECLARE
  v_col bigint;
  v_other_group bigint;
  v_a bigint;
  v_b bigint;
  v_group bigint;
  v_default bigint;
BEGIN
  SELECT id INTO v_col FROM public.gradebook_columns WHERE gradebook_id = current_setting('harness.gradebook_id')::bigint ORDER BY id LIMIT 1;
  SELECT id INTO v_other_group FROM public.gradebook_column_groups WHERE gradebook_id = current_setting('harness.other_gradebook_id')::bigint LIMIT 1;
  BEGIN
    UPDATE public.gradebook_columns SET gradebook_column_group_id = v_other_group WHERE id = v_col;
    RAISE EXCEPTION 'harness: a column joined another gradebook''s group';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'foreign group refused: %', SQLERRM;
  END;

  SELECT gradebook_column_group_id INTO v_group FROM public.gradebook_columns
   GROUP BY gradebook_column_group_id HAVING count(*) >= 2 ORDER BY gradebook_column_group_id LIMIT 1;
  SELECT id INTO v_a FROM public.gradebook_columns WHERE gradebook_column_group_id = v_group ORDER BY position_in_group LIMIT 1;
  SELECT id INTO v_b FROM public.gradebook_columns WHERE gradebook_column_group_id = v_group ORDER BY position_in_group DESC LIMIT 1;
  BEGIN
    SET CONSTRAINTS public.gradebook_columns_position_key IMMEDIATE;
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || current_setting('harness.gradebook_id')::bigint, 'true', true);
    UPDATE public.gradebook_columns
       SET position_in_group = (SELECT position_in_group FROM public.gradebook_columns WHERE id = v_a)
     WHERE id = v_b;
    RAISE EXCEPTION 'harness: two columns share a slot';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'shared slot refused: %', SQLERRM;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || current_setting('harness.gradebook_id')::bigint, 'false', true);
  SET CONSTRAINTS public.gradebook_columns_position_key DEFERRED;

  BEGIN
    UPDATE public.gradebook_column_groups SET sort_order = 2147483647 WHERE id = v_group;
    RAISE EXCEPTION 'harness: a second group was pinned last';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'pinned-last refused: %', SQLERRM;
  END;

  BEGIN
    UPDATE public.gradebook_column_groups SET slug = 'Not A Slug' WHERE id = v_group;
    RAISE EXCEPTION 'harness: a malformed slug was saved';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'malformed slug refused: %', SQLERRM;
  END;

  SELECT id INTO v_default FROM public.gradebook_column_groups WHERE gradebook_id = current_setting('harness.gradebook_id')::bigint AND is_default;
  BEGIN
    DELETE FROM public.gradebook_column_groups WHERE id = v_default;
    RAISE EXCEPTION 'harness: the default group was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'default delete refused: %', SQLERRM;
  END;

  BEGIN
    DELETE FROM public.gradebook_column_groups WHERE id = v_group;
    RAISE EXCEPTION 'harness: a group with columns was deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'non-empty delete refused: %', SQLERRM;
  END;
END $$;

\echo '=== 5. emptied routed groups ==='
-- The RPCs check instructor rights from the JWT claims.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor_uid', 'role', 'authenticated')::text, true) \gset ignored_
DO $$
DECLARE
  v_default bigint;
  v_kept bigint;
  v_gone bigint;
  v_col bigint;
BEGIN
  SELECT id INTO v_default FROM public.gradebook_column_groups WHERE gradebook_id = current_setting('harness.gradebook_id')::bigint AND is_default;

  INSERT INTO public.gradebook_columns (class_id, gradebook_id, name, slug, max_score)
  VALUES (current_setting('harness.class_id')::bigint, current_setting('harness.gradebook_id')::bigint, 'Harness A', 'harnessa-1', 10) RETURNING id INTO v_col;
  SELECT gradebook_column_group_id INTO v_gone FROM public.gradebook_columns WHERE id = v_col;
  PERFORM public.gradebook_column_assign_group(v_col, v_default);
  ASSERT NOT EXISTS (SELECT 1 FROM public.gradebook_column_groups WHERE id = v_gone),
    'an emptied routed group with its generated name survived';

  INSERT INTO public.gradebook_columns (class_id, gradebook_id, name, slug, max_score)
  VALUES (current_setting('harness.class_id')::bigint, current_setting('harness.gradebook_id')::bigint, 'Harness B', 'harnessb-1', 10) RETURNING id INTO v_col;
  SELECT gradebook_column_group_id INTO v_kept FROM public.gradebook_columns WHERE id = v_col;
  UPDATE public.gradebook_column_groups SET name = 'Renamed harness' WHERE id = v_kept;
  PERFORM public.gradebook_column_assign_group(v_col, v_default);
  ASSERT EXISTS (SELECT 1 FROM public.gradebook_column_groups WHERE id = v_kept),
    'an emptied routed group an instructor renamed was deleted';
  RAISE NOTICE 'routed group % deleted when emptied; renamed group % kept', v_gone, v_kept;
END $$;

\echo '=== 6. assign_group and the layout version ==='
DO $$
DECLARE
  v_col bigint;
  v_target bigint;
  v_version bigint;
  v_new bigint;
BEGIN
  SELECT column_layout_version INTO v_version FROM public.gradebooks WHERE id = current_setting('harness.gradebook_id')::bigint;
  SELECT c.id, (SELECT g.id FROM public.gradebook_column_groups g
                 WHERE g.gradebook_id = c.gradebook_id AND g.id <> c.gradebook_column_group_id
                 ORDER BY g.sort_order LIMIT 1)
    INTO v_col, v_target
    FROM public.gradebook_columns c WHERE c.gradebook_id = current_setting('harness.gradebook_id')::bigint ORDER BY c.id LIMIT 1;
  BEGIN
    PERFORM public.gradebook_column_assign_group(v_col, v_target, NULL, v_version - 1);
    RAISE EXCEPTION 'harness: a stale layout version was accepted';
  EXCEPTION WHEN serialization_failure THEN
    RAISE NOTICE 'stale version refused: %', SQLERRM;
  END;
  v_new := public.gradebook_column_assign_group(v_col, v_target, NULL, v_version);
  ASSERT v_new > v_version, format('version went from %s to %s', v_version, v_new);
  ASSERT v_new = (SELECT column_layout_version FROM public.gradebooks WHERE id = current_setting('harness.gradebook_id')::bigint),
    'returned version is not the stored one';
  RAISE NOTICE 'move accepted at version %, now %', v_version, v_new;
END $$;

\echo '=== all claims hold; rolling back ==='
ROLLBACK;
