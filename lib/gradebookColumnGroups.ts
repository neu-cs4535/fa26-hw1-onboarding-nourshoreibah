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

/** Group slugs are what score expressions name, e.g. gradebook_column_group("homework"). */
export const GROUP_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A slug for a new group: the name lowercased to [a-z0-9-], suffixed -2, -3... until unused. */
export function slugForGroupName(name: string, existingSlugs: Iterable<string>): string {
  const taken = new Set(existingSlugs);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Why `slug` cannot be a group's slug, or null when it can. */
export function groupSlugProblem(slug: string, otherSlugs: Iterable<string>): string | null {
  if (!GROUP_SLUG_PATTERN.test(slug)) {
    return "Use lowercase letters, digits and single hyphens, e.g. homework or lab-reports";
  }
  for (const other of otherSlugs) {
    if (other === slug) return `Another group already uses the slug ${slug}`;
  }
  return null;
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

export type ColumnDropPlan =
  | { kind: "noop" }
  | { kind: "reorder-in-group"; groupId: number; orderedColumnIds: number[] }
  | { kind: "move-column"; columnId: number; groupId: number; position: number };

/**
 * What dropping a column does. The drop target is explicit, a group and the column to land before
 * (null for the end of the group), so a drop at the boundary between two groups is never read as
 * reordering the groups: that has its own handle on the group header.
 */
export function planColumnDrop(args: {
  orderedColumnIds: readonly number[];
  groupIdByColumnId: ReadonlyMap<number, number>;
  draggedColumnId: number;
  target: { groupId: number; beforeColumnId: number | null };
}): ColumnDropPlan {
  const { orderedColumnIds, groupIdByColumnId, draggedColumnId, target } = args;
  const sourceGroupId = groupIdByColumnId.get(draggedColumnId);
  if (sourceGroupId === undefined) return { kind: "noop" };

  const members = orderedColumnIds.filter(
    (id) => id !== draggedColumnId && groupIdByColumnId.get(id) === target.groupId
  );
  const beforeIndex = target.beforeColumnId === null ? -1 : members.indexOf(target.beforeColumnId);
  const position = beforeIndex === -1 ? members.length : beforeIndex;

  if (sourceGroupId !== target.groupId) {
    return { kind: "move-column", columnId: draggedColumnId, groupId: target.groupId, position };
  }

  const current = orderedColumnIds.filter((id) => groupIdByColumnId.get(id) === target.groupId);
  const next = [...members.slice(0, position), draggedColumnId, ...members.slice(position)];
  if (next.every((id, i) => id === current[i])) return { kind: "noop" };
  return { kind: "reorder-in-group", groupId: target.groupId, orderedColumnIds: next };
}

export type ColumnLayoutPatch = {
  id: number;
  values: { gradebook_column_group_id?: number; position_in_group: number };
};

/**
 * The column rows a drop plan changes, renumbered the way the database leaves them: every column
 * of each affected group gets a dense position in its new order. Used to move the table before the
 * save returns.
 */
export function columnLayoutPatches(args: {
  plan: ColumnDropPlan;
  orderedColumnIds: readonly number[];
  groupIdByColumnId: ReadonlyMap<number, number>;
}): ColumnLayoutPatch[] {
  const { plan, orderedColumnIds, groupIdByColumnId } = args;
  if (plan.kind === "noop") return [];
  if (plan.kind === "reorder-in-group") {
    return plan.orderedColumnIds.map((id, position) => ({ id, values: { position_in_group: position } }));
  }
  const sourceGroupId = groupIdByColumnId.get(plan.columnId);
  const source = orderedColumnIds.filter((id) => id !== plan.columnId && groupIdByColumnId.get(id) === sourceGroupId);
  const target = orderedColumnIds.filter((id) => id !== plan.columnId && groupIdByColumnId.get(id) === plan.groupId);
  target.splice(Math.min(plan.position, target.length), 0, plan.columnId);
  return [
    ...source.map((id, position) => ({ id, values: { position_in_group: position } })),
    ...target.map((id, position) => ({
      id,
      values:
        id === plan.columnId
          ? { gradebook_column_group_id: plan.groupId, position_in_group: position }
          : { position_in_group: position }
    }))
  ];
}

/** Group rows a reorder changes: sort_order follows the new order; the default group keeps its pin. */
export function groupOrderPatches(
  orderedGroupIds: readonly number[]
): { id: number; values: { sort_order: number } }[] {
  return orderedGroupIds.map((id, sort_order) => ({ id, values: { sort_order } }));
}
