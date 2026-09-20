/**
 * Gradebook column grouping.
 *
 * Until the `gradebook_column_groups` table existed, this was computed in the browser on every
 * render: split a column's slug on `-`, take the first token, special-case anything shaped
 * `assignment-<type>-*`, and start a new group whenever `sort_order` skipped a number. The
 * instructor table and the student what-if view each had their own copy, and three more places
 * in the table re-derived the prefix a third way.
 *
 * None of that is here. A column belongs to the group its foreign key names. What is left is
 * shaping rows into the record the table already expects.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/utils/supabase/SupabaseTypes";

export type GradebookColumnGroup = Database["public"]["Tables"]["gradebook_column_groups"]["Row"];

/** The subset of a column this module needs. Anything with these fields will do. */
export type GroupableColumn = {
  id: number;
  gradebook_column_group_id: number;
  position_in_group: number;
};

/**
 * A group and its columns, keyed by a stable string.
 *
 * The shape is unchanged from the memo this replaces, so its callers did not have to move. The
 * key did change: it used to be `${slugPrefix}-${runningIndex}`, which shifted whenever a column
 * was added or a group boundary moved. It is now the group's id, which does not.
 */
export type GroupedColumns<T extends GroupableColumn> = Record<string, { groupName: string; columns: T[] }>;

/** The key a group appears under. Stable across reorders, renames and additions. */
export function groupKey(group: Pick<GradebookColumnGroup, "id">): string {
  return `group-${group.id}`;
}

/**
 * Sort columns the way the gradebook displays them: by group, then by position within the group.
 *
 * Both levels are needed. Sorting on `position_in_group` alone interleaves every group's first
 * column, since each group starts again at zero.
 */
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

/**
 * Build the grouped view of a column list.
 *
 * Groups with no visible columns are omitted rather than rendered empty. That matters for
 * students: `filterGradebookColumnsForStudentView` drops instructor-only and unreleased columns,
 * and a group whose every member was dropped should not leave a header behind. Under the old
 * heuristic that filtering did something worse than leave an empty header, because removing a
 * column from the middle of the sequence broke the contiguity test and split the surrounding
 * group in two, so students saw groups that no instructor ever saw.
 */
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

/**
 * Which group key each column renders under.
 *
 * The table used to answer this by re-deriving the slug prefix and then scanning
 * `Object.entries(groupedColumns)` for a key that started with it, which returned the first
 * insertion-ordered match and was saved only by a follow-up check that the group really contained
 * the column. One lookup replaces all of it.
 */
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

/** Groups in display order, skipping any with no visible columns. */
export function visibleGroupsInOrder<T extends GroupableColumn>(
  columns: readonly T[],
  groups: readonly GradebookColumnGroup[]
): GradebookColumnGroup[] {
  const populated = new Set(columns.map((c) => c.gradebook_column_group_id));
  return groups.filter((g) => populated.has(g.id)).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

/**
 * How a group's weight reads in a header, or null when it carries none.
 *
 * Weights are stored as a share of the course, so 0.4 renders as 40%.
 */
export function formatGroupWeight(weight: number | null): string | null {
  if (weight === null || Number.isNaN(weight)) return null;
  const pct = weight * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

/**
 * Ask the database which group a column with this slug belongs in.
 *
 * The routing rule lives in one place, `gradebook_column_group_for_slug`, and this is how the app
 * reaches it. Reimplementing the rule in TypeScript is how the codebase ended up with five copies
 * of the last one.
 */
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

/**
 * What a drag turned out to mean.
 *
 * With one flat sequence a drag was always the same operation: write a new integer. With two
 * levels it is one of three different things, and they are genuinely different — reordering
 * cannot change what a column belongs to, so moving a column into another group has to be a
 * separate call that says so.
 */
export type ColumnDragPlan =
  | { kind: "noop" }
  | { kind: "reorder-groups"; orderedGroupIds: number[] }
  | { kind: "reorder-in-group"; groupId: number; orderedColumnIds: number[] }
  | { kind: "move-column"; columnId: number; groupId: number; position: number };

/**
 * Work out which of the three a drag was, from the flat order the table produced.
 *
 * The table hands back one list of every column in its new left-to-right order, because that is
 * what a horizontal drag naturally produces. Reading the two levels back out of it:
 *
 *   - if every group's columns are still consecutive and no column changed group, the drag either
 *     moved a whole group past another one, or moved a column inside its own group;
 *   - if the dragged column has landed among another group's columns, it is a move between
 *     groups, and the caller will have to say so explicitly.
 */
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

  // First appearance of each group, which is the group order the drag implies.
  const impliedGroupOrder: number[] = [];
  for (const g of groupSequence) {
    if (!impliedGroupOrder.includes(g)) impliedGroupOrder.push(g);
  }

  // A group is "broken" when its columns are not consecutive, which only happens when something
  // from another group has landed in the middle of it.
  const broken = impliedGroupOrder.filter((g) => {
    const first = groupSequence.indexOf(g);
    const last = groupSequence.lastIndexOf(g);
    for (let i = first; i <= last; i++) {
      if (groupSequence[i] !== g) return true;
    }
    return false;
  });

  if (broken.length > 0) {
    // The dragged column is the one that moved, so the group it has landed inside is whichever
    // group surrounds its new index.
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
