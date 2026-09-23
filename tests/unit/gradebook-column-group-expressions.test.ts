import * as mathjs from "mathjs";
import { minimatch } from "minimatch";

import {
  COLUMN_GROUP_FUNCTION,
  columnGroupCallSlugs,
  expandColumnGroup
} from "@/supabase/functions/gradebook-column-recalculate/expression/columnGroups";
import {
  EMPTY_GROUP,
  FIXTURE_COLUMNS,
  FIXTURE_GROUPS,
  HOMEWORK_GROUP,
  PARITY_CASES,
  TOTAL_COLUMN,
  baseValues,
  type FixtureValue
} from "@/supabase/functions/gradebook-column-recalculate/expression/columnGroups.testFixture";
import { GradebookController } from "@/hooks/useGradebook";
import { GradebookWhatIfController } from "@/hooks/useGradebookWhatIf";
import { evaluateForStudent } from "@/lib/gradebookExpressionTester";
import type { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ rpc: () => new Promise(() => {}) })
}));
jest.mock("@/hooks/useCourseController", () => ({ useCourseController: jest.fn() }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { create: jest.fn() } }));

const ALL_COLUMNS = [...FIXTURE_COLUMNS, TOTAL_COLUMN];

type ColumnRow = (typeof ALL_COLUMNS)[number] & {
  name: string;
  class_id: number;
  gradebook_id: number;
  score_expression: string | null;
  dependencies: { gradebook_columns?: number[]; gradebook_column_groups?: number[] } | null;
};

/**
 * Just enough of GradebookController for the real extractAndValidateDependencies, the
 * expression tester and the what-if controller. The extractor is borrowed from the real
 * class so these tests exercise the code instructors save with.
 */
function createFakeController(opts: {
  values: Record<string, FixtureValue>;
  totalExpression?: string | null;
  totalDependencies?: ColumnRow["dependencies"];
  extraColumns?: ColumnRow[];
}) {
  const columns: ColumnRow[] = [
    ...ALL_COLUMNS.map((c) => ({
      ...c,
      name: c.slug,
      class_id: 1,
      gradebook_id: 1,
      score_expression: c.id === TOTAL_COLUMN.id ? (opts.totalExpression ?? null) : null,
      dependencies: c.id === TOTAL_COLUMN.id ? (opts.totalDependencies ?? null) : null
    })),
    ...(opts.extraColumns ?? [])
  ];
  const fake = {
    class_id: 1,
    columns,
    assignments: [],
    _assignments: [],
    gradebook_columns: { rows: columns },
    gradebook_column_groups: { rows: FIXTURE_GROUPS },
    _getSharedMath: () => mathjs,
    getGradebookColumn: (id: number) => columns.find((c) => c.id === id),
    getGradebookColumnStudent(column_id: number): GradebookColumnStudent | undefined {
      const column = columns.find((c) => c.id === column_id);
      const value = column ? opts.values[column.slug] : undefined;
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
        score: value.score,
        score_override: null,
        score_override_note: null,
        student_id: "alice",
        incomplete_values: null
      } as unknown as GradebookColumnStudent;
    },
    subscribeColumnsForStudent: () => () => {},
    extractAndValidateDependencies(expr: string, column_id: number) {
      return GradebookController.prototype.extractAndValidateDependencies.call(fake, expr, column_id);
    }
  };
  return fake;
}

function evaluateInTester(expression: string, values: Record<string, FixtureValue>) {
  const result = evaluateForStudent({
    math: mathjs,
    gradebookController: createFakeController({ values }) as unknown as Parameters<
      typeof evaluateForStudent
    >[0]["gradebookController"],
    expression,
    studentId: "alice",
    editingColumnId: TOTAL_COLUMN.id,
    captureIntermediates: true
  });
  expect(result.parseError).toBeNull();
  expect(result.dependencyError).toBeNull();
  expect(result.evaluation?.error).toBeNull();
  return result;
}

function evaluateInWhatIf(expression: string, values: Record<string, FixtureValue>) {
  const deps = createFakeController({ values }).extractAndValidateDependencies(expression, TOTAL_COLUMN.id);
  const controller = new GradebookWhatIfController(
    createFakeController({
      values,
      totalExpression: expression,
      totalDependencies: deps
    }) as unknown as ConstructorParameters<typeof GradebookWhatIfController>[0],
    "alice",
    {} as unknown as ConstructorParameters<typeof GradebookWhatIfController>[2]
  );
  return controller.getGrade(TOTAL_COLUMN.id)?.report_only;
}

const asNullable = (v: unknown) => (v === undefined || v === null ? null : Number(v));

function expectResult(received: unknown, expected: number | null) {
  if (expected === null) expect(asNullable(received)).toBeNull();
  else expect(asNullable(received)).toBeCloseTo(expected, 9);
}

describe("expandColumnGroup", () => {
  test("returns members in position_in_group order, whatever order the rows arrive in", () => {
    expect(expandColumnGroup({ groupSlug: "hw", groups: FIXTURE_GROUPS, columns: ALL_COLUMNS })).toEqual({
      groupId: HOMEWORK_GROUP,
      columnIds: [1, 2, 3, 4],
      slugs: ["hw-1", "hw-2", "hw-3", "hw-total"]
    });
  });

  test("breaks position ties by id", () => {
    const columns = [
      { id: 9, slug: "b", gradebook_column_group_id: 1, position_in_group: 0 },
      { id: 8, slug: "a", gradebook_column_group_id: 1, position_in_group: 0 }
    ];
    expect(expandColumnGroup({ groupSlug: "g", groups: [{ id: 1, slug: "g" }], columns })?.slugs).toEqual(["a", "b"]);
  });

  test("leaves out the column being evaluated", () => {
    expect(
      expandColumnGroup({
        groupSlug: "hw",
        groups: FIXTURE_GROUPS,
        columns: ALL_COLUMNS,
        excludeColumnId: TOTAL_COLUMN.id
      })?.slugs
    ).toEqual(["hw-1", "hw-2", "hw-3"]);
  });

  test("an unknown slug is undefined, not an empty group", () => {
    expect(expandColumnGroup({ groupSlug: "nope", groups: FIXTURE_GROUPS, columns: ALL_COLUMNS })).toBeUndefined();
  });

  test("a group with no columns expands to nothing", () => {
    expect(expandColumnGroup({ groupSlug: "empty", groups: FIXTURE_GROUPS, columns: ALL_COLUMNS })).toEqual({
      groupId: EMPTY_GROUP,
      columnIds: [],
      slugs: []
    });
  });
});

describe("columnGroupCallSlugs", () => {
  const membership = { groups: FIXTURE_GROUPS, columns: ALL_COLUMNS };

  test("ignores every node that is not a group call", () => {
    expect(columnGroupCallSlugs(mathjs.parse('gradebook_columns("hw-*")'), membership)).toBeNull();
    expect(columnGroupCallSlugs(mathjs.parse("1 + 2"), membership)).toBeNull();
  });

  test("accepts only a single string literal", () => {
    for (const expr of [
      `${COLUMN_GROUP_FUNCTION}(hw)`,
      `${COLUMN_GROUP_FUNCTION}()`,
      `${COLUMN_GROUP_FUNCTION}("hw", "exams")`,
      `${COLUMN_GROUP_FUNCTION}(1)`
    ]) {
      expect(() => columnGroupCallSlugs(mathjs.parse(expr), membership)).toThrow("takes one group slug in quotes");
    }
  });

  test("names an unknown slug the same way an unknown column is named", () => {
    expect(() => columnGroupCallSlugs(mathjs.parse(`${COLUMN_GROUP_FUNCTION}("nope")`), membership)).toThrow(
      "Invalid dependency: nope for function gradebook_column_group"
    );
  });
});

describe("extractAndValidateDependencies with gradebook_column_group()", () => {
  test("records the group id and its members, never the column being defined", () => {
    const deps = createFakeController({ values: baseValues() }).extractAndValidateDependencies(
      'mean(gradebook_column_group("hw")) + gradebook_columns("exam-1").score',
      TOTAL_COLUMN.id
    );
    expect(deps).toEqual({
      gradebook_column_groups: [HOMEWORK_GROUP],
      gradebook_columns: [1, 2, 3, 5]
    });
  });

  test("an empty group still records the group, so later members trigger a recalculation", () => {
    const deps = createFakeController({ values: baseValues() }).extractAndValidateDependencies(
      'sum(gradebook_column_group("empty"))',
      TOTAL_COLUMN.id
    );
    expect(deps).toEqual({ gradebook_column_groups: [EMPTY_GROUP] });
  });

  test("an unknown slug is a dependency error", () => {
    expect(() =>
      createFakeController({ values: baseValues() }).extractAndValidateDependencies(
        'mean(gradebook_column_group("nope"))',
        TOTAL_COLUMN.id
      )
    ).toThrow("Invalid dependency: nope for function gradebook_column_group");
  });

  test("a cycle through a group is still detected", () => {
    // exam-2 reads hw-total and sits in the homework group, so hw-total totalling that group reads itself.
    const examTwo: ColumnRow = {
      id: 6,
      slug: "exam-2",
      name: "exam-2",
      class_id: 1,
      gradebook_id: 1,
      gradebook_column_group_id: HOMEWORK_GROUP,
      position_in_group: 4,
      max_score: 100,
      score_expression: 'gradebook_columns("hw-total")',
      dependencies: { gradebook_columns: [TOTAL_COLUMN.id] }
    };
    const controller = createFakeController({ values: baseValues(), extraColumns: [examTwo] });
    expect(() =>
      controller.extractAndValidateDependencies('mean(gradebook_column_group("hw"))', TOTAL_COLUMN.id)
    ).toThrow("Cycle detected");
  });
});

describe("gradebook_column_group() agrees across evaluators", () => {
  // The Deno recalculator test (columnGroups.test.ts) asserts the same PARITY_CASES numbers
  // against processGradebookRowsCalculation.
  test.each(PARITY_CASES.map((c) => [c.label, c] as const))("%s", (_label, parityCase) => {
    const tester = evaluateInTester(parityCase.expression, parityCase.values);
    expectResult(tester.evaluation?.rawResult, parityCase.expected);
    expectResult(evaluateInWhatIf(parityCase.expression, parityCase.values), parityCase.expected);
  });

  test("a group call matches the equivalent explicit list of columns", () => {
    const values = baseValues();
    const viaGroup = evaluateInTester('mean(drop_lowest(gradebook_column_group("hw"), 1))', values);
    const viaGlob = evaluateInTester('mean(drop_lowest(gradebook_columns("hw-[123]"), 1))', values);
    expect(viaGroup.evaluation?.rawResult).toEqual(viaGlob.evaluation?.rawResult);
  });

  test("hover spans point at the group call the instructor typed", () => {
    const expression = 'mean(gradebook_column_group("hw"))';
    const result = evaluateInTester(expression, baseValues());
    const call = result.evaluation?.intermediates.find((iv) => iv.source === 'gradebook_column_group("hw")');
    expect(call).toBeDefined();
    expect(expression.slice(call!.start, call!.end)).toBe('gradebook_column_group("hw")');
    const outer = result.evaluation?.intermediates.find((iv) => iv.source === expression);
    expect(outer?.start).toBe(0);
  });

  test("what-if treats a group the student cannot see as empty instead of failing", () => {
    const expression = 'sum(gradebook_column_group("hidden"))';
    const controller = new GradebookWhatIfController(
      createFakeController({
        values: baseValues(),
        totalExpression: expression,
        totalDependencies: { gradebook_column_groups: [99] }
      }) as unknown as ConstructorParameters<typeof GradebookWhatIfController>[0],
      "alice",
      {} as unknown as ConstructorParameters<typeof GradebookWhatIfController>[2]
    );
    expect(asNullable(controller.getGrade(TOTAL_COLUMN.id)?.report_only)).toBeNull();
  });
});

describe("the fixture itself", () => {
  test("slugs in the fixture resolve the way the evaluators resolve them", () => {
    expect(FIXTURE_COLUMNS.filter((c) => minimatch(c.slug, "hw-[123]")).map((c) => c.id)).toEqual([3, 1, 2]);
  });
});
