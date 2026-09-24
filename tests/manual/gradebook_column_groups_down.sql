-- Down path for 20260920120000_gradebook_column_groups.sql.
--
-- Migrations here are forward-only, so this is a script to run by hand, not a migration. By
-- default it is a rehearsal: it adds a column whose expression names a group, runs both steps in
-- one transaction, checks each, and ends in ROLLBACK.
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_column_groups_down.sql
--
-- To revert for real, in order:
--   1. run with -v rehearsal=false, which runs step 1 and commits;
--   2. deploy the previous frontend and edge functions straight after, since this frontend
--      depends on the triggers step 1 removes and the gradebook page errors in between;
--   3. once nothing reads the groups, run with -v rehearsal=false -v drop_groups=true, which
--      runs step 2 and commits.
--
-- Step 1 keeps every column where it is now: sort_order is rebuilt from
-- (group.sort_order, position_in_group, id), so instructor reorders survive. The old browser
-- heuristic then recomputes headers from slugs. C1 stays fixed, because the rebuilt sort_order
-- has no holes; C2 and C3 are undone (meets-, approaching- and does-not-meet-expectations become
-- three headers again). To put back the layout from before the migration instead, fill
-- sort_order from migration_archive.gradebook_columns_legacy_layout and append newer columns.
--
-- Step 2 loses group names, slugs, descriptions and hand-made membership. Nothing older than the
-- migration stored them, so there is nothing further back to restore.
\set ON_ERROR_STOP on
\timing off
\if :{?rehearsal}
\else
  \set rehearsal true
\endif
\if :{?drop_groups}
\else
  \set drop_groups false
\endif
\if :rehearsal
  \set run_step_1 true
  \set run_step_2 true
\elif :drop_groups
  \set run_step_1 false
  \set run_step_2 true
\else
  \set run_step_1 true
  \set run_step_2 false
\endif

BEGIN;

\if :rehearsal
\echo '=== rehearsal fixture: a total that names a group ==='
INSERT INTO public.gradebook_columns
       (class_id, gradebook_id, name, slug, max_score, score_expression, dependencies)
SELECT g.class_id, g.gradebook_id, 'Down path total', 'down-path-total', 100,
       'mean(gradebook_column_group("' || g.slug || '"))',
       jsonb_build_object('gradebook_column_groups', jsonb_build_array(g.id), 'gradebook_columns', '[]'::jsonb)
  FROM public.gradebook_column_groups g
 WHERE NOT g.is_default
   AND (SELECT count(*) FROM public.gradebook_columns c WHERE c.gradebook_column_group_id = g.id) >= 2
 ORDER BY g.id
 LIMIT 1;
\endif

\if :run_step_1

-- ============================================================================
-- Step 1: revert behavior, keep the group data
-- ============================================================================

\echo '=== 1a. expressions that name a group now name its members ==='
-- gradebook_column_group("s") becomes gradebook_columns(["m1", "m2", ...]): the members the
-- evaluators expanded it to, i.e. the group's columns except the column itself and other totals
-- of the group, in position order. The old evaluator accepts a list of slugs there.
DO $$
DECLARE
  r record;
  v_expr text;
  v_list text;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT c.id, c.gradebook_id, c.score_expression
      FROM public.gradebook_columns c
     WHERE c.score_expression ~ 'gradebook_column_group\s*\('
  LOOP
    v_expr := r.score_expression;
    FOR v_list IN
      SELECT DISTINCT COALESCE(m[1], m[2])
        FROM regexp_matches(r.score_expression,
                            'gradebook_column_group\s*\(\s*(?:"([^"]*)"|''([^'']*)'')\s*\)', 'g') AS m
    LOOP
      v_expr := regexp_replace(
        v_expr,
        'gradebook_column_group\s*\(\s*(?:"' || regexp_replace(v_list, '([^a-zA-Z0-9])', '\\\1', 'g')
          || '"|''' || regexp_replace(v_list, '([^a-zA-Z0-9])', '\\\1', 'g') || ''')\s*\)',
        'gradebook_columns([' || COALESCE((
          SELECT string_agg('"' || m.slug || '"', ', ' ORDER BY m.position_in_group, m.id)
            FROM public.gradebook_column_groups g
            JOIN public.gradebook_columns m ON m.gradebook_column_group_id = g.id
           WHERE g.gradebook_id = r.gradebook_id
             AND g.slug = v_list
             AND m.id <> r.id
             AND NOT COALESCE(m.dependencies -> 'gradebook_column_groups', '[]'::jsonb)
                     @> jsonb_build_array(g.id)), '') || '])',
        'g');
    END LOOP;
    UPDATE public.gradebook_columns
       SET score_expression = v_expr,
           dependencies = dependencies - 'gradebook_column_groups'
     WHERE id = r.id;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'rewrote % score expressions', v_n;
END $$;

\echo '=== 1b. sort_order comes back, in the current display order ==='
ALTER TABLE public.gradebook_columns ADD COLUMN sort_order integer;
UPDATE public.gradebook_columns c
   SET sort_order = sub.pos
  FROM (
    SELECT c2.id,
           (ROW_NUMBER() OVER (PARTITION BY c2.gradebook_id
                               ORDER BY g.sort_order, c2.position_in_group, c2.id) - 1)::integer AS pos
      FROM public.gradebook_columns c2
      JOIN public.gradebook_column_groups g ON g.id = c2.gradebook_column_group_id
  ) sub
 WHERE c.id = sub.id;
CREATE INDEX IF NOT EXISTS idx_gradebook_columns_id_covering ON public.gradebook_columns USING btree (id) INCLUDE (sort_order);

\echo '=== 1c. the triggers this migration added to gradebook_columns and gradebooks go ==='
DROP TRIGGER IF EXISTS gradebook_columns_assign_default_group_tr ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_enforce_sort_order_tr ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_insert ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_update ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_bump_layout_delete ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_broadcast_group_visibility_insert ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_broadcast_group_visibility_update ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_merge_group_dependencies_tr ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_insert ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_update ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebook_columns_sync_group_dependents_delete ON public.gradebook_columns;
DROP TRIGGER IF EXISTS gradebooks_create_default_column_group_tr ON public.gradebooks;

-- The previous code inserts columns without a group, so membership stops being required.
ALTER TABLE public.gradebook_columns DROP CONSTRAINT IF EXISTS gradebook_columns_group_fk;
ALTER TABLE public.gradebook_columns DROP CONSTRAINT IF EXISTS gradebook_columns_position_key;
ALTER TABLE public.gradebook_columns
  ALTER COLUMN gradebook_column_group_id DROP NOT NULL,
  ALTER COLUMN position_in_group DROP NOT NULL,
  ALTER COLUMN position_in_group DROP DEFAULT;

\echo '=== 1d. the previous bodies of the functions this migration replaced ==='
-- Taken with pg_get_functiondef from a database migrated up to 20260904120000.
CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    gradebook_id bigint;
    new_col_id bigint;
    next_sort_order integer;
BEGIN
    -- Serialize sort_order allocation per class to prevent duplicates under concurrent inserts
    PERFORM pg_advisory_xact_lock(NEW.class_id);

    -- Get the gradebook_id for this class
    SELECT g.id INTO gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id;

    -- Determine next sort_order: max existing sort_order + 1, or 0 if none exist
    SELECT COALESCE(MAX(sort_order), -1) + 1 INTO next_sort_order
    FROM public.gradebook_columns
    WHERE class_id = NEW.class_id
      AND sort_order IS NOT NULL;

    -- Create the gradebook column
    INSERT INTO public.gradebook_columns (
        name,
        max_score,
        slug,
        class_id,
        gradebook_id,
        score_expression,
        released,
        dependencies,
        sort_order
    ) VALUES (
        NEW.title,
        NEW.total_points,
        'assignment-' || NEW.slug,
        NEW.class_id,
        gradebook_id,
        'assignments("' || NEW.slug || '")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.id)),
        next_sort_order
    ) RETURNING id into new_col_id;

    -- Since this is an AFTER INSERT trigger, we need to UPDATE the assignments table
    -- to set the gradebook_column_id
    UPDATE public.assignments
    SET gradebook_column_id = new_col_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$function$
;

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
                        ) ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                    )
                ) as student_data
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) grouped_data
    );
END;
$function$
;

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
                    ] ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                ) as entries_array
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) array_data
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gradebook_auto_layout(p_gradebook_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- function body continues here
DECLARE
  v_col record;
  v_dep_col_id bigint;
  v_max_dep_order integer;
  v_new_order integer;
  v_processed_ids bigint[] := '{}';
  v_remaining_count integer;
  v_prev_remaining_count integer := -1;
  v_class_id bigint;
BEGIN
  -- Get the class_id for this gradebook and check authorization
  SELECT class_id INTO v_class_id
  FROM public.gradebooks
  WHERE id = p_gradebook_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', p_gradebook_id;
  END IF;

  -- Check if user is authorized as class instructor
  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  -- Serialize per-gradebook to avoid race conditions
  -- Namespace 17031 chosen arbitrarily for "gradebook_auto_layout"
  -- FIXED: Use two-integer version of pg_advisory_xact_lock
  PERFORM pg_advisory_xact_lock(17031, p_gradebook_id::int);
  -- Temporarily bypass the sort order trigger for this specific gradebook during bulk operations
  -- This avoids ACCESS EXCLUSIVE locks that would block concurrent operations on other gradebooks
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'true', true);

  BEGIN
    -- Step 1: Initial alphanumeric sort by slug (lab-2 before lab-10)
    -- Start with a clean 0-based sequence
    WITH ordered_cols AS (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY 
        -- Natural sort: extract text and numeric parts separately
        regexp_replace(slug, '\d+', '', 'g'), -- text part first
        COALESCE(
          (regexp_match(slug, '\d+'))[1]::integer, -- first number found
          0
        ),
        slug -- fallback to original slug for ties
      ) - 1) AS temp_sort_order
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
    )
    UPDATE public.gradebook_columns gc
    SET sort_order = oc.temp_sort_order
    FROM ordered_cols oc
    WHERE gc.id = oc.id;

    -- Step 2: Topological sort to respect gradebook_column dependencies
    -- Process columns until all are handled or we detect a cycle
    LOOP
      SELECT COUNT(*) INTO v_remaining_count
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
        AND id <> ALL(v_processed_ids);

      -- Exit if no more columns to process
      EXIT WHEN v_remaining_count = 0;

      -- Detect infinite loop (circular dependencies)
      IF v_remaining_count = v_prev_remaining_count THEN
        RAISE WARNING 'Circular dependency detected in gradebook %. Stopping topological sort.', p_gradebook_id;
        EXIT;
      END IF;
      v_prev_remaining_count := v_remaining_count;

      -- Process columns that either have no gradebook_column dependencies 
      -- or all their dependencies are already processed
      FOR v_col IN
        SELECT id, slug, dependencies, sort_order
        FROM public.gradebook_columns
        WHERE gradebook_id = p_gradebook_id
          AND id <> ALL(v_processed_ids)
        ORDER BY sort_order NULLS LAST, id
      LOOP
        -- Check if this column has gradebook_column dependencies
        IF v_col.dependencies ? 'gradebook_columns' AND 
           jsonb_array_length(v_col.dependencies->'gradebook_columns') > 0 THEN
          
          -- Find the maximum sort_order among its dependencies that are already processed
          v_max_dep_order := -1;
          
          -- Check each dependency
          FOR v_dep_col_id IN
            SELECT jsonb_array_elements_text(v_col.dependencies->'gradebook_columns')::bigint
          LOOP
            -- Only consider dependencies that are in the same gradebook and already processed
            IF v_dep_col_id = ANY(v_processed_ids) THEN
              SELECT sort_order INTO v_new_order
              FROM public.gradebook_columns
              WHERE id = v_dep_col_id AND gradebook_id = p_gradebook_id;
              
              IF v_new_order IS NOT NULL AND v_new_order > v_max_dep_order THEN
                v_max_dep_order := v_new_order;
              END IF;
            END IF;
          END LOOP;
          
          -- Check if all dependencies are processed
          IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(v_col.dependencies->'gradebook_columns') AS dep_id
            WHERE dep_id::bigint <> ALL(v_processed_ids)
              AND EXISTS (
                SELECT 1 FROM public.gradebook_columns 
                WHERE id = dep_id::bigint AND gradebook_id = p_gradebook_id
              )
          ) THEN
            -- Not all dependencies processed yet, skip this column for now
            CONTINUE;
          END IF;
          
          -- Place this column immediately after its highest dependency
          IF v_max_dep_order >= 0 THEN
            v_new_order := v_max_dep_order + 1;
            
            -- The AFTER trigger should handle conflicts by shifting other columns
            -- when multiple columns try to occupy the same position
            UPDATE public.gradebook_columns
            SET sort_order = v_new_order
            WHERE id = v_col.id;
          END IF;
        END IF;
        
        -- Mark this column as processed
        v_processed_ids := array_append(v_processed_ids, v_col.id);
      END LOOP;
    END LOOP;

    -- Final pass: compact to contiguous 0-based sequence (0,1,2,3...) without gaps
    -- Process in dependency order to maintain relationships
    WITH ordered_final AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1 AS final_sort_order
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
    )
    UPDATE public.gradebook_columns gc
    SET sort_order = of.final_sort_order
    FROM ordered_final of
    WHERE gc.id = of.id;

  EXCEPTION
    WHEN OTHERS THEN
      -- Always reset the bypass setting for this gradebook, even if there was an error
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
      RAISE;
  END;

  -- Reset the bypass setting to re-enable normal trigger enforcement for this gradebook
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);

END;
$function$
;

CREATE OR REPLACE FUNCTION public.gradebook_column_move_left(p_column_id bigint)
 RETURNS gradebook_columns
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_gradebook_id bigint;
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_self_order integer;
  v_neighbor_order integer;
  v_max integer;
BEGIN
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  IF EXISTS (
    SELECT 1
      FROM public.gradebook_columns
     WHERE gradebook_id = v_gradebook_id
       AND sort_order IS NULL
  ) THEN
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
    BEGIN
      SELECT COALESCE(MAX(sort_order), -1) INTO v_max
        FROM public.gradebook_columns
       WHERE gradebook_id = v_gradebook_id;

      WITH numbered AS (
        SELECT
          id,
          ROW_NUMBER() OVER (ORDER BY id) AS rn
        FROM public.gradebook_columns
        WHERE gradebook_id = v_gradebook_id
          AND sort_order IS NULL
      )
      UPDATE public.gradebook_columns gc
         SET sort_order = v_max + numbered.rn
        FROM numbered
       WHERE gc.id = numbered.id;
    EXCEPTION
      WHEN OTHERS THEN
        PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
        RAISE;
    END;
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
  END IF;

  SELECT * INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  WITH ordered AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY sort_order ASC NULLS LAST, id ASC) AS rn
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
  )
  SELECT o2.id
    INTO v_neighbor_id
    FROM ordered o1
    JOIN ordered o2 ON o2.rn = o1.rn - 1
   WHERE o1.id = p_column_id;

  IF v_neighbor_id IS NULL THEN
    RETURN v_col;
  END IF;

  SELECT sort_order INTO v_neighbor_order
    FROM public.gradebook_columns
   WHERE id = v_neighbor_id
   FOR UPDATE;

  v_self_order := v_col.sort_order;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
  BEGIN
    UPDATE public.gradebook_columns
       SET sort_order = v_neighbor_order
     WHERE id = p_column_id;

    UPDATE public.gradebook_columns
       SET sort_order = v_self_order
     WHERE id = v_neighbor_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gradebook_column_move_right(p_column_id bigint)
 RETURNS gradebook_columns
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_gradebook_id bigint;
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_self_order integer;
  v_neighbor_order integer;
  v_max integer;
BEGIN
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  IF EXISTS (
    SELECT 1
      FROM public.gradebook_columns
     WHERE gradebook_id = v_gradebook_id
       AND sort_order IS NULL
  ) THEN
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
    BEGIN
      SELECT COALESCE(MAX(sort_order), -1) INTO v_max
        FROM public.gradebook_columns
       WHERE gradebook_id = v_gradebook_id;

      WITH numbered AS (
        SELECT
          id,
          ROW_NUMBER() OVER (ORDER BY id) AS rn
        FROM public.gradebook_columns
        WHERE gradebook_id = v_gradebook_id
          AND sort_order IS NULL
      )
      UPDATE public.gradebook_columns gc
         SET sort_order = v_max + numbered.rn
        FROM numbered
       WHERE gc.id = numbered.id;
    EXCEPTION
      WHEN OTHERS THEN
        PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
        RAISE;
    END;
    PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
  END IF;

  SELECT * INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  WITH ordered AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY sort_order ASC NULLS LAST, id ASC) AS rn
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
  )
  SELECT o2.id
    INTO v_neighbor_id
    FROM ordered o1
    JOIN ordered o2 ON o2.rn = o1.rn + 1
   WHERE o1.id = p_column_id;

  IF v_neighbor_id IS NULL THEN
    RETURN v_col;
  END IF;

  SELECT sort_order INTO v_neighbor_order
    FROM public.gradebook_columns
   WHERE id = v_neighbor_id
   FOR UPDATE;

  v_self_order := v_col.sort_order;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
  BEGIN
    UPDATE public.gradebook_columns
       SET sort_order = v_neighbor_order
     WHERE id = p_column_id;

    UPDATE public.gradebook_columns
       SET sort_order = v_self_order
     WHERE id = v_neighbor_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gradebook_columns_enforce_sort_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  max_order integer;
  target_order integer;
BEGIN
  -- Avoid re-entrant work when our own UPDATEs fire the trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Allow bypassing trigger enforcement during bulk operations for specific gradebooks
  -- This avoids the need for ACCESS EXCLUSIVE locks when disabling triggers globally
  IF current_setting('pawtograder.bypass_sort_order_trigger_' || NEW.gradebook_id::text, true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Take per-gradebook advisory locks to serialize operations and avoid races
  IF TG_OP = 'UPDATE' AND NEW.gradebook_id IS DISTINCT FROM OLD.gradebook_id THEN
    IF OLD.gradebook_id < NEW.gradebook_id THEN
      PERFORM pg_advisory_xact_lock(OLD.gradebook_id);
      PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
    ELSE
      PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
      PERFORM pg_advisory_xact_lock(OLD.gradebook_id);
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
  END IF;

  -- Handle NULL or negative sort_order
  IF NEW.sort_order IS NULL THEN
    SELECT COALESCE(MAX(sort_order), -1) + 1
      INTO NEW.sort_order
      FROM public.gradebook_columns
     WHERE gradebook_id = NEW.gradebook_id
       AND id != NEW.id;
  ELSIF NEW.sort_order < 0 THEN
    NEW.sort_order := 0;
  END IF;

  -- Handle conflicts by shifting other rows
  IF TG_OP = 'INSERT' THEN
    -- Shift right any conflicting or following columns
    UPDATE public.gradebook_columns
       SET sort_order = sort_order + 1
     WHERE gradebook_id = NEW.gradebook_id
       AND sort_order >= NEW.sort_order
       AND id != NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Moving across gradebooks: close gap in old, insert into new
    IF NEW.gradebook_id IS DISTINCT FROM OLD.gradebook_id THEN
      -- Close gap in old gradebook
      IF OLD.sort_order IS NOT NULL THEN
        UPDATE public.gradebook_columns
           SET sort_order = sort_order - 1
         WHERE gradebook_id = OLD.gradebook_id
           AND sort_order > OLD.sort_order
           AND id != NEW.id;
      END IF;

      -- Make room in new gradebook
      UPDATE public.gradebook_columns
         SET sort_order = sort_order + 1
       WHERE gradebook_id = NEW.gradebook_id
         AND sort_order >= NEW.sort_order
         AND id != NEW.id;

    -- Within same gradebook: reposition if changed
    ELSIF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
      -- Simple approach: shift everything at the target position and beyond
      UPDATE public.gradebook_columns
         SET sort_order = sort_order + 1
       WHERE gradebook_id = NEW.gradebook_id
         AND sort_order >= NEW.sort_order
         AND id != NEW.id;
      
      -- Close the gap where this column used to be
      IF OLD.sort_order IS NOT NULL THEN
        UPDATE public.gradebook_columns
           SET sort_order = sort_order - 1
         WHERE gradebook_id = NEW.gradebook_id
           AND sort_order > OLD.sort_order
           AND id != NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_gradebook_id bigint;
  v_class_id bigint;
  v_expected_count integer;
  v_payload_count integer;
  v_distinct_payload integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload_count := COALESCE(array_length(p_ordered_column_ids, 1), 0);

  IF v_payload_count = 0 THEN
    RETURN;
  END IF;

  SELECT COUNT(DISTINCT x) INTO v_distinct_payload
  FROM unnest(p_ordered_column_ids) AS x;

  IF v_distinct_payload <> v_payload_count THEN
    RAISE EXCEPTION 'Duplicate column IDs in reorder payload';
  END IF;

  SELECT gc.gradebook_id INTO v_gradebook_id
  FROM public.gradebook_columns AS gc
  WHERE gc.id = p_ordered_column_ids[1];

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_ordered_column_ids[1];
  END IF;

  SELECT class_id INTO v_class_id
  FROM public.gradebooks
  WHERE id = v_gradebook_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', v_gradebook_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  SELECT COUNT(*)::integer INTO v_expected_count
  FROM public.gradebook_columns
  WHERE gradebook_id = v_gradebook_id;

  IF v_expected_count <> v_payload_count THEN
    RAISE EXCEPTION 'Payload count (%) does not match gradebook column count (%)', v_payload_count, v_expected_count;
  END IF;

  IF (
    SELECT COUNT(*)::integer
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
      AND id = ANY (p_ordered_column_ids)
  ) <> v_payload_count THEN
    RAISE EXCEPTION 'One or more column IDs do not belong to this gradebook';
  END IF;

  -- Single-key form (bigint); the two-key form requires (integer, integer), not (int, bigint).
  -- Same namespace as gradebook_column_move_left/right — serializes all column-order updates per gradebook.
  PERFORM pg_advisory_xact_lock(v_gradebook_id);
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);

  BEGIN
    UPDATE public.gradebook_columns AS gc
    SET sort_order = ord.new_order
    FROM (
      SELECT id, (ordinality - 1)::integer AS new_order
      FROM unnest(p_ordered_column_ids) WITH ORDINALITY AS t(id, ordinality)
    ) AS ord
    WHERE gc.id = ord.id
      AND gc.gradebook_id = v_gradebook_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
END;
$function$
;

-- The previous trigger, on the previous column list.
CREATE TRIGGER gradebook_columns_enforce_sort_order_tr BEFORE INSERT OR UPDATE OF sort_order, gradebook_id ON public.gradebook_columns FOR EACH ROW EXECUTE FUNCTION gradebook_columns_enforce_sort_order();

\echo '=== step 1 checks ==='
DO $$
DECLARE
  v_bad integer;
  v_col bigint;
  v_class bigint;
  v_gradebook bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.gradebook_columns WHERE sort_order IS NULL;
  ASSERT v_bad = 0, format('%s columns without a sort_order', v_bad);
  SELECT count(*) INTO v_bad FROM (
    SELECT gradebook_id, sort_order FROM public.gradebook_columns GROUP BY 1, 2 HAVING count(*) > 1) d;
  ASSERT v_bad = 0, format('%s duplicate sort_order slots', v_bad);
  SELECT count(*) INTO v_bad FROM (
    SELECT ROW_NUMBER() OVER (PARTITION BY c.gradebook_id ORDER BY c.sort_order) AS a,
           ROW_NUMBER() OVER (PARTITION BY c.gradebook_id ORDER BY g.sort_order, c.position_in_group, c.id) AS b
      FROM public.gradebook_columns c
      JOIN public.gradebook_column_groups g ON g.id = c.gradebook_column_group_id) t
   WHERE a <> b;
  ASSERT v_bad = 0, format('%s columns changed position', v_bad);
  SELECT count(*) INTO v_bad FROM public.gradebook_columns WHERE score_expression ~ 'gradebook_column_group\s*\(';
  ASSERT v_bad = 0, format('%s expressions still name a group', v_bad);
  ASSERT (SELECT prosrc FROM pg_proc WHERE proname = 'gradebook_column_move_left') ~ 'sort_order'
     AND (SELECT prosrc FROM pg_proc WHERE proname = 'gradebook_column_move_left') !~ 'position_in_group',
    'gradebook_column_move_left still has the new body';

  -- The previous code path: a column inserted with no group gets the next sort_order.
  SELECT class_id, id INTO v_class, v_gradebook FROM public.gradebooks ORDER BY id LIMIT 1;
  INSERT INTO public.gradebook_columns (class_id, gradebook_id, name, slug, max_score)
  VALUES (v_class, v_gradebook, 'Down path', 'down-path-1', 10) RETURNING id INTO v_col;
  ASSERT (SELECT sort_order FROM public.gradebook_columns WHERE id = v_col)
       = (SELECT max(sort_order) FROM public.gradebook_columns WHERE gradebook_id = v_gradebook),
    'a new column did not get the last sort_order';
  RAISE NOTICE 'step 1 holds: dense sort_order in the current order, old bodies back, old insert path works';
END $$;

\if :rehearsal
DO $$
DECLARE v_expr text;
BEGIN
  SELECT score_expression INTO v_expr FROM public.gradebook_columns WHERE slug = 'down-path-total';
  ASSERT v_expr ~ '^mean\(gradebook_columns\(\["[^"]+"(, "[^"]+")+\]\)\)$',
    format('the rehearsal total was rewritten to %s', v_expr);
  RAISE NOTICE 'rehearsal total now reads %', v_expr;
END $$;
\endif
\endif

-- ============================================================================
-- Step 2: drop the group objects
-- ============================================================================

\if :run_step_2
\echo '=== 2. destructive ==='
-- The table first: its student policy reads gradebook_columns.gradebook_column_group_id.
DROP TABLE public.gradebook_column_groups;
ALTER TABLE public.gradebook_columns
  DROP COLUMN gradebook_column_group_id,
  DROP COLUMN position_in_group;
ALTER TABLE public.gradebooks DROP COLUMN IF EXISTS column_layout_version;
DROP FUNCTION IF EXISTS
  public._broadcast_gradebook_column_group_rows(text, jsonb, boolean),
  public._gradebook_column_group_assert_unreferenced(bigint, text),
  public._gradebook_column_group_for_slug(bigint, bigint, text),
  public._gradebook_column_group_free_slug(bigint, text),
  public._gradebook_column_group_slug_route(bigint, text),
  public._gradebook_columns_apply_positions(bigint, bigint, bigint[]),
  public._gradebook_expression_names_slug(text, text),
  public.broadcast_gradebook_column_groups_change(),
  public.broadcast_gradebook_column_groups_on_column_visibility(),
  public.gradebook_column_assign_group(bigint, bigint, integer, bigint),
  public.gradebook_column_base_group_name(text),
  public.gradebook_column_group_delete(bigint),
  public.gradebook_column_group_display_name(text),
  public.gradebook_column_group_for_slug(bigint, bigint, text),
  public.gradebook_column_group_generated_names(text),
  public.gradebook_column_group_preview_for_slug(bigint, bigint, text),
  public.gradebook_column_group_slugify(text),
  public.gradebook_column_group_unlinked_assignment_name(text),
  public.gradebook_column_groups_before_insert(),
  public.gradebook_column_groups_forbid_rehome(),
  public.gradebook_column_groups_protect_default(),
  public.gradebook_column_groups_protect_referenced_delete(),
  public.gradebook_column_groups_protect_referenced_slug(),
  public.gradebook_column_groups_reorder(bigint, bigint[], bigint),
  public.gradebook_columns_assign_default_group(),
  public.gradebook_columns_merge_group_dependencies(),
  public.gradebook_columns_reorder_in_group(bigint, bigint[], bigint),
  public.gradebook_columns_sync_group_dependents(),
  public.gradebooks_bump_layout_version_if_groups_moved(),
  public.gradebooks_bump_layout_version_if_moved(),
  public.gradebooks_bump_layout_version_new(),
  public.gradebooks_bump_layout_version_old(),
  public.gradebooks_create_default_column_group();
DROP SCHEMA IF EXISTS migration_archive CASCADE;

DO $$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname LIKE '%column_group%' OR p.proname LIKE '%layout_version%');
  ASSERT v_left = 0, format('%s group functions left behind', v_left);
  RAISE NOTICE 'step 2 holds: no group table, column or function is left';
END $$;

\endif

\if :rehearsal
\echo '=== rehearsal complete; rolling back ==='
ROLLBACK;
\else
COMMIT;
\endif
