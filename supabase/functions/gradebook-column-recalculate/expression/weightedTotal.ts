export type WeightedTotalColumnInput = {
  id: number;
  slug: string;
  gradebook_column_group_id: number;
  weight: number | string | null;
  score_expression?: string | null;
};

export type WeightedTotalGroupInput = {
  id: number;
  weight: number | string | null;
};

export type WeightedTotalSpec = {
  column_id: number;
  column_slug: string;
  group_id: number;
  group_weight: number;
  column_weight: number;
};

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

export type WeightedTotalSource = () => WeightedTotalEntry[];

export const WEIGHTED_TOTAL_SCALE = 100;

function toFiniteNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const WEIGHTED_TOTAL_CALL = /\bweighted_total\s*\(/;

export function callsWeightedTotal(expression: string | null | undefined): boolean {
  return !!expression && WEIGHTED_TOTAL_CALL.test(expression);
}

// NULL means "no explicit weight" (1); 0 means the column counts for nothing.
function resolveColumnWeight(value: number | string | null | undefined): number {
  const weight = toFiniteNumber(value);
  if (weight === undefined || weight < 0) return 1;
  return weight;
}

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
    if (weight === undefined || weight <= 0) continue;
    groupWeightById.set(group.id, weight);
  }

  const specs: WeightedTotalSpec[] = [];
  for (const column of columns) {
    if (excludeColumnId !== null && excludeColumnId !== undefined && column.id === excludeColumnId) continue;
    if (callsWeightedTotal(column.score_expression)) continue;
    const groupWeight = groupWeightById.get(column.gradebook_column_group_id);
    if (groupWeight === undefined) continue;
    specs.push({
      column_id: column.id,
      column_slug: column.slug,
      group_id: column.gradebook_column_group_id,
      group_weight: groupWeight,
      column_weight: resolveColumnWeight(column.weight)
    });
  }
  return specs;
}

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

export function makeWeightedTotalSource(
  specs: readonly WeightedTotalSpec[],
  lookup: (slug: string) => unknown
): WeightedTotalSource {
  return () => specs.map((spec) => ({ spec, value: coerceWeightedTotalValue(lookup(spec.column_slug)) }));
}
