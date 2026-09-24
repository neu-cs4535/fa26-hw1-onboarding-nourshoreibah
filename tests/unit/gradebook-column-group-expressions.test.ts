import * as mathjs from "mathjs";

import {
  COLUMN_GROUP_FUNCTION,
  columnGroupCallSlugs,
  expandColumnGroup,
  referencedColumnGroupIds,
  slugListArgument
} from "@/supabase/functions/gradebook-column-recalculate/expression/columnGroups";
import {
  EMPTY_GROUP,
  FIXTURE_COLUMNS,
  FIXTURE_GROUPS,
  HOMEWORK_GROUP,
  HW_AVG_COLUMN,
  PARITY_CASES,
  TOTAL_COLUMN,
  baseValues,
  parityCaseColumns,
  parityCaseEvaluatedColumn,
  type FixtureColumn,
  type FixtureValue,
  type ParityCase
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

type ColumnRow = Omit<FixtureColumn, "score_expression" | "dependencies"> & {
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
  /** Replaces ALL_COLUMNS. */
  baseColumns?: FixtureColumn[];
  /** The column totalExpression belongs to. Defaults to TOTAL_COLUMN. */
  totalColumnId?: number;
}) {
  const totalColumnId = opts.totalColumnId ?? TOTAL_COLUMN.id;
  const columns: ColumnRow[] = [
    ...(opts.baseColumns ?? ALL_COLUMNS).map((c) => ({
      ...c,
      name: c.slug,
      class_id: 1,
      gradebook_id: 1,
      score_expression: c.id === totalColumnId ? (opts.totalExpression ?? null) : (c.score_expression ?? null),
      dependencies: c.id === totalColumnId ? (opts.totalDependencies ?? null) : (c.dependencies ?? null)
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

type Setup = Pick<ParityCase, "columns" | "evaluatedColumn">;

function setupOptions(setup: Setup) {
  return { baseColumns: parityCaseColumns(setup), totalColumnId: parityCaseEvaluatedColumn(setup).id };
}

function evaluateInTester(
  expression: string,
  values: Record<string, FixtureValue>,
  setup: Setup & { extraColumns?: ColumnRow[] } = {}
) {
  const options = setupOptions(setup);
  const result = evaluateForStudent({
    math: mathjs,
    gradebookController: createFakeController({
      values,
      ...options,
      extraColumns: setup.extraColumns
    }) as unknown as Parameters<typeof evaluateForStudent>[0]["gradebookController"],
    expression,
    studentId: "alice",
    editingColumnId: options.totalColumnId,
    captureIntermediates: true
  });
  expect(result.parseError).toBeNull();
  expect(result.dependencyError).toBeNull();
  expect(result.evaluation?.error).toBeNull();
  return result;
}

function evaluateInWhatIf(
  expression: string,
  values: Record<string, FixtureValue>,
  setup: Setup & { extraColumns?: ColumnRow[] } = {}
) {
  const options = { ...setupOptions(setup), extraColumns: setup.extraColumns };
  const deps = createFakeController({ values, ...options }).extractAndValidateDependencies(
    expression,
    options.totalColumnId
  );
  const controller = new GradebookWhatIfController(
    createFakeController({
      values,
      ...options,
      totalExpression: expression,
      totalDependencies: deps
    }) as unknown as ConstructorParameters<typeof GradebookWhatIfController>[0],
    "alice",
    {} as unknown as ConstructorParameters<typeof GradebookWhatIfController>[2]
  );
  return controller.getGrade(options.totalColumnId)?.report_only;
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

  test("leaves out another total of the same group, but not a total of a different group", () => {
    const examTotal = { ...HW_AVG_COLUMN, id: 9, slug: "exam-total", dependencies: { gradebook_column_groups: [20] } };
    expect(
      expandColumnGroup({
        groupSlug: "hw",
        groups: FIXTURE_GROUPS,
        columns: [...ALL_COLUMNS, HW_AVG_COLUMN, examTotal],
        excludeColumnId: TOTAL_COLUMN.id
      })?.slugs
    ).toEqual(["hw-1", "hw-2", "hw-3", "exam-total"]);
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
  // GradebookProcessor.columnGroups.test.ts checks the same PARITY_CASES through
  // processGradebookRowsCalculation in Deno.
  test.each(PARITY_CASES.map((c) => [c.label, c] as const))("%s", (_label, parityCase) => {
    const tester = evaluateInTester(parityCase.expression, parityCase.values, parityCase);
    expectResult(tester.evaluation?.rawResult, parityCase.expected);
    expectResult(evaluateInWhatIf(parityCase.expression, parityCase.values, parityCase), parityCase.expected);
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

  test("hover labels stay right when two group calls, or a hand-written list, stringify alike", () => {
    // Both group calls expand to the same list, and the hand-written list equals that expansion.
    const expression =
      'sum(gradebook_column_group("hw")) + sum(gradebook_column_group("hw")) + sum(gradebook_columns(["hw-1", "hw-2", "hw-3"]))';
    const result = evaluateInTester(expression, baseValues());
    const intermediates = result.evaluation?.intermediates ?? [];
    const groupCalls = intermediates.filter((iv) => iv.source === 'gradebook_column_group("hw")');
    expect(groupCalls.map((iv) => expression.slice(iv.start, iv.end))).toEqual([
      'gradebook_column_group("hw")',
      'gradebook_column_group("hw")'
    ]);
    expect(new Set(groupCalls.map((iv) => iv.start)).size).toBe(2);
    const handWritten = intermediates.find((iv) => iv.source === 'gradebook_columns(["hw-1", "hw-2", "hw-3"])');
    expect(handWritten).toBeDefined();
    expect(expression.slice(handWritten!.start, handWritten!.end)).toBe(handWritten!.source);
    expect(intermediates.find((iv) => iv.start === 0 && iv.end === expression.length)?.source).toBe(expression);
  });

  describe("slugs with glob characters", () => {
    // Slugs a glob would misread: `?` matches any character, `[x]` a character class. q?1 and
    // lab[a] are put in the otherwise empty group; qx1 sits in a group of its own.
    const oddColumns: ColumnRow[] = [
      { id: 21, slug: "q?1", max_score: 10, position_in_group: 0 },
      { id: 22, slug: "lab[a]", max_score: 10, position_in_group: 1 },
      { id: 23, slug: "qx1", max_score: 10, position_in_group: 0 }
    ].map((c) => ({
      ...c,
      name: c.slug,
      class_id: 1,
      gradebook_id: 1,
      gradebook_column_group_id: c.id === 23 ? EMPTY_GROUP + 1 : EMPTY_GROUP,
      score_expression: null,
      dependencies: null
    }));
    const values = { ...baseValues(), "q?1": { score: 4 }, "lab[a]": { score: 6 }, qx1: { score: 10 } };

    test("a group call matches each member slug exactly", () => {
      const expression = 'sum(gradebook_column_group("empty"))';
      expectResult(evaluateInTester(expression, values, { extraColumns: oddColumns }).evaluation?.rawResult, 10);
      expectResult(evaluateInWhatIf(expression, values, { extraColumns: oddColumns }), 10);
    });

    test("a hand-written list matches each slug exactly", () => {
      // Tester only: extractAndValidateDependencies records no dependencies for a list argument,
      // so what-if never recalculates such a column.
      const expression = 'sum(gradebook_columns(["q?1", "lab[a]"]))';
      expectResult(evaluateInTester(expression, values, { extraColumns: oddColumns }).evaluation?.rawResult, 10);
    });

    test("a single string argument keeps its glob meaning", () => {
      // "q?1" as a pattern matches both q?1 and qx1, as it always has.
      expectResult(
        evaluateInTester('sum(gradebook_columns("q?1"))', values, { extraColumns: oddColumns }).evaluation?.rawResult,
        14
      );
    });
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

describe("stored group dependencies", () => {
  test("accepts group IDs and ignores other dependency shapes", () => {
    expect(referencedColumnGroupIds({ gradebook_column_groups: [HOMEWORK_GROUP] })).toEqual([HOMEWORK_GROUP]);
    expect(referencedColumnGroupIds({ gradebook_columns: [1] })).toEqual([]);
    expect(referencedColumnGroupIds(null)).toEqual([]);
    expect(referencedColumnGroupIds("junk")).toEqual([]);
  });
});

describe("slugListArgument", () => {
  test("reads a mathjs Matrix or an array, and leaves a single slug to glob matching", () => {
    expect(slugListArgument(mathjs.evaluate('["a", "b"]'))).toEqual(["a", "b"]);
    expect(slugListArgument(["a"])).toEqual(["a"]);
    expect(slugListArgument("a")).toBeNull();
  });
});
