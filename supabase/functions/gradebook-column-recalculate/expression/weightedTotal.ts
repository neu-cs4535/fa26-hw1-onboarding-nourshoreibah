/**
 * The weighted-total calculation, in one place.
 *
 * Three evaluators run gradebook score expressions: the Deno recalculator that writes scores to
 * the database, the student what-if view, and the Expression Builder preview. They read a score
 * three different ways (a dependency-source cache, the realtime row cache, a what-if overlay),
 * and that part has to stay different. The arithmetic must not. A student who sees one number in
 * the what-if view and a different one in their gradebook has been told a lie by whichever copy
 * drifted, so every evaluator calls `computeWeightedTotal` here and supplies nothing but a way to
 * look a column up by slug.
 *
 * Deno reaches this file by relative import; the Next.js side reaches the same file through the
 * `@/` alias, the way it already reaches `commonMathFunctions.ts` and `shared.ts`. There is no
 * copy step to keep in sync.
 *
 * ## Semantics
 *
 * Scale: the result is a percentage in 0..100, matching `mean()`. A column that holds
 * `weighted_total()` should therefore set `max_score` to 100, exactly as a column holding
 * `mean(...)` does. Returning a 0..1 fraction would have been defensible on its own, but it would
 * make `weighted_total()` the only aggregate on a different scale, and render helpers such as
 * `letter(score, max_score)` divide by `max_score` on the assumption that the two agree.
 *
 * Excused: an excused column drops out of its group entirely. It moves neither the numerator nor
 * the denominator, so excusing a student from a quiz reweights the rest of that group rather than
 * scoring the quiz zero. (`mean()` only drops an excused column when it is also missing; that is
 * a quirk of `mean()`, not a convention worth copying into a function whose whole job is weights.)
 *
 * Missing: a missing column that is not excused counts as zero against its full `max_score`. That
 * matches `mean()`, which maps `is_missing && !is_excused` to a score of zero. A column that is
 * neither missing nor excused but has no score yet is skipped, again matching `mean()`, so an
 * ungraded assignment does not read as a zero before anyone has graded it.
 *
 * Groups with no weight: skipped. `weight` is a share of the course, and NULL means the group was
 * never given one.
 *
 * Nothing to weigh: returns `undefined`, the same answer `mean()` gives for an empty set. Every
 * evaluator already turns an undefined result into a blank score, so this needs no new handling.
 * Returning 0 would have been worse: an instructor who has not set any weights yet would see
 * every student sitting on a hard zero and take it for a real grade.
 *
 * Normalisation: the total is divided by the weight of the groups that actually contributed.
 * Weights that already sum to 1 are unaffected. The case this exists for is the middle of a term,
 * when the Exams group is worth 60% and has nothing graded in it: without normalising, every
 * student's total is capped at 40 and looks like a failing grade for reasons that have nothing to
 * do with their work.
 */

/** Minimum a `gradebook_columns` row needs for this calculation. */
export type WeightedTotalColumnInput = {
  id: number;
  slug: string;
  gradebook_column_group_id: number;
  /** Relative share within the group. NULL means 1. */
  weight: number | string | null;
};

/** Minimum a `gradebook_column_groups` row needs for this calculation. */
export type WeightedTotalGroupInput = {
  id: number;
  /** Share of the course, so 0.4 is 40%. NULL means the group is unweighted and contributes nothing. */
  weight: number | string | null;
};

/** One column that will be weighed, with the weights already resolved. */
export type WeightedTotalSpec = {
  column_id: number;
  column_slug: string;
  group_id: number;
  group_weight: number;
  column_weight: number;
};

/** The per-student fields the calculation reads. Any gradebook value object satisfies this. */
export type WeightedTotalValue = {
  score: number | null | undefined;
  max_score: number | null | undefined;
  is_excused?: boolean | null;
  is_missing?: boolean | null;
};

export type WeightedTotalEntry = {
  spec: WeightedTotalSpec;
  value: WeightedTotalValue | undefined;
};

/** Supplies the specs paired with this student's values. Set on the expression context. */
export type WeightedTotalSource = () => WeightedTotalEntry[];

/** Percentages, not fractions. See the scale note above. */
export const WEIGHTED_TOTAL_SCALE = 100;

function toFiniteNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve which columns a `weighted_total()` call weighs, and how heavily.
 *
 * `excludeColumnId` is the column being evaluated. Leaving it in would let a column holding
 * `weighted_total()` weigh its own previous value, which drifts a little further from the truth
 * on every recalculation and reports a cycle to `extractAndValidateDependencies`.
 */
export function buildWeightedTotalSpecs({
  columns,
  groups,
  excludeColumnId
}: {
  columns: readonly WeightedTotalColumnInput[];
  groups: readonly WeightedTotalGroupInput[];
  excludeColumnId?: number | null;
}): WeightedTotalSpec[] {
  const groupWeightById = new Map<number, number>();
  for (const group of groups) {
    const weight = toFiniteNumber(group.weight);
    // A zero or negative share cannot move a total, and letting one through would only give the
    // normalisation denominator a chance to reach zero.
    if (weight === undefined || weight <= 0) continue;
    groupWeightById.set(group.id, weight);
  }

  const specs: WeightedTotalSpec[] = [];
  for (const column of columns) {
    if (excludeColumnId !== null && excludeColumnId !== undefined && column.id === excludeColumnId) continue;
    const groupWeight = groupWeightById.get(column.gradebook_column_group_id);
    if (groupWeight === undefined) continue;
    const columnWeight = toFiniteNumber(column.weight);
    specs.push({
      column_id: column.id,
      column_slug: column.slug,
      group_id: column.gradebook_column_group_id,
      group_weight: groupWeight,
      // NULL means "counts once". A non-positive share is treated the same way a group's is:
      // dropped, because a column cannot subtract from the group it belongs to.
      column_weight: columnWeight === undefined || columnWeight <= 0 ? 1 : columnWeight
    });
  }
  return specs;
}

/**
 * The calculation itself. Every evaluator lands here.
 *
 * Returns a percentage in 0..100, or `undefined` when no weighted group had anything to weigh.
 */
export function computeWeightedTotal(entries: readonly WeightedTotalEntry[]): number | undefined {
  const groupTotals = new Map<number, { weight: number; earned: number; possible: number }>();

  for (const { spec, value } of entries) {
    if (!value) continue;
    if (value.is_excused) continue;

    const maxScore = toFiniteNumber(value.max_score);
    if (maxScore === undefined || maxScore <= 0) continue;

    let score: number;
    if (value.is_missing) {
      score = 0;
    } else {
      const resolved = toFiniteNumber(value.score);
      // Not missing and not yet scored: nobody has graded it, so it is neither earned nor owed.
      if (resolved === undefined) continue;
      score = resolved;
    }

    const totals = groupTotals.get(spec.group_id) ?? { weight: spec.group_weight, earned: 0, possible: 0 };
    totals.earned += spec.column_weight * score;
    totals.possible += spec.column_weight * maxScore;
    groupTotals.set(spec.group_id, totals);
  }

  let weightedSum = 0;
  let contributingWeight = 0;
  for (const totals of groupTotals.values()) {
    if (totals.possible <= 0) continue;
    weightedSum += totals.weight * (totals.earned / totals.possible);
    contributingWeight += totals.weight;
  }

  if (contributingWeight <= 0) return undefined;
  return (WEIGHTED_TOTAL_SCALE * weightedSum) / contributingWeight;
}

/**
 * Read a gradebook value object out of whatever an evaluator's `gradebook_columns` lookup handed
 * back. The three evaluators return the same duck type but wrap it differently: one returns the
 * object, one returns a single-element array, and all three return null or undefined for a slug
 * with no row for this student.
 */
export function coerceWeightedTotalValue(raw: unknown): WeightedTotalValue | undefined {
  let candidate = raw;
  if (Array.isArray(candidate)) {
    if (candidate.length === 0) return undefined;
    candidate = candidate[0];
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (!("score" in record) || !("max_score" in record)) return undefined;
  return {
    score: record.score as number | null | undefined,
    max_score: record.max_score as number | null | undefined,
    is_excused: record.is_excused as boolean | null | undefined,
    is_missing: record.is_missing as boolean | null | undefined
  };
}

/**
 * Bind specs to an evaluator's slug lookup. The lookup is the only thing an evaluator has to
 * write, and it is usually its own already-registered `gradebook_columns` implementation, so the
 * values `weighted_total()` sees are the same ones the rest of the expression sees: overrides
 * applied, what-if values applied, missing dependencies reported.
 */
export function makeWeightedTotalSource(
  specs: readonly WeightedTotalSpec[],
  lookup: (slug: string) => unknown
): WeightedTotalSource {
  return () => specs.map((spec) => ({ spec, value: coerceWeightedTotalValue(lookup(spec.column_slug)) }));
}
