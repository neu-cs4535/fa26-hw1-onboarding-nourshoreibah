-- Proof harness for 20260920120400_gradebook_column_group_slug_preview.sql.
--
-- Run from the repo root against a seeded local Supabase; everything happens in one transaction that
-- ends in ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_column_group_slug_preview.sql
--
-- Each block raises if its claim is false, so a clean run ending in ROLLBACK is a pass:
--   1. The preview writes nothing, for a slug that joins a group and for one that would start a group.
--   2. The writer then does what the preview said: the same existing group, or a new group with the
--      name the preview gave.
--   3. A student cannot call the preview, and anon cannot execute the routing helper.
\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE fx ON COMMIT DROP AS
SELECT g.id AS gradebook_id, g.class_id
  FROM public.gradebooks g
 WHERE EXISTS (SELECT 1 FROM public.gradebook_columns c WHERE c.gradebook_id = g.id)
 ORDER BY g.id
 LIMIT 1;

SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT ur.user_id FROM public.user_roles ur, fx
                             WHERE ur.class_id = fx.class_id AND ur.role = 'instructor' LIMIT 1),
                    'role', 'authenticated')::text,
  true);

\echo '=== 1 + 2. the preview reads only, and predicts the writer ==='
DO $$
DECLARE
  f record;
  v_slug text;
  v_preview record;
  v_before integer;
  v_after integer;
  v_written bigint;
  v_written_name text;
  v_checked integer := 0;
BEGIN
  SELECT * INTO f FROM fx;
  -- Slugs of existing columns (which route to a group that exists), plus slugs no group takes yet.
  FOR v_slug IN
    SELECT slug FROM (
      SELECT c.slug FROM public.gradebook_columns c WHERE c.gradebook_id = f.gradebook_id ORDER BY c.id LIMIT 4
    ) existing
    UNION ALL SELECT 'harness-brand-new-7'
    UNION ALL SELECT 'assignment-harness-does-not-exist'
  LOOP
    SELECT count(*) INTO v_before FROM public.gradebook_column_groups WHERE gradebook_id = f.gradebook_id;
    SELECT * INTO v_preview
      FROM public.gradebook_column_group_preview_for_slug(f.gradebook_id, f.class_id, v_slug);
    SELECT count(*) INTO v_after FROM public.gradebook_column_groups WHERE gradebook_id = f.gradebook_id;
    ASSERT v_after = v_before, format('preview of %s created a group', v_slug);
    ASSERT v_preview.is_new = (v_preview.group_id IS NULL),
      format('preview of %s: is_new %s but group_id %s', v_slug, v_preview.is_new, v_preview.group_id);

    v_written := public._gradebook_column_group_for_slug(f.gradebook_id, f.class_id, v_slug);
    SELECT name INTO v_written_name FROM public.gradebook_column_groups WHERE id = v_written;
    IF v_preview.is_new THEN
      ASSERT v_written_name = v_preview.group_name,
        format('%s: preview said a new group %s, writer made %s', v_slug, v_preview.group_name, v_written_name);
      ASSERT (SELECT count(*) FROM public.gradebook_column_groups WHERE gradebook_id = f.gradebook_id) = v_before + 1,
        format('%s: writer did not create exactly one group', v_slug);
    ELSE
      ASSERT v_written = v_preview.group_id,
        format('%s: preview said group %s, writer chose %s', v_slug, v_preview.group_id, v_written);
    END IF;
    RAISE NOTICE '% -> % (%)', v_slug, v_preview.group_name, CASE WHEN v_preview.is_new THEN 'new' ELSE 'joins' END;
    v_checked := v_checked + 1;
  END LOOP;
  ASSERT v_checked >= 3, 'fixture: too few slugs checked';
  ASSERT EXISTS (SELECT 1 FROM public.gradebook_column_groups g, fx
                  WHERE g.gradebook_id = fx.gradebook_id AND g.name IS NOT NULL),
    'fixture: gradebook has no groups';
END $$;

\echo '=== 3. who may call it ==='
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM fx;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', (SELECT user_id FROM public.user_roles
                               WHERE class_id = f.class_id AND role = 'student' LIMIT 1),
                      'role', 'authenticated')::text,
    true);
  BEGIN
    PERFORM * FROM public.gradebook_column_group_preview_for_slug(f.gradebook_id, f.class_id, 'quiz-1');
    RAISE EXCEPTION 'harness: a student previewed slug routing';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE 'insufficient permissions%', SQLERRM;
    RAISE NOTICE 'student refused: %', SQLERRM;
  END;
  ASSERT NOT has_function_privilege('anon', 'public._gradebook_column_group_slug_route(bigint, text)', 'EXECUTE'),
    'anon can execute _gradebook_column_group_slug_route';
  ASSERT NOT has_function_privilege('authenticated', 'public._gradebook_column_group_slug_route(bigint, text)', 'EXECUTE'),
    'authenticated can execute _gradebook_column_group_slug_route';
  ASSERT NOT has_function_privilege('anon', 'public.gradebook_column_group_preview_for_slug(bigint, bigint, text)', 'EXECUTE'),
    'anon can execute gradebook_column_group_preview_for_slug';
END $$;

\echo '=== all claims hold; rolling back ==='
ROLLBACK;
