// The real recalculator against a fake Supabase client, checked against the same PARITY_CASES
// numbers that tests/unit/gradebook-column-group-expressions.test.ts checks the browser
// evaluators against. Run with --no-check: importing GradebookProcessor pulls in the generated
// SupabaseTypes.d.ts, which deno check rejects.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowsCalculation } from "./GradebookProcessor.ts";
import {
  FIXTURE_GROUPS,
  PARITY_CASES,
  parityCaseColumns,
  parityCaseEvaluatedColumn,
  type ParityCase
} from "./expression/columnGroups.testFixture.ts";

type Row = Record<string, unknown>;

/** Enough of the Supabase client for loadOrderedColumns and the dependency sources. */
function fakeAdminClient(tables: Record<string, Row[]>, gradebookColumnStudents: Row[]) {
  const query = (rows: Row[]) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      range: () => q,
      then: (resolve: (r: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null })
    };
    return q;
  };
  return {
    from: (table: string) => query(tables[table] ?? []),
    rpc: (_name: string, args: { p_offset: number }) =>
      Promise.resolve({ data: args.p_offset === 0 ? gradebookColumnStudents : [], error: null })
  } as unknown as SupabaseClient<Database>;
}

async function evaluateOnServer(parityCase: ParityCase): Promise<number | null> {
  const { expression, values } = parityCase;
  const allColumns = parityCaseColumns(parityCase);
  const evaluated = parityCaseEvaluatedColumn(parityCase);
  const columns = allColumns.map((c) => ({
    ...c,
    class_id: 1,
    gradebook_id: 1,
    name: c.slug,
    released: true,
    instructor_only: false,
    score_expression: c.id === evaluated.id ? expression : (c.score_expression ?? null),
    // The evaluated column depends on every other column: enough to load their values and
    // to order it after any other calculated column.
    dependencies:
      c.id === evaluated.id
        ? { gradebook_columns: allColumns.filter((f) => f.id !== evaluated.id).map((f) => f.id) }
        : (c.dependencies ?? null),
    gradebooks: { expression_prefix: null }
  }));
  const gcs = allColumns.map((c) => ({
    id: 100 + c.id,
    class_id: 1,
    gradebook_id: 1,
    gradebook_column_id: c.id,
    student_id: "alice",
    is_private: false,
    released: true,
    score: values[c.slug]?.score ?? null,
    score_override: null,
    score_override_note: null,
    is_missing: values[c.slug]?.is_missing ?? false,
    is_excused: values[c.slug]?.is_excused ?? false,
    is_droppable: true,
    incomplete_values: null
  }));
  const client = fakeAdminClient({ gradebook_columns: columns, gradebook_column_groups: FIXTURE_GROUPS }, gcs);
  const result = await processGradebookRowsCalculation(client, new Sentry.Scope(), {
    class_id: 1,
    gradebook_id: 1,
    rows: [{ student_id: "alice", is_private: false, gcsRows: gcs }]
  });
  const update = result.get("alice")?.find((u) => u.gradebook_column_id === evaluated.id);
  // No update means the recalculated score equals the stale stored one, which no case expects.
  if (!update) throw new Error(`no update for ${evaluated.slug}`);
  return update.score ?? null;
}

for (const parityCase of PARITY_CASES) {
  Deno.test(`recalculator parity: ${parityCase.label}`, async () => {
    const score = await evaluateOnServer(parityCase);
    if (parityCase.expected === null) assertEquals(score, null);
    else assertAlmostEquals(score as number, parityCase.expected, 1e-9);
  });
}
