import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { all, ConstantNode, create, EvalFunction, FunctionNode, MathNode } from "mathjs";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  addDependencySourceFunctions,
  ContextFunctions,
  ExprDependencyInstance,
  ExpressionContext,
  setRowOverrideValues,
  clearRowOverrideValues
} from "./expression/DependencySource.ts";
import { columnGroupCallSlugs } from "./expression/columnGroups.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";

const DEBUG_LOG = Boolean(Deno.env.get("DEBUG_GRADEBOOK_CALCULATION")) || false;

/** Comma-separated slugs, e.g. `final-course-total`. Read on each check so CLI scripts can set env before processing. */
function getDebugGradebookColumnSlugs(): Set<string> | null {
  const raw = Deno.env.get("DEBUG_GRADEBOOK_COLUMN_SLUG");
  if (!raw?.trim()) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function shouldDebugGradebookColumnSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  const set = getDebugGradebookColumnSlugs();
  return set !== null && set.has(slug);
}

type DebugGcsSnapshot = {
  score: number | null;
  score_override: number | null;
  is_missing: boolean | null;
};

type RowOverrideSnapshot = {
  score: number | null;
  score_override: number | null;
  is_missing: boolean;
};

/** Log dependency rows and expression before evaluating a watched slug (see DEBUG_GRADEBOOK_COLUMN_SLUG). */
function logDebugGradebookColumnPreEval(opts: {
  column: ColumnWithPrefix;
  allColumns: ColumnWithPrefix[];
  class_id: number;
  gradebook_id: number;
  student_id: string;
  is_private: boolean;
  gcsByColumnId: Map<number, DebugGcsSnapshot>;
  studentOverrideMap: Map<string, RowOverrideSnapshot>;
}) {
  const prefix = opts.column.gradebooks?.expression_prefix ?? "";
  const fullExpr = `${prefix}\n${opts.column.score_expression ?? ""}`.trim();
  const depIds = (opts.column.dependencies as { gradebook_columns?: number[] } | null)?.gradebook_columns ?? [];
  const lines: string[] = [
    `[DEBUG_GRADEBOOK_COLUMN_SLUG] pre-eval ${opts.column.slug} id=${opts.column.id} student=${opts.student_id} is_private=${opts.is_private} class_id=${opts.class_id} gradebook_id=${opts.gradebook_id}`,
    `  full_expression: ${JSON.stringify(fullExpr)}`,
    `  gradebook_column dependencies (${depIds.length}):`
  ];
  for (const depId of depIds) {
    const depCol = opts.allColumns.find((c) => c.id === depId);
    const depSlug = depCol?.slug ?? `?id=${depId}`;
    const gcs = opts.gcsByColumnId.get(depId);
    const ov = opts.studentOverrideMap.get(depSlug);
    const gcsPart = gcs
      ? `gcs{score=${gcs.score},override=${gcs.score_override},missing=${gcs.is_missing}}`
      : "gcs{absent in batch — value comes from bulk RPC only}";
    const ovPart = ov
      ? `overrideMap{score=${ov.score},override=${ov.score_override},missing=${ov.is_missing}}`
      : "overrideMap{absent}";
    lines.push(`    - ${depSlug} (id ${depId}): ${ovPart}; ${gcsPart}`);
  }
  const assignDeps = (opts.column.dependencies as { assignments?: number[] } | null)?.assignments ?? [];
  if (assignDeps.length > 0) {
    lines.push(`  assignment dependencies (ids): ${assignDeps.join(", ")}`);
  }
  console.log(lines.join("\n"));
}

function logDebugGradebookColumnPostEval(opts: {
  column: ColumnWithPrefix;
  student_id: string;
  rawResult: unknown;
  nextScore: number | null;
  nextIncomplete: unknown;
  isMissing: boolean;
}) {
  console.log(
    `[DEBUG_GRADEBOOK_COLUMN_SLUG] post-eval ${opts.column.slug} id=${opts.column.id} student=${opts.student_id} raw=${JSON.stringify(opts.rawResult)} nextScore=${opts.nextScore} isMissing=${opts.isMissing} incomplete_values=${JSON.stringify(opts.nextIncomplete)}`
  );
}

type ColumnWithPrefix = Database["public"]["Tables"]["gradebook_columns"]["Row"] & {
  gradebooks: { expression_prefix: string | null };
};

function deepEqualJson(a: unknown, b: unknown): boolean {
  try {
    const norm = (v: unknown) => (v === undefined ? null : v);
    const sa = JSON.stringify(norm(a));
    const sb = JSON.stringify(norm(b));
    return sa === sb;
  } catch {
    return false;
  }
}

function nearlyEqual(a: number | null, b: number | null, eps = 1e-9): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= eps;
}

function isInstructorOnlyColumn(column: ColumnWithPrefix): boolean {
  return Boolean(column.instructor_only);
}

export type RowUpdate = {
  gradebook_column_id: number;
  score?: number | null;
  is_missing?: boolean;
  is_excused?: boolean;
  is_droppable?: boolean;
  released?: boolean;
  score_override_note?: string | null;
  incomplete_values?: unknown | null;
};

function topoSortColumns(columns: ColumnWithPrefix[]): number[] {
  const idSet = new Set(columns.map((c) => c.id));
  const inDegree = new Map<number, number>();
  const graph = new Map<number, Set<number>>();
  for (const id of idSet) {
    inDegree.set(id, 0);
    graph.set(id, new Set());
  }
  for (const c of columns) {
    const cid = c.id;
    const deps = (c.dependencies as { gradebook_columns?: number[] } | null)?.gradebook_columns ?? [];
    for (const dep of deps) {
      if (!idSet.has(dep)) continue;
      graph.get(dep)!.add(cid);
      inDegree.set(cid, (inDegree.get(cid) ?? 0) + 1);
    }
  }
  const queue: number[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const order: number[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of graph.get(id) ?? []) {
      const nd = (inDegree.get(d) ?? 0) - 1;
      inDegree.set(d, nd);
      if (nd === 0) queue.push(d);
    }
  }
  // If cycle, append remaining
  if (order.length < idSet.size) {
    for (const id of idSet) if (!order.includes(id)) order.push(id);
  }
  return order;
}

type OrderedColumnGroup = { id: number; slug: string; sort_order: number };

async function loadOrderedColumns(
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope,
  gradebook_id: number
): Promise<{ columns: ColumnWithPrefix[]; groups: OrderedColumnGroup[] } | null> {
  const [{ data: columns, error: colsError }, { data: groups, error: groupsError }] = await Promise.all([
    adminSupabase
      .from("gradebook_columns")
      .select("*, gradebooks!gradebook_columns_gradebook_id_fkey(expression_prefix)")
      .eq("gradebook_id", gradebook_id),
    adminSupabase.from("gradebook_column_groups").select("id, slug, sort_order").eq("gradebook_id", gradebook_id)
  ]);
  if (colsError || !columns) {
    Sentry.captureException(colsError || new Error("Missing columns"), scope);
    return null;
  }
  if (groupsError || !groups) {
    Sentry.captureException(groupsError ?? new Error("Missing gradebook column groups"), scope);
    return null;
  }
  const groupSortOrder = new Map(groups.map((g) => [g.id, g.sort_order]));
  const sortedColumns = [...(columns as unknown as ColumnWithPrefix[])].sort((a, b) => {
    const groupOrderA = groupSortOrder.get(a.gradebook_column_group_id) ?? Number.MAX_SAFE_INTEGER;
    const groupOrderB = groupSortOrder.get(b.gradebook_column_group_id) ?? Number.MAX_SAFE_INTEGER;
    if (groupOrderA !== groupOrderB) return groupOrderA - groupOrderB;
    if (a.gradebook_column_group_id !== b.gradebook_column_group_id)
      return a.gradebook_column_group_id - b.gradebook_column_group_id;
    if (a.position_in_group !== b.position_in_group) return a.position_in_group - b.position_in_group;
    return a.id - b.id;
  });
  return { columns: sortedColumns, groups };
}

type GCSRowsType = Pick<
  Database["public"]["Tables"]["gradebook_column_students"]["Row"],
  | "id"
  | "gradebook_column_id"
  | "is_missing"
  | "is_excused"
  | "is_droppable"
  | "score_override"
  | "score"
  | "released"
  | "score_override_note"
  | "incomplete_values"
>[];
export async function processGradebookRowsCalculation(
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope,
  {
    class_id,
    gradebook_id,
    rows
  }: {
    class_id: number;
    gradebook_id: number;
    rows: {
      student_id: string;
      is_private: boolean;
      gcsRows: GCSRowsType;
    }[];
  }
): Promise<Map<string, RowUpdate[]>> {
  const loaded = await loadOrderedColumns(adminSupabase, scope, gradebook_id);
  if (!loaded) return new Map();
  const { columns, groups } = loaded;

  const math = create(all, {});
  // Build keys for all students in this batch
  const keys: ExprDependencyInstance[] = [];
  for (const c of columns) {
    const deps = (c.dependencies as { gradebook_columns?: number[]; assignments?: number[] } | null) || {};
    for (const r of rows) {
      if (deps.gradebook_columns) {
        for (const dep of deps.gradebook_columns) keys.push({ class_id, student_id: r.student_id, key: String(dep) });
      }
      if (deps.assignments) {
        for (const dep of deps.assignments) keys.push({ class_id, student_id: r.student_id, key: String(dep) });
      }
    }
  }

  if (DEBUG_LOG) {
    console.log(`Working on ${keys.length} keys for gradebook ${gradebook_id}`);
  }
  await addDependencySourceFunctions({ math, keys, supabase: adminSupabase });

  const compiledById = new Map<number, EvalFunction>();
  for (const c of columns as unknown as ColumnWithPrefix[]) {
    if (!c.score_expression) continue;
    const theScoreExpression = (c.gradebooks.expression_prefix ?? "") + "\n" + c.score_expression;
    let expr: MathNode;
    try {
      expr = math.parse(theScoreExpression).transform((node: MathNode) => {
        const slugs = columnGroupCallSlugs(node, { groups, columns }, c.id);
        if (!slugs) return node;
        return new math.FunctionNode("gradebook_columns", [
          new math.ArrayNode(slugs.map((slug) => new math.ConstantNode(slug)))
        ]);
      });
    } catch (e) {
      // Surface the error on this column's cells instead of failing the whole batch.
      const error = e instanceof Error ? e : new Error(String(e));
      Sentry.captureException(error, scope);
      compiledById.set(c.id, {
        evaluate: () => {
          throw error;
        }
      } as unknown as EvalFunction);
      continue;
    }
    const instrumented = expr.transform((node: MathNode) => {
      if (node.type === "FunctionNode") {
        const fn = node as FunctionNode;
        if (ContextFunctions.includes(fn.fn.name)) {
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("context"));
          newArgs.push(...fn.args);
          fn.args = newArgs;
          return node;
        }
        if ((fn.fn.name === "assignments" || fn.fn.name === "gradebook_columns") && fn.args.length > 0) {
          const argType = fn.args[0].type;
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("context"));
          if (argType === "ConstantNode") {
            const argVal = (fn.args[0] as ConstantNode).value;
            if (typeof argVal === "string" && (argVal as string).includes("*")) {
              const batchDependencySourceMap = (math as unknown as Record<string, unknown>)
                ._batchDependencySourceMap as Record<
                string,
                { expandKey: (params: { key: string; class_id: number }) => string[] }
              >;
              if (batchDependencySourceMap && batchDependencySourceMap[fn.fn.name]) {
                const dependencySource = batchDependencySourceMap[fn.fn.name];
                const expandedKeys = dependencySource.expandKey({ key: argVal, class_id });
                newArgs.push(new math.ArrayNode(expandedKeys.map((key: string) => new math.ConstantNode(key))));
              } else {
                newArgs.push(...fn.args);
              }
            } else {
              newArgs.push(...fn.args);
            }
          } else {
            newArgs.push(...fn.args);
          }
          fn.args = newArgs;
        }
      }
      return node;
    });
    if (DEBUG_LOG) {
      console.log(`Compiled expression for column ${c.id} ${c.slug} ${c.score_expression}: ${instrumented.toString()}`);
    }
    compiledById.set(c.id, instrumented.compile());
  }

  const order = topoSortColumns(columns as unknown as ColumnWithPrefix[]);
  const result = new Map<string, RowUpdate[]>();

  for (const { student_id, gcsRows, is_private } of rows) {
    const gcsByColumnId = new Map<number, GCSRowsType[number]>();
    for (const r of gcsRows) {
      gcsByColumnId.set(r.gradebook_column_id, r);
    }
    const studentOverrideMap = new Map<
      string,
      {
        class_id: number;
        created_at: string;
        gradebook_column_id: number;
        gradebook_id: number;
        id: number;
        incomplete_values: Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"];
        is_droppable: boolean;
        is_excused: boolean;
        is_missing: boolean;
        is_private: boolean;
        released: boolean;
        score: number | null;
        score_override: number | null;
        score_override_note: string | null;
        student_id: string;
        column_slug: string;
        max_score: number;
      }
    >();
    setRowOverrideValues(
      class_id,
      student_id,
      is_private,
      studentOverrideMap as unknown as Map<string, import("./expression/types.d.ts").GradebookColumnStudentWithMaxScore>
    );

    const updates: RowUpdate[] = [];
    for (const columnId of order) {
      const column = columns.find((c) => c.id === columnId)!;
      const current = gcsByColumnId.get(columnId);
      const slug = column.slug;
      const context: ExpressionContext = {
        student_id,
        incomplete_values: {},
        is_private_calculation: is_private,
        incomplete_values_policy: "report_only",
        scope,
        class_id
      };

      let nextScore: number | null = null;
      let isMissing = false;
      let nextIncomplete: unknown | null = null;
      let nextReleased = false;

      // Do not put a public snapshot in studentOverrideMap: gradebook_columns(...) must resolve
      // instructor-only deps via base values (private row), not shadow them with the frozen student row.
      if (isInstructorOnlyColumn(column) && !is_private) {
        continue;
      }

      if (column.score_expression) {
        try {
          const compiled = compiledById.get(columnId)!;
          if (shouldDebugGradebookColumnSlug(slug)) {
            const gcsSnap = new Map<number, DebugGcsSnapshot>();
            for (const [id, r] of gcsByColumnId) {
              gcsSnap.set(id, {
                score: r.score ?? null,
                score_override: r.score_override ?? null,
                is_missing: r.is_missing ?? null
              });
            }
            const ovSnap = new Map<string, RowOverrideSnapshot>();
            for (const [s, v] of studentOverrideMap) {
              ovSnap.set(s, {
                score: v.score,
                score_override: v.score_override,
                is_missing: v.is_missing
              });
            }
            logDebugGradebookColumnPreEval({
              column: column as unknown as ColumnWithPrefix,
              allColumns: columns as unknown as ColumnWithPrefix[],
              class_id,
              gradebook_id,
              student_id,
              is_private,
              gcsByColumnId: gcsSnap,
              studentOverrideMap: ovSnap
            });
          }
          const resultVal = compiled.evaluate({ context });
          if (DEBUG_LOG) {
            console.log(
              `Result for column ${column.slug} ${column.id} ${column.score_expression}: ${JSON.stringify(resultVal, null, 2)}`
            );
          }
          if (
            typeof resultVal === "object" &&
            resultVal !== null &&
            "entries" in (resultVal as Record<string, unknown>)
          ) {
            const lastEntry = (resultVal as { entries: unknown[] }).entries[
              (resultVal as { entries: unknown[] }).entries.length - 1
            ];
            if (lastEntry === undefined || lastEntry === null) {
              nextScore = null;
            } else {
              nextScore = Number(lastEntry);
            }
          } else {
            nextScore = resultVal === undefined || resultVal === null ? null : Number(resultVal);
          }
          // console.log(`Next score for column ${column.slug}: ${nextScore}`);
          const depObj = (column.dependencies as Record<string, unknown>) || {};
          const hasDeps = Object.keys(depObj).length > 0;
          isMissing = !hasDeps && nextScore === null;
          nextIncomplete =
            context.incomplete_values && Object.keys(context.incomplete_values).length === 0
              ? null
              : context.incomplete_values;
          const assigns = (column.dependencies as { assignments?: number[] } | null)?.assignments ?? null;
          if (assigns && Array.isArray(assigns)) {
            const hasUnreleased =
              (context.incomplete_values as { not_released?: { gradebook_columns?: string[] } } | undefined)
                ?.not_released?.gradebook_columns?.length ?? 0;
            nextReleased = hasUnreleased === 0 && !isMissing;
          } else {
            nextReleased = (column.released ?? false) as boolean;
          }
          if (shouldDebugGradebookColumnSlug(slug)) {
            logDebugGradebookColumnPostEval({
              column: column as unknown as ColumnWithPrefix,
              student_id,
              rawResult: resultVal,
              nextScore,
              nextIncomplete,
              isMissing
            });
          }
        } catch (e) {
          if (DEBUG_LOG) {
            console.log(`Error evaluating column ${column.slug} ${column.id} ${column.score_expression}: ${e}`);
          }
          if (shouldDebugGradebookColumnSlug(slug)) {
            console.log(
              `[DEBUG_GRADEBOOK_COLUMN_SLUG] ERROR ${slug} id=${column.id} student=${student_id}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          Sentry.captureException(e, scope);
          nextScore = null;
          isMissing = true;
          nextIncomplete = null;
          nextReleased = false;
        }
      } else {
        // Skip manual columns
        continue;
      }

      if (DEBUG_LOG) {
        console.log(`nextScore: ${nextScore}`);
      }
      const overrideScore = (current?.score_override as number | null) ?? null;
      if (overrideScore !== null) {
        isMissing = false;
      }
      const curScore = (current?.score as number | null) ?? null;
      if (DEBUG_LOG) {
        console.log(`curScore: ${curScore}`);
      }
      const curMissing = (current?.is_missing as boolean) ?? false;
      const curReleased = (current?.released as boolean) ?? false;
      const curIncomplete = current?.incomplete_values ?? null;
      const changed =
        !nearlyEqual(nextScore, curScore) ||
        isMissing !== curMissing ||
        nextReleased !== curReleased ||
        !deepEqualJson(nextIncomplete, curIncomplete);
      if (changed) {
        if (DEBUG_LOG) {
          console.log(`Adding update GCID: ${columnId}, nextScore: ${nextScore}, curScore: ${curScore}`);
        }
        updates.push({
          gradebook_column_id: columnId,
          score: nextScore,
          is_missing: isMissing,
          released: nextReleased,
          incomplete_values: nextIncomplete
        });
      }

      const maxScore = (column as { max_score: number | null }).max_score ?? 0;
      const valueForSlug = {
        class_id,
        created_at: new Date().toISOString(),
        gradebook_column_id: columnId,
        gradebook_id,
        id: (gcsByColumnId.get(columnId)?.id as number) ?? 0,
        incomplete_values:
          nextIncomplete as unknown as Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"],
        is_droppable: (current?.is_droppable as boolean) ?? false,
        is_excused: (current?.is_excused as boolean) ?? false,
        is_missing: isMissing,
        is_private,
        released: nextReleased,
        score:
          current?.score_override !== null && current?.score_override !== undefined
            ? current?.score_override
            : nextScore,
        score_override: (current?.score_override as number | null) ?? null,
        score_override_note: (current?.score_override_note as string | null) ?? null,
        student_id,
        column_slug: slug,
        max_score: maxScore
      };
      studentOverrideMap.set(slug, valueForSlug);
    }

    clearRowOverrideValues(class_id, student_id, is_private);
    result.set(student_id, updates);
  }
  if (DEBUG_LOG) {
    console.log(`Finished working on ${rows.length} students for gradebook ${gradebook_id}, results: ${result.size}`);
    console.log(JSON.stringify(result.values(), null, 2));
  }
  return result;
}
