// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { all, create } from "npm:mathjs";
import { minimatch } from "npm:minimatch";
import {
  COLUMN_GROUP_FUNCTION,
  columnGroupSlugArgument,
  expandColumnGroup,
  type ColumnGroupMember,
  type ColumnGroupRef
} from "../gradebook-column-recalculate/expression/columnGroups.ts";

type Dependencies = { assignments?: number[]; gradebook_columns?: number[]; gradebook_column_groups?: number[] };

type ColumnRow = {
  id: number;
  slug: string | null;
  score_expression: string | null;
  dependencies: Dependencies | null;
  max_score?: number | null;
  gradebook_column_group_id: number;
  position_in_group: number;
};

type AssignmentRow = { id: number; slug: string | null };

function extractDependenciesFromExpression(
  expr: string,
  availableAssignments: Array<{ id: number; slug: string }>,
  availableColumns: Array<{ id: number; slug: string }>,
  membership: { groups: ColumnGroupRef[]; columns: ColumnGroupMember[]; columnId: number }
): Dependencies | null {
  if (!expr) return null;

  const math = create(all);
  const exprNode = math.parse(expr);
  const dependencies: Record<string, Set<number>> = {};

  exprNode.traverse(
    (node: { type: string; fn?: { name: string }; args?: Array<{ type: string; value?: unknown }> }) => {
      if (node.type === "FunctionNode" && node.fn) {
        const functionName = node.fn.name;
        if (functionName === COLUMN_GROUP_FUNCTION) {
          let groupSlug: string;
          try {
            groupSlug = columnGroupSlugArgument(node);
          } catch {
            return;
          }
          const expanded = expandColumnGroup({
            groupSlug,
            groups: membership.groups,
            columns: membership.columns,
            excludeColumnId: membership.columnId
          });
          if (!expanded) return;
          (dependencies["gradebook_column_groups"] ??= new Set<number>()).add(expanded.groupId);
          for (const id of expanded.columnIds) {
            (dependencies["gradebook_columns"] ??= new Set<number>()).add(id);
          }
          return;
        }
        if (functionName === "assignments" || functionName === "gradebook_columns") {
          const args = node.args ?? [];
          if (args[0]?.type === "ConstantNode") {
            const argVal = args[0].value;
            if (typeof argVal === "string") {
              const pool = functionName === "assignments" ? availableAssignments : availableColumns;
              const matching = pool.filter((d) => minimatch(d.slug, argVal));
              if (matching.length > 0) {
                if (!dependencies[functionName]) dependencies[functionName] = new Set<number>();
                matching.forEach((d) => dependencies[functionName].add(d.id));
              }
            }
          }
        }
      }
    }
  );

  const flattened: Record<string, number[]> = {};
  for (const [fn, ids] of Object.entries(dependencies)) {
    flattened[fn] = Array.from(ids);
  }
  return Object.keys(flattened).length === 0 ? null : (flattened as Dependencies);
}

function normalized(dep: Dependencies | null) {
  if (!dep) return null;
  const copy: Dependencies = {};
  if (dep.assignments) copy.assignments = [...new Set(dep.assignments)].sort((a, b) => a - b);
  if (dep.gradebook_columns) copy.gradebook_columns = [...new Set(dep.gradebook_columns)].sort((a, b) => a - b);
  if (dep.gradebook_column_groups) {
    copy.gradebook_column_groups = [...new Set(dep.gradebook_column_groups)].sort((a, b) => a - b);
  }
  return copy;
}

Deno.serve(async (req) => {
  const headers = req.headers;
  const secret = headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
  if (secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Invalid secret" }), {
      headers: { "Content-Type": "application/json" },
      status: 401
    });
  }

  const body = (await req.json().catch(() => ({}))) as {
    class_id?: number;
    gradebook_id?: number;
    new_column_id?: number;
    exclude_column_id?: number;
  };

  const admin = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let classId = body.class_id as number | undefined;
  let gradebookId = body.gradebook_id as number | undefined;
  const excludeColumnId = body.exclude_column_id ?? body.new_column_id;

  if (!classId || !gradebookId) {
    if (body.new_column_id) {
      const { data: col, error } = await admin
        .from("gradebook_columns")
        .select("id, class_id, gradebook_id")
        .eq("id", body.new_column_id)
        .maybeSingle();
      if (error || !col) {
        return new Response(JSON.stringify({ error: "Unable to load column context" }), {
          headers: { "Content-Type": "application/json" },
          status: 400
        });
      }
      classId = col.class_id;
      gradebookId = col.gradebook_id;
    }
  }

  if (!classId || !gradebookId) {
    return new Response(JSON.stringify({ error: "Missing class_id or gradebook_id" }), {
      headers: { "Content-Type": "application/json" },
      status: 400
    });
  }

  const { data: assignments } = await admin.from("assignments").select("id, slug").eq("class_id", classId);
  const validAssignments: Array<{ id: number; slug: string }> = (assignments || [])
    .filter((a: AssignmentRow) => a.slug !== null)
    .map((a: AssignmentRow) => ({ id: a.id, slug: a.slug as string }));

  // One snapshot of columns and groups, read together before the loop. Membership that changes
  // after this read is merged back in by the BEFORE UPDATE OF dependencies trigger.
  const [{ data: allColumns, error: columnsError }, { data: groups, error: groupsError }] = await Promise.all([
    admin
      .from("gradebook_columns")
      .select("id, slug, score_expression, dependencies, max_score, gradebook_column_group_id, position_in_group")
      .eq("gradebook_id", gradebookId),
    admin.from("gradebook_column_groups").select("id, slug").eq("gradebook_id", gradebookId)
  ]);

  if (columnsError || !allColumns || groupsError || !groups) {
    return new Response(JSON.stringify({ error: "Failed to load gradebook columns" }), {
      headers: { "Content-Type": "application/json" },
      status: 500
    });
  }

  // Log columns with null or zero max_score to help diagnose issues
  const columnsWithInvalidMaxScore = (allColumns as Array<ColumnRow & { max_score: number | null }>).filter(
    (c) => c.max_score === null || c.max_score === 0
  );
  if (columnsWithInvalidMaxScore.length > 0) {
    console.warn(
      `Found ${columnsWithInvalidMaxScore.length} columns with null or zero max_score: ${JSON.stringify(
        columnsWithInvalidMaxScore.map((c) => ({ id: c.id, slug: c.slug, max_score: c.max_score }))
      )}`
    );
  }

  const validColumns: Array<{ id: number; slug: string }> = (allColumns as ColumnRow[])
    .filter((c) => c.slug !== null)
    .map((c) => ({ id: c.id, slug: c.slug as string }));

  const targetColumns = (allColumns as ColumnRow[]).filter(
    (c) => c.score_expression !== null && c.id !== excludeColumnId
  );

  // A group expansion leaves out members that are themselves totals of the group, which it reads
  // from each member's dependencies.gradebook_column_groups. Those group ids come from the
  // expression alone, so compute them for every target first and expand against the result;
  // otherwise a column that just became a total would still be counted by the others.
  const snapshotColumns = (allColumns as ColumnRow[]).map((c) => ({ ...c }));
  const computeDependencies = (col: ColumnRow) =>
    extractDependenciesFromExpression(col.score_expression as string, validAssignments, validColumns, {
      groups,
      columns: snapshotColumns,
      columnId: col.id
    });
  const referencedGroups = new Map(targetColumns.map((c) => [c.id, computeDependencies(c)?.gradebook_column_groups]));
  for (const c of snapshotColumns) {
    if (!referencedGroups.has(c.id)) continue;
    const groupIds = referencedGroups.get(c.id);
    c.dependencies = { ...(c.dependencies ?? {}), gradebook_column_groups: groupIds };
    if (!groupIds) delete c.dependencies.gradebook_column_groups;
  }

  let updated = 0;
  for (const col of targetColumns) {
    const current = normalized(col.dependencies);
    const next = normalized(computeDependencies(col));
    // Skip the write when nothing changed, so untouched columns keep their stored row.
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    if (changed) {
      console.log(
        `Updating dependencies for column ${col.id} (${col.slug}): ${JSON.stringify(current)} -> ${JSON.stringify(next)}`
      );
      const { error: updateError } = await admin
        .from("gradebook_columns")
        .update({ dependencies: next })
        .eq("id", col.id);
      if (updateError) {
        return new Response(JSON.stringify({ error: `Failed to update dependencies for column ${col.id}` }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
      updated++;

      // After updating dependencies, enqueue recalculation for all student rows
      // of this column. This handles the race where scores were set on the new
      // dependent column BEFORE the dependencies were updated — those scores
      // would have been excluded from the calculation.
      const { data: studentRows, error: studentRowsError } = await admin
        .from("gradebook_column_students")
        .select("class_id, gradebook_id, student_id, is_private")
        .eq("gradebook_column_id", col.id);
      if (studentRowsError) {
        return new Response(JSON.stringify({ error: `Failed to load rows for column ${col.id}` }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }

      const { error: enqueueError } = await admin.rpc("enqueue_gradebook_row_recalculation_batch", {
        p_rows:
          studentRows?.map((r) => ({
            class_id: r.class_id,
            gradebook_id: r.gradebook_id,
            student_id: r.student_id,
            is_private: r.is_private,
            source: "deps_update",
            source_column_id: null
          })) ?? []
      });
      if (enqueueError) {
        return new Response(JSON.stringify({ error: `Failed to enqueue recalculation for column ${col.id}` }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }
  }

  return new Response(JSON.stringify({ updated }), {
    headers: { "Content-Type": "application/json" }
  });
});
