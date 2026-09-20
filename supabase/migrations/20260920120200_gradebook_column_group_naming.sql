-- Make the backfill's corrections into rules.
--
-- 20260920120000 corrected four things about the grouping it inherited, but it corrected them in
-- the data, once. A course created afterwards got the uncorrected grouping back: a pair of
-- columns called "AI Usage Log 1" and "AI Usage Log 2" landed under a header reading "Ai" again,
-- because that is what the slug base capitalises to, and a manually created column slugged
-- `assignment-final` landed under a second header reading "Assignment".
--
-- Fixing data and leaving the rule alone is how the original problem lasted as long as it did. So:
--
--   * assignment-backed columns are routed by what kind of assignment they belong to, read from
--     the assignments row rather than from the second dash-separated token of a slug;
--   * a column whose slug claims an assignment that does not exist gets its own group, on the
--     stated policy that a slug is not evidence;
--   * a group's header is derived from what the instructor called the columns in it, and is kept
--     up to date as columns come and go, until an instructor renames it by hand.

-- ---------------------------------------------------------------------------------------------
-- 1. An instructor's rename wins
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.gradebook_column_groups
  ADD COLUMN IF NOT EXISTS name_is_auto boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.gradebook_column_groups.name_is_auto IS
  'True while the name is derived from the member column names. Set false by any hand edit, after which the derivation leaves it alone.';

-- Groups that already exist were named by the backfill, which derived them the same way.
UPDATE public.gradebook_column_groups SET name_is_auto = true WHERE name_is_auto IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. Deriving a header from the columns under it
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.gradebook_column_group_common_name(p_group_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- The longest prefix every member name starts with. Comparing the lexicographic smallest and
  -- largest is enough: anything both of those start with, everything between them starts with
  -- too. A group of one is simply described by the column in it.
  WITH names AS (
    SELECT name FROM public.gradebook_columns WHERE gradebook_column_group_id = p_group_id
  ),
  b AS (SELECT min(name) AS lo, max(name) AS hi, count(*) AS cnt FROM names),
  l AS (
    SELECT b.lo, b.cnt,
           (SELECT COALESCE(max(i), 0)
              FROM generate_series(1, least(length(b.lo), length(b.hi))) AS i
             WHERE left(b.lo, i) = left(b.hi, i)) AS lcp
      FROM b
  )
  SELECT CASE
           WHEN l.cnt = 1 THEN NULLIF(btrim(l.lo), '')
           WHEN l.cnt >= 2 AND l.lcp >= 3
             THEN NULLIF(btrim(regexp_replace(left(l.lo, l.lcp),
                    '[[:space:][:punct:]]*[0-9]*[[:space:][:punct:]]*$', '')), '')
           ELSE NULL
         END
    FROM l;
$$;

CREATE OR REPLACE FUNCTION public.gradebook_column_group_refresh_name(p_group_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.gradebook_column_groups;
  v_derived text;
BEGIN
  SELECT * INTO v_group FROM public.gradebook_column_groups WHERE id = p_group_id;
  IF v_group.id IS NULL OR v_group.is_default OR NOT v_group.name_is_auto THEN
    RETURN;
  END IF;

  -- Groups that stand for a category of assignment keep their category name. A course with one
  -- lab so far should not get a header reading "Lab 1"; it gets a second lab eventually.
  IF v_group.slug IN ('assignment-lab', 'assignment-individual', 'assignment-group') THEN
    RETURN;
  END IF;

  v_derived := public.gradebook_column_group_common_name(p_group_id);

  IF v_derived IS NOT NULL AND v_derived IS DISTINCT FROM v_group.name THEN
    UPDATE public.gradebook_column_groups
       SET name = v_derived
     WHERE id = p_group_id AND name_is_auto;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.gradebook_columns_refresh_group_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.gradebook_column_group_id IS NOT NULL THEN
    PERFORM public.gradebook_column_group_refresh_name(NEW.gradebook_column_group_id);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.gradebook_column_group_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.gradebook_column_group_id IS DISTINCT FROM NEW.gradebook_column_group_id) THEN
    PERFORM public.gradebook_column_group_refresh_name(OLD.gradebook_column_group_id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS gradebook_columns_refresh_group_name_tr ON public.gradebook_columns;
CREATE TRIGGER gradebook_columns_refresh_group_name_tr
  AFTER INSERT OR UPDATE OF name, gradebook_column_group_id OR DELETE ON public.gradebook_columns
  FOR EACH ROW EXECUTE FUNCTION public.gradebook_columns_refresh_group_name();

-- A hand edit to the name turns the derivation off for that group, permanently.
CREATE OR REPLACE FUNCTION public.gradebook_column_groups_mark_manual_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- pg_trigger_depth() > 1 means we are inside gradebook_column_group_refresh_name, which is the
  -- derivation itself and must not count as a hand edit.
  IF NEW.name IS DISTINCT FROM OLD.name AND pg_trigger_depth() <= 1 THEN
    NEW.name_is_auto := false;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gradebook_column_groups_mark_manual_name_tr ON public.gradebook_column_groups;
CREATE TRIGGER gradebook_column_groups_mark_manual_name_tr
  BEFORE UPDATE OF name ON public.gradebook_column_groups
  FOR EACH ROW EXECUTE FUNCTION public.gradebook_column_groups_mark_manual_name();

-- ---------------------------------------------------------------------------------------------
-- 3. Routing: read the assignment, not the slug
-- ---------------------------------------------------------------------------------------------
--
-- The old heuristic decided what kind of assignment a column belonged to by taking the second
-- dash-separated token of its slug, which meant `assignment-final` (two tokens) missed the branch
-- entirely and fell back to the bare base `assignment`. public.assignments already records the
-- answer: minutes_due_after_lab is non-null exactly for labs, and group_config says whether it is
-- a group assignment.
--
-- A slug of the form `assignment-<x>` where no assignment `<x>` exists is not an assignment
-- column. It gets its own group, and the naming rules above then title it after the column.

CREATE OR REPLACE FUNCTION public.gradebook_column_group_for_slug(
  p_gradebook_id bigint, p_class_id bigint, p_slug text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_name text;
  v_id   bigint;
  v_assignment public.assignments;
BEGIN
  IF p_slug LIKE 'assignment-%' THEN
    -- Strip the prefix and ask whether that assignment is real. Code-walk columns are slugged
    -- `assignment-<slug>-code-walk`, so try that shape too and file them with their assignment.
    SELECT a.* INTO v_assignment
      FROM public.assignments a
     WHERE a.class_id = p_class_id
       AND a.slug IN (
         substring(p_slug FROM 12),
         regexp_replace(substring(p_slug FROM 12), '-code-walk$', '')
       )
     ORDER BY length(a.slug) DESC
     LIMIT 1;

    IF v_assignment.id IS NOT NULL THEN
      IF v_assignment.minutes_due_after_lab IS NOT NULL THEN
        v_base := 'assignment-lab';
        v_name := 'Labs';
      ELSIF v_assignment.group_config <> 'individual' THEN
        v_base := 'assignment-group';
        v_name := 'Group Assignments';
      ELSE
        v_base := 'assignment-individual';
        v_name := 'Assignments';
      END IF;
    ELSE
      -- Looks assignment-backed, is not. Its own group, named after the column by the rules above.
      v_base := p_slug;
      v_name := public.gradebook_column_group_display_name(p_slug);
    END IF;
  ELSE
    v_base := public.gradebook_column_base_group_name(p_slug);
    v_name := public.gradebook_column_group_display_name(v_base);
  END IF;

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
  VALUES (p_class_id, p_gradebook_id, v_name, v_base,
          COALESCE((SELECT MAX(sort_order) + 1
                      FROM public.gradebook_column_groups
                     WHERE gradebook_id = p_gradebook_id AND NOT is_default), 0),
          v_base)
  ON CONFLICT (gradebook_id, slug) DO UPDATE SET slug = EXCLUDED.slug
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Bring existing groups up to the same naming
-- ---------------------------------------------------------------------------------------------
--
-- The backfill in 20260920120000 already did this for gradebooks that existed then. This catches
-- any created between that migration and this one.

DO $$
DECLARE
  g record;
BEGIN
  FOR g IN SELECT id FROM public.gradebook_column_groups WHERE NOT is_default AND name_is_auto
  LOOP
    PERFORM public.gradebook_column_group_refresh_name(g.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
