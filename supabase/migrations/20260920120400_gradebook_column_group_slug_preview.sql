-- A read-only preview of slug routing for the Add Column dialog, with the routing rule moved into
-- one helper that both the preview and the writer call.

-- The routing rule on its own and read-only, so the Add Column dialog can show where a slug will
-- land without creating anything. _gradebook_column_group_for_slug below is the only writer.
CREATE OR REPLACE FUNCTION public._gradebook_column_group_slug_route(
  p_class_id bigint, p_slug text, OUT route_base text, OUT route_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_name text;
  v_assignment public.assignments;
BEGIN
  IF p_slug LIKE 'assignment-%' THEN
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
      v_base := p_slug;
      v_name := public.gradebook_column_group_display_name(p_slug);
    END IF;
  ELSE
    v_base := public.gradebook_column_base_group_name(p_slug);
    v_name := public.gradebook_column_group_display_name(v_base);
  END IF;

  route_base := v_base;
  route_name := v_name;
END $$;

REVOKE ALL ON FUNCTION public._gradebook_column_group_slug_route(bigint, text) FROM PUBLIC, anon, authenticated;

-- Same as 20260920120200, with the routing rule read from the helper above.
CREATE OR REPLACE FUNCTION public._gradebook_column_group_for_slug(
  p_gradebook_id bigint, p_class_id bigint, p_slug text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_name text;
  v_slug text;
  v_suffix integer := 1;
  v_id   bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.gradebooks WHERE id = p_gradebook_id AND class_id = p_class_id) THEN
    RAISE EXCEPTION 'gradebook % does not belong to class %', p_gradebook_id, p_class_id;
  END IF;

  PERFORM pg_advisory_xact_lock(p_gradebook_id);

  SELECT r.route_base, r.route_name INTO v_base, v_name FROM public._gradebook_column_group_slug_route(p_class_id, p_slug) r;

  SELECT g.id INTO v_id
    FROM public.gradebook_column_groups g
   WHERE g.gradebook_id = p_gradebook_id
     AND g.auto_assign_slug_base = v_base
   ORDER BY g.sort_order DESC, g.id DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- A group already holding this slug has opted out of auto-routing, so make a new one beside it.
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.gradebook_column_groups
                 WHERE gradebook_id = p_gradebook_id AND slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base || '-' || v_suffix;
  END LOOP;

  INSERT INTO public.gradebook_column_groups
         (class_id, gradebook_id, name, slug, sort_order, auto_assign_slug_base)
  VALUES (p_class_id, p_gradebook_id, v_name, v_slug,
          COALESCE((SELECT MAX(sort_order) + 1
                      FROM public.gradebook_column_groups
                     WHERE gradebook_id = p_gradebook_id AND NOT is_default), 0),
          v_base)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public._gradebook_column_group_for_slug(bigint, bigint, text) FROM PUBLIC, anon, authenticated;

-- Where a new column with this slug would go: an existing group, or the name of the group that
-- would be created for it. Reads only.
CREATE OR REPLACE FUNCTION public.gradebook_column_group_preview_for_slug(
  p_gradebook_id bigint, p_class_id bigint, p_slug text)
RETURNS TABLE (group_id bigint, group_name text, is_new boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_name text;
BEGIN
  IF NOT public.authorizeforclassgrader(p_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: grader access required for class %', p_class_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gradebooks WHERE id = p_gradebook_id AND class_id = p_class_id) THEN
    RAISE EXCEPTION 'gradebook % does not belong to class %', p_gradebook_id, p_class_id;
  END IF;

  SELECT r.route_base, r.route_name INTO v_base, v_name FROM public._gradebook_column_group_slug_route(p_class_id, p_slug) r;

  RETURN QUERY
    SELECT g.id, g.name, false
      FROM public.gradebook_column_groups g
     WHERE g.gradebook_id = p_gradebook_id
       AND g.auto_assign_slug_base = v_base
     ORDER BY g.sort_order DESC, g.id DESC
     LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::bigint, v_name, true;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.gradebook_column_group_preview_for_slug(bigint, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gradebook_column_group_preview_for_slug(bigint, bigint, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
