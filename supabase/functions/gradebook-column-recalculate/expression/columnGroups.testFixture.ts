// Shared by the Deno recalculator test and the Jest browser-evaluator test, so every evaluator is
// checked against the same fixtures and the same expected numbers. Import-free for the same reason.

export const HOMEWORK_GROUP = 10;
export const EXAM_GROUP = 20;
export const EMPTY_GROUP = 30;

export const FIXTURE_GROUPS = [
  { id: HOMEWORK_GROUP, slug: "hw" },
  { id: EXAM_GROUP, slug: "exams" },
  { id: EMPTY_GROUP, slug: "empty" }
];

export type FixtureColumn = {
  id: number;
  slug: string;
  gradebook_column_group_id: number;
  position_in_group: number;
  max_score: number;
  /** Set on a calculated column other than the one a case evaluates. */
  score_expression?: string;
  /** Stored dependencies, as the save path would have written them. */
  dependencies?: { gradebook_columns?: number[]; gradebook_column_groups?: number[] };
};

/** Listed out of display order on purpose: expansion must sort by position_in_group. */
export const FIXTURE_COLUMNS: FixtureColumn[] = [
  { id: 3, slug: "hw-3", gradebook_column_group_id: HOMEWORK_GROUP, position_in_group: 2, max_score: 100 },
  { id: 1, slug: "hw-1", gradebook_column_group_id: HOMEWORK_GROUP, position_in_group: 0, max_score: 100 },
  { id: 2, slug: "hw-2", gradebook_column_group_id: HOMEWORK_GROUP, position_in_group: 1, max_score: 50 },
  { id: 5, slug: "exam-1", gradebook_column_group_id: EXAM_GROUP, position_in_group: 0, max_score: 100 }
];

/** The column being evaluated. It sits inside the group it totals. */
export const TOTAL_COLUMN: FixtureColumn = {
  id: 4,
  slug: "hw-total",
  gradebook_column_group_id: HOMEWORK_GROUP,
  position_in_group: 3,
  max_score: 100
};

export type FixtureValue = { score: number | null; is_missing?: boolean; is_excused?: boolean };

/** hw-total carries a stale stored score, so counting itself would visibly change every result. */
export function baseValues(): Record<string, FixtureValue> {
  return {
    "hw-1": { score: 80 },
    "hw-2": { score: 25 },
    "hw-3": { score: 90 },
    "exam-1": { score: 70 },
    "hw-total": { score: 5 }
  };
}

/**
 * A second total of the homework group, living inside it. Its max_score differs from the
 * homework columns', so counting it (stale or recalculated) would visibly change a mean.
 */
export const HW_AVG_COLUMN: FixtureColumn = {
  id: 7,
  slug: "hw-avg",
  gradebook_column_group_id: HOMEWORK_GROUP,
  position_in_group: 2,
  max_score: 200,
  score_expression: 'mean(gradebook_column_group("hw"))',
  dependencies: { gradebook_column_groups: [HOMEWORK_GROUP], gradebook_columns: [1, 2] }
};

/** A total outside the homework group. */
export const FINAL_COLUMN: FixtureColumn = {
  id: 8,
  slug: "final",
  gradebook_column_group_id: EXAM_GROUP,
  position_in_group: 1,
  max_score: 100
};

export type ParityCase = {
  label: string;
  expression: string;
  values: Record<string, FixtureValue>;
  expected: number | null;
  /** The gradebook's columns, including the evaluated one. Defaults to FIXTURE_COLUMNS and TOTAL_COLUMN. */
  columns?: FixtureColumn[];
  /** The column the expression is evaluated for. Defaults to TOTAL_COLUMN. */
  evaluatedColumn?: FixtureColumn;
};

export function parityCaseColumns(parityCase: Pick<ParityCase, "columns">): FixtureColumn[] {
  return parityCase.columns ?? [...FIXTURE_COLUMNS, TOTAL_COLUMN];
}

export function parityCaseEvaluatedColumn(parityCase: Pick<ParityCase, "evaluatedColumn">): FixtureColumn {
  return parityCase.evaluatedColumn ?? TOTAL_COLUMN;
}

function withValues(overrides: Record<string, FixtureValue>): Record<string, FixtureValue> {
  return { ...baseValues(), ...overrides };
}

export const PARITY_CASES: ParityCase[] = [
  {
    label: "mean of a group, the total inside it",
    expression: 'mean(gradebook_column_group("hw"))',
    values: baseValues(),
    expected: 78
  },
  {
    label: "sum of a group",
    expression: 'sum(gradebook_column_group("hw"))',
    values: baseValues(),
    expected: 195
  },
  {
    label: "mean after dropping the lowest",
    expression: 'mean(drop_lowest(gradebook_column_group("hw"), 1))',
    values: baseValues(),
    expected: 85
  },
  {
    label: "a missing member counts as zero",
    expression: 'mean(gradebook_column_group("hw"))',
    values: withValues({ "hw-2": { score: null, is_missing: true } }),
    expected: 68
  },
  {
    label: "an excused member leaves the mean",
    expression: 'mean(gradebook_column_group("hw"))',
    values: withValues({ "hw-2": { score: null, is_missing: true, is_excused: true } }),
    expected: 85
  },
  {
    // hw holds hw-1, hw-2 and hw-avg, which totals hw. final (outside hw) must not count hw-avg.
    label: "another total inside the group is left out",
    expression: 'mean(gradebook_column_group("hw"))',
    values: withValues({ "hw-avg": { score: 5 } }),
    expected: 70,
    columns: [
      FIXTURE_COLUMNS.find((c) => c.slug === "hw-1")!,
      FIXTURE_COLUMNS.find((c) => c.slug === "hw-2")!,
      HW_AVG_COLUMN,
      FIXTURE_COLUMNS.find((c) => c.slug === "exam-1")!,
      FINAL_COLUMN
    ],
    evaluatedColumn: FINAL_COLUMN
  },
  {
    label: "an empty group",
    expression: 'mean(gradebook_column_group("empty"))',
    values: baseValues(),
    expected: null
  }
];
