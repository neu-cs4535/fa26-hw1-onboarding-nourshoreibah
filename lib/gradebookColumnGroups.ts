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
  const pct = weight * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded}%`;
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
  currentGroupOrder: readonly number[];
  draggedColumnId: number;
}): ColumnDragPlan {
  const { orderedColumnIds, groupIdByColumnId, currentGroupOrder, draggedColumnId } = args;

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

  const groupOrderChanged =
    impliedGroupOrder.length !== currentGroupOrder.length ||
    impliedGroupOrder.some((g, i) => g !== currentGroupOrder[i]);
  if (groupOrderChanged) {
    return { kind: "reorder-groups", orderedGroupIds: impliedGroupOrder };
  }

  const groupId = groupIdByColumnId.get(draggedColumnId);
  if (groupId === undefined) return { kind: "noop" };
  return {
    kind: "reorder-in-group",
    groupId,
    orderedColumnIds: orderedColumnIds.filter((id) => groupIdByColumnId.get(id) === groupId)
  };
}
