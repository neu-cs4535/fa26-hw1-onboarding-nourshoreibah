/**
 * Tests for `weighted_total()`, the score-expression function that turns column-group weights
 * into a course percentage.
 *
 * The point of these tests is not only that the arithmetic is right. It is that there is one
 * copy of it. The last block runs the same fixture through the server-side wiring (mathjs plus
 * `addCommonExpressionFunctions`, the way the Deno recalculator sets it up) and through
 * `evaluateForStudent` (the Expression Builder preview) and asserts both land on the same
 * number, which is only possible while both keep calling `computeWeightedTotal`.
 */
import * as mathjs from "mathjs";
import { minimatch } from "minimatch";

import {
  addCommonExpressionFunctions,
  COMMON_CONTEXT_FUNCTIONS
} from "@/supabase/functions/gradebook-column-recalculate/expression/commonMathFunctions";
import {
  buildWeightedTotalSpecs,
  computeWeightedTotal,
  makeWeightedTotalSource,
  type WeightedTotalColumnInput,
  type WeightedTotalGroupInput,
  type WeightedTotalSpec,
  type WeightedTotalValue
} from "@/supabase/functions/gradebook-column-recalculate/expression/weightedTotal";
import { evaluateForStudent } from "@/lib/gradebookExpressionTester";
import type { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";

const HOMEWORK_GROUP = 10;
const EXAM_GROUP = 20;
const UNWEIGHTED_GROUP = 30;

type Fixture = {
  columns: (WeightedTotalColumnInput & { max_score: number })[];
  groups: WeightedTotalGroupInput[];
  values: Record<string, Partial<WeightedTotalValue>>;
};

/**
 * Homework is 40% of the course, exams 60%, and a third group carries no weight at all.
 * Group scores: homework (80 + 25) / (100 + 50) = 0.7, exams 90 / 100 = 0.9.
 * Course total: 100 * (0.4 * 0.7 + 0.6 * 0.9) = 82.
 */
function baseFixture(): Fixture {
  return {
    columns: [
      { id: 1, slug: "hw-1", gradebook_column_group_id: HOMEWORK_GROUP, weight: null, max_score: 100 },
      { id: 2, slug: "hw-2", gradebook_column_group_id: HOMEWORK_GROUP, weight: null, max_score: 50 },
      { id: 3, slug: "exam-1", gradebook_column_group_id: EXAM_GROUP, weight: null, max_score: 100 },
      { id: 4, slug: "survey-1", gradebook_column_group_id: UNWEIGHTED_GROUP, weight: null, max_score: 100 },
      { id: 5, slug: "course-total", gradebook_column_group_id: UNWEIGHTED_GROUP, weight: null, max_score: 100 }
    ],
    groups: [
      { id: HOMEWORK_GROUP, weight: 0.4 },
      { id: EXAM_GROUP, weight: 0.6 },
      { id: UNWEIGHTED_GROUP, weight: null }
    ],
    values: {
      "hw-1": { score: 80 },
      "hw-2": { score: 25 },
      "exam-1": { score: 90 },
      "survey-1": { score: 0 },
      "course-total": { score: 99 }
    }
  };
}

/** Resolve a fixture the way an evaluator would: specs for one column, values by slug. */
function totalFor(fixture: Fixture, evaluatingColumnId: number | null): number | undefined {
  const specs = buildWeightedTotalSpecs({
    columns: fixture.columns,
    groups: fixture.groups,
    excludeColumnId: evaluatingColumnId
  });
  return computeWeightedTotal(resolve(fixture, specs)());
}

function resolve(fixture: Fixture, specs: WeightedTotalSpec[]) {
  return makeWeightedTotalSource(specs, (slug) => {
    const column = fixture.columns.find((c) => c.slug === slug);
    const value = fixture.values[slug];
    if (!column || !value) return undefined;
    return { max_score: column.max_score, score: null, ...value };
  });
}

describe("computeWeightedTotal", () => {
  test("two weighted groups whose weights sum to 1", () => {
    expect(totalFor(baseFixture(), 5)).toBeCloseTo(82, 10);
  });

  test("a group with no weight contributes nothing, however its columns are scored", () => {
    const fixture = baseFixture();
    fixture.values["survey-1"] = { score: 100 };
    expect(totalFor(fixture, 5)).toBeCloseTo(82, 10);
  });

  test("a within-group weight of 2 makes a column count double", () => {
    const fixture = baseFixture();
    fixture.columns[1].weight = 2;
    // Homework becomes (80 + 2*25) / (100 + 2*50) = 0.65, so 100 * (0.4*0.65 + 0.6*0.9) = 80.
    expect(totalFor(fixture, 5)).toBeCloseTo(80, 10);
  });

  test("an excused column leaves its group entirely rather than scoring zero", () => {
    const fixture = baseFixture();
    fixture.values["hw-2"] = { score: null, is_excused: true, is_missing: true };
    // Homework is now 80 / 100 = 0.8, so 100 * (0.4*0.8 + 0.6*0.9) = 86.
    expect(totalFor(fixture, 5)).toBeCloseTo(86, 10);
  });

  test("a missing column that is not excused counts as zero against its full max_score", () => {
    const fixture = baseFixture();
    fixture.values["hw-2"] = { score: null, is_missing: true };
    // Homework is now 80 / 150, so 100 * (0.4*(80/150) + 0.6*0.9) = 75.333…
    expect(totalFor(fixture, 5)).toBeCloseTo(100 * (0.4 * (80 / 150) + 0.54), 10);
  });

  test("a column nobody has graded yet is skipped, not read as a zero", () => {
    const fixture = baseFixture();
    fixture.values["hw-2"] = { score: null };
    // Homework collapses to hw-1 alone: 100 * (0.4*0.8 + 0.6*0.9) = 86.
    expect(totalFor(fixture, 5)).toBeCloseTo(86, 10);
  });

  test("the column being evaluated never counts itself", () => {
    const fixture = baseFixture();
    // Move the total into the homework group, where leaving it in would corrupt the result.
    fixture.columns[4].gradebook_column_group_id = HOMEWORK_GROUP;
    expect(totalFor(fixture, 5)).toBeCloseTo(82, 10);
    // Without the exclusion the stale 99/100 it already holds drags the homework group up.
    expect(totalFor(fixture, null)).not.toBeCloseTo(82, 5);
  });

  test("no weighted group anywhere returns undefined rather than a hard zero", () => {
    const fixture = baseFixture();
    fixture.groups = fixture.groups.map((g) => ({ ...g, weight: null }));
    expect(totalFor(fixture, 5)).toBeUndefined();
  });

  test("a weighted group with nothing graded drops out and the rest renormalise", () => {
    const fixture = baseFixture();
    delete fixture.values["exam-1"];
    // Only homework contributed, so the student sees their homework percentage, not 0.4 * it.
    expect(totalFor(fixture, 5)).toBeCloseTo(70, 10);
  });

  test("weights that do not sum to 1 still produce a 0..100 percentage", () => {
    const fixture = baseFixture();
    fixture.groups = [
      { id: HOMEWORK_GROUP, weight: 0.2 },
      { id: EXAM_GROUP, weight: 0.3 },
      { id: UNWEIGHTED_GROUP, weight: null }
    ];
    // (0.2*0.7 + 0.3*0.9) / 0.5 = 0.82, the same ratio as 0.4/0.6.
    expect(totalFor(fixture, 5)).toBeCloseTo(82, 10);
  });

  test("a column with no max_score cannot be part of a fraction and is skipped", () => {
    const fixture = baseFixture();
    fixture.columns[1].max_score = 0;
    expect(totalFor(fixture, 5)).toBeCloseTo(86, 10);
  });
});

describe("buildWeightedTotalSpecs", () => {
  test("keeps only columns in weighted groups and defaults a null column weight to 1", () => {
    const fixture = baseFixture();
    const specs = buildWeightedTotalSpecs({ columns: fixture.columns, groups: fixture.groups, excludeColumnId: 5 });
    expect(specs.map((s) => s.column_slug)).toEqual(["hw-1", "hw-2", "exam-1"]);
    expect(specs.every((s) => s.column_weight === 1)).toBe(true);
    expect(specs.map((s) => s.group_weight)).toEqual([0.4, 0.4, 0.6]);
  });

  test("numeric weights arriving as strings are still read as numbers", () => {
    const specs = buildWeightedTotalSpecs({
      columns: [{ id: 1, slug: "hw-1", gradebook_column_group_id: HOMEWORK_GROUP, weight: "2.5" }],
      groups: [{ id: HOMEWORK_GROUP, weight: "0.4" }]
    });
    expect(specs).toEqual([
      { column_id: 1, column_slug: "hw-1", group_id: HOMEWORK_GROUP, group_weight: 0.4, column_weight: 2.5 }
    ]);
  });
});

/**
 * Evaluate an expression the way the Deno recalculator does: import the shared functions into a
 * fresh mathjs instance and rewrite every context-aware call to take `context` as its first
 * argument. This is a copy of the recalculator's AST transform, not of its arithmetic.
 */
function evaluateServerSide(expression: string, fixture: Fixture, evaluatingColumnId: number): unknown {
  const math = mathjs.create(mathjs.all, {});
  const imports: Record<string, (...args: never[]) => unknown> = {};
  addCommonExpressionFunctions(imports, { enforcePrivateCalculationMatch: true, includeSecurityGuards: true });
  math.import(imports, { override: true });

  const instrumented = math.parse(expression).transform((node: mathjs.MathNode) => {
    if (node.type === "FunctionNode") {
      const fn = node as mathjs.FunctionNode;
      if ((COMMON_CONTEXT_FUNCTIONS as readonly string[]).includes(fn.fn.name)) {
        fn.args = [new math.SymbolNode("context"), ...fn.args];
      }
    }
    return node;
  });

  const specs = buildWeightedTotalSpecs({
    columns: fixture.columns,
    groups: fixture.groups,
    excludeColumnId: evaluatingColumnId
  });
  const context = {
    student_id: "alice",
    class_id: 1,
    is_private_calculation: false,
    weighted_total_source: resolve(fixture, specs)
  };
  return instrumented.compile().evaluate({ context });
}

/** The slice of `GradebookController` that `evaluateForStudent` reaches for. */
function createFakeController(fixture: Fixture) {
  const columns = fixture.columns.map((c) => ({ ...c, name: c.slug, score_expression: null, dependencies: null }));
  return {
    class_id: 1,
    get columns() {
      return columns;
    },
    get assignments() {
      return [];
    },
    gradebook_column_groups: {
      get rows() {
        return fixture.groups;
      }
    },
    getGradebookColumnStudent(column_id: number): GradebookColumnStudent | undefined {
      const column = fixture.columns.find((c) => c.id === column_id);
      const value = column ? fixture.values[column.slug] : undefined;
      if (!column || !value) return undefined;
      return {
        id: column_id,
        class_id: 1,
        gradebook_column_id: column_id,
        gradebook_id: 1,
        is_droppable: true,
        is_excused: value.is_excused ?? false,
        is_missing: value.is_missing ?? false,
        is_private: false,
        is_recalculating: false,
        released: true,
        score: value.score ?? null,
        score_override: null,
        score_override_note: null,
        student_id: "alice",
        incomplete_values: null
      } as unknown as GradebookColumnStudent;
    },
    extractAndValidateDependencies(expr: string) {
      const ids = new Set<number>();
      mathjs.parse(expr).traverse((n) => {
        if (n.type !== "FunctionNode") return;
        const fn = n as mathjs.FunctionNode;
        if (fn.fn.name === "weighted_total") {
          for (const spec of buildWeightedTotalSpecs({
            columns: fixture.columns,
            groups: fixture.groups,
            excludeColumnId: 5
          })) {
            ids.add(spec.column_id);
          }
          return;
        }
        if (fn.fn.name !== "gradebook_columns") return;
        const arg = fn.args[0];
        if (!arg || arg.type !== "ConstantNode") return;
        const slug = (arg as mathjs.ConstantNode).value;
        if (typeof slug !== "string") return;
        for (const c of fixture.columns) if (minimatch(c.slug, slug)) ids.add(c.id);
      });
      return ids.size > 0 ? { gradebook_columns: [...ids] } : null;
    }
  };
}

function evaluateClientSide(expression: string, fixture: Fixture, evaluatingColumnId: number): unknown {
  const result = evaluateForStudent({
    math: mathjs,
    gradebookController: createFakeController(fixture) as unknown as Parameters<
      typeof evaluateForStudent
    >[0]["gradebookController"],
    expression,
    studentId: "alice",
    editingColumnId: evaluatingColumnId,
    captureIntermediates: false
  });
  expect(result.parseError).toBeNull();
  expect(result.dependencyError).toBeNull();
  expect(result.evaluation?.error).toBeNull();
  return result.evaluation?.rawResult;
}

describe("weighted_total() agrees across evaluators", () => {
  test.each([
    ["plain", (f: Fixture) => f],
    [
      "with a doubled column",
      (f: Fixture) => {
        f.columns[1].weight = 2;
        return f;
      }
    ],
    [
      "with an excused column",
      (f: Fixture) => {
        f.values["hw-2"] = { score: null, is_excused: true, is_missing: true };
        return f;
      }
    ],
    [
      "with a missing column",
      (f: Fixture) => {
        f.values["hw-2"] = { score: null, is_missing: true };
        return f;
      }
    ]
  ])("server and browser evaluators return the same number (%s)", (_label, mutate) => {
    const fixture = mutate(baseFixture());
    const expected = totalFor(fixture, 5);
    expect(expected).toBeDefined();
    expect(evaluateServerSide("weighted_total()", fixture, 5)).toBeCloseTo(expected!, 10);
    expect(evaluateClientSide("weighted_total()", fixture, 5)).toBeCloseTo(expected!, 10);
  });

  test("the browser evaluator composes weighted_total() with the rest of the language", () => {
    const fixture = baseFixture();
    expect(evaluateClientSide("weighted_total() * 0.5", fixture, 5)).toBeCloseTo(41, 10);
  });

  test("an evaluator that supplies no group weights refuses instead of guessing", () => {
    const math = mathjs.create(mathjs.all, {});
    const imports: Record<string, (...args: never[]) => unknown> = {};
    addCommonExpressionFunctions(imports);
    math.import(imports, { override: true });
    const run = imports as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => run.weighted_total({ student_id: "alice", class_id: 1, is_private_calculation: false })).toThrow(
      "weighted_total() is not available"
    );
  });
});
