import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/utils/supabase/SupabaseTypes";

export type GradebookColumnGroup = Database["public"]["Tables"]["gradebook_column_groups"]["Row"];

export type GroupableColumn = {
  id: number;
  gradebook_column_group_id: number;
  position_in_group: number;
};

export type GroupedColumns<T extends GroupableColumn> = Record<string, { groupName: string; columns: T[] }>;

export function groupKey(group: Pick<GradebookColumnGroup, "id">): string {
  return `group-${group.id}`;
}

export function sortColumnsForDisplay<T extends GroupableColumn>(
  columns: readonly T[],
  groups: readonly GradebookColumnGroup[]
): T[] {
  const groupOrder = new Map(groups.map((g) => [g.id, g.sort_order]));
  const orderOf = (c: T) => groupOrder.get(c.gradebook_column_group_id) ?? Number.MAX_SAFE_INTEGER;
  return [...columns].sort(
    (a, b) => orderOf(a) - orderOf(b) || a.position_in_group - b.position_in_group || a.id - b.id
  );
}

export function buildGroupedColumns<T extends GroupableColumn>(
  columns: readonly T[],
  groups: readonly GradebookColumnGroup[]
): GroupedColumns<T> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const ordered = sortColumnsForDisplay(columns, groups);
  const result: GroupedColumns<T> = {};

  for (const column of ordered) {
    const group = byId.get(column.gradebook_column_group_id);
    if (!group) continue;
    const key = groupKey(group);
    if (!result[key]) {
      result[key] = { groupName: group.name, columns: [] };
    }
    result[key].columns.push(column);
  }

  return result;
}

export function buildColumnGroupKeyMap<T extends GroupableColumn>(
  columns: readonly T[],
  groups: readonly GradebookColumnGroup[]
): Map<number, string> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const map = new Map<number, string>();
  for (const column of columns) {
    const group = byId.get(column.gradebook_column_group_id);
    if (group) map.set(column.id, groupKey(group));
  }
  return map;
}

export function visibleGroupsInOrder<T extends GroupableColumn>(
  columns: readonly T[],
  groups: readonly GradebookColumnGroup[]
): GradebookColumnGroup[] {
  const populated = new Set(columns.map((c) => c.gradebook_column_group_id));
  return groups.filter((g) => populated.has(g.id)).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

export function formatGroupWeight(weight: number | null): string | null {
  if (weight === null || Number.isNaN(weight)) return null;
  return `${formatWeightPercent(weight, 1)}%`;
}

/** A weight fraction as a plain percentage number, without float noise: 0.07 becomes "7", not "7.000000000000001". */
export function formatWeightPercent(weight: number, decimals = 4): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(weight * 100 * factor) / factor;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export async function resolveGroupForSlug(
  client: SupabaseClient<Database>,
  gradebookId: number,
  classId: number,
  slug: string
): Promise<number> {
  const { data, error } = await client.rpc("gradebook_column_group_for_slug", {
    p_gradebook_id: gradebookId,
    p_class_id: classId,
    p_slug: slug
  });
  if (error) throw error;
  if (typeof data !== "number") {
    throw new Error(`Could not work out which column group "${slug}" belongs to`);
  }
  return data;
}

export type ColumnDragPlan =
  | { kind: "noop" }
  | { kind: "reorder-groups"; orderedGroupIds: number[] }
  | { kind: "reorder-in-group"; groupId: number; orderedColumnIds: number[] }
  | { kind: "move-column"; columnId: number; groupId: number; position: number };

export function planColumnDrag(args: {
  orderedColumnIds: readonly number[];
  groupIdByColumnId: ReadonlyMap<number, number>;
  /** Every non-default group of the gradebook in its current order, including groups with no columns. */
  currentGroupOrder: readonly number[];
  defaultGroupId: number | null;
  draggedColumnId: number;
}): ColumnDragPlan {
  const { orderedColumnIds, groupIdByColumnId, currentGroupOrder, defaultGroupId, draggedColumnId } = args;

  const groupSequence = orderedColumnIds
    .map((id) => groupIdByColumnId.get(id))
    .filter((g): g is number => g !== undefined);

  const impliedGroupOrder: number[] = [];
  for (const g of groupSequence) {
    if (!impliedGroupOrder.includes(g)) impliedGroupOrder.push(g);
  }

  const broken = impliedGroupOrder.filter((g) => {
    const first = groupSequence.indexOf(g);
    const last = groupSequence.lastIndexOf(g);
    for (let i = first; i <= last; i++) {
      if (groupSequence[i] !== g) return true;
    }
    return false;
  });

  if (broken.length > 0) {
    const index = orderedColumnIds.indexOf(draggedColumnId);
    const neighbour = groupSequence[index - 1] ?? groupSequence[index + 1] ?? groupIdByColumnId.get(draggedColumnId);
    if (neighbour === undefined) return { kind: "noop" };
    const position = orderedColumnIds.slice(0, index).filter((id) => groupIdByColumnId.get(id) === neighbour).length;
    return { kind: "move-column", columnId: draggedColumnId, groupId: neighbour, position };
  }

  // The default group is pinned last, so only the order of the other groups that have columns can change.
  const known = new Set(currentGroupOrder);
  const impliedMovable = impliedGroupOrder.filter((g) => g !== defaultGroupId && known.has(g));
  const shown = new Set(impliedMovable);
  const slots = currentGroupOrder.flatMap((g, i) => (shown.has(g) ? [i] : []));
  const groupOrderChanged = impliedMovable.some((g, k) => g !== currentGroupOrder[slots[k]]);
  if (groupOrderChanged) {
    const orderedGroupIds = [...currentGroupOrder];
    slots.forEach((slot, k) => {
      orderedGroupIds[slot] = impliedMovable[k];
    });
    return { kind: "reorder-groups", orderedGroupIds };
  }

  const groupId = groupIdByColumnId.get(draggedColumnId);
  if (groupId === undefined) return { kind: "noop" };
  const inGroup = orderedColumnIds.filter((id) => groupIdByColumnId.get(id) === groupId);
  if (inGroup.length < 2) return { kind: "noop" };
  return { kind: "reorder-in-group", groupId, orderedColumnIds: inGroup };
}
