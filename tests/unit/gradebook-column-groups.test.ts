import {
  buildColumnGroupKeyMap,
  buildGroupedColumns,
  groupKey,
  planColumnDrag,
  sortColumnsForDisplay,
  visibleGroupsInOrder,
  type GradebookColumnGroup
} from "@/lib/gradebookColumnGroups";

function group(id: number, name: string, sort_order: number, extra: Partial<GradebookColumnGroup> = {}) {
  return {
    id,
    name,
    sort_order,
    slug: name.toLowerCase(),
    class_id: 1,
    gradebook_id: 1,
    created_at: "",
    updated_at: "",
    description: null,
    is_default: false,
    auto_assign_slug_base: null,
    name_is_auto: true,
    ...extra
  } as GradebookColumnGroup;
}

const col = (id: number, gradebook_column_group_id: number, position_in_group: number) => ({
  id,
  gradebook_column_group_id,
  position_in_group
});

describe("display order", () => {
  const groups = [group(10, "Quiz", 1), group(20, "Lab", 0)];

  it("orders by the group first and the position within it second", () => {
    const columns = [col(1, 10, 0), col(2, 20, 1), col(3, 10, 1), col(4, 20, 0)];
    expect(sortColumnsForDisplay(columns, groups).map((c) => c.id)).toEqual([4, 2, 1, 3]);
  });

  it("does not interleave groups, which sorting on position alone would", () => {
    const columns = [col(1, 10, 0), col(2, 20, 0), col(3, 10, 1), col(4, 20, 1)];
    const ids = sortColumnsForDisplay(columns, groups).map((c) => c.id);
    expect(ids).toEqual([2, 4, 1, 3]);
  });

  it("sends a column whose group is unknown to the end rather than to the front", () => {
    const columns = [col(9, 999, 0), col(1, 20, 0)];
    expect(sortColumnsForDisplay(columns, groups).map((c) => c.id)).toEqual([1, 9]);
  });
});

describe("grouping", () => {
  it("keys on the group id, so two groups sharing a header stay distinct", () => {
    const groups = [group(1, "Quiz", 0), group(2, "Quiz", 1)];
    const columns = [col(11, 1, 0), col(12, 1, 1), col(13, 2, 0)];

    const grouped = buildGroupedColumns(columns, groups);

    expect(Object.keys(grouped)).toHaveLength(2);
    expect(grouped[groupKey(groups[0])].columns.map((c) => c.id)).toEqual([11, 12]);
    expect(grouped[groupKey(groups[1])].columns.map((c) => c.id)).toEqual([13]);
    expect(grouped[groupKey(groups[0])].groupName).toBe(grouped[groupKey(groups[1])].groupName);
  });

  it("omits a group whose columns are all hidden instead of leaving an empty header", () => {
    const groups = [group(1, "Labs", 0), group(2, "Hidden", 1)];
    const visibleToStudent = [col(11, 1, 0)];

    const grouped = buildGroupedColumns(visibleToStudent, groups);

    expect(Object.keys(grouped)).toEqual([groupKey(groups[0])]);
    expect(visibleGroupsInOrder(visibleToStudent, groups).map((g) => g.name)).toEqual(["Labs"]);
  });

  it("does not split a group when a column is filtered out of the middle of it", () => {
    const groups = [group(1, "Skills", 0)];
    const afterFiltering = [col(11, 1, 0), col(13, 1, 2)];

    const grouped = buildGroupedColumns(afterFiltering, groups);

    expect(Object.keys(grouped)).toHaveLength(1);
    expect(grouped[groupKey(groups[0])].columns.map((c) => c.id)).toEqual([11, 13]);
  });

  it("maps every column to the key of the group it renders under", () => {
    const groups = [group(1, "Labs", 0), group(2, "Exams", 1)];
    const columns = [col(11, 1, 0), col(21, 2, 0)];
    const map = buildColumnGroupKeyMap(columns, groups);
    expect(map.get(11)).toBe(groupKey(groups[0]));
    expect(map.get(21)).toBe(groupKey(groups[1]));
  });
});

describe("what a drag turned out to mean", () => {
  const groupIdByColumnId = new Map([
    [11, 1],
    [12, 1],
    [21, 2],
    [22, 2]
  ]);
  const currentGroupOrder = [1, 2];

  it("reads a swap inside one group as an in-group reorder", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [12, 11, 21, 22],
      groupIdByColumnId,
      currentGroupOrder,
      defaultGroupId: null,
      draggedColumnId: 12
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [12, 11] });
  });

  it("reads a whole group moving past another as a group reorder", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [21, 22, 11, 12],
      groupIdByColumnId,
      currentGroupOrder,
      defaultGroupId: null,
      draggedColumnId: 21
    });
    expect(plan).toEqual({ kind: "reorder-groups", orderedGroupIds: [2, 1] });
  });

  it("reads a column landing among another group's columns as a move, never a reorder", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [11, 21, 12, 22],
      groupIdByColumnId,
      currentGroupOrder,
      defaultGroupId: null,
      draggedColumnId: 21
    });
    expect(plan).toEqual({ kind: "move-column", columnId: 21, groupId: 1, position: 1 });
  });

  it("leaves an unchanged order alone", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [11, 12, 21, 22],
      groupIdByColumnId,
      currentGroupOrder,
      defaultGroupId: null,
      draggedColumnId: 11
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [11, 12] });
  });
});

describe("dragging with an empty group and a populated default group", () => {
  const DEFAULT = 99;
  const groupIdByColumnId = new Map([
    [11, 1],
    [12, 1],
    [21, 2],
    [22, 2],
    [31, 3],
    [91, DEFAULT],
    [92, DEFAULT]
  ]);
  // Group 5 has no columns and sits between 1 and 2.
  const currentGroupOrder = [1, 5, 2, 3];
  const base = { groupIdByColumnId, currentGroupOrder, defaultGroupId: DEFAULT };

  it("reads a swap inside one group as an in-group reorder even when an empty group exists", () => {
    const plan = planColumnDrag({
      ...base,
      orderedColumnIds: [12, 11, 21, 22, 31, 91, 92],
      draggedColumnId: 12
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [12, 11] });
  });

  it("reads a swap inside the default group as an in-group reorder", () => {
    const plan = planColumnDrag({
      ...base,
      orderedColumnIds: [11, 12, 21, 22, 31, 92, 91],
      draggedColumnId: 92
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: DEFAULT, orderedColumnIds: [92, 91] });
  });

  it("reads a swap inside a group as an in-group reorder while the default group holds columns", () => {
    const plan = planColumnDrag({
      ...base,
      orderedColumnIds: [11, 12, 22, 21, 31, 91, 92],
      draggedColumnId: 22
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 2, orderedColumnIds: [22, 21] });
  });

  it("sends every non-default group, empty ones included, and never the default group", () => {
    const plan = planColumnDrag({
      ...base,
      orderedColumnIds: [21, 22, 11, 12, 31, 91, 92],
      draggedColumnId: 21
    });
    expect(plan).toEqual({ kind: "reorder-groups", orderedGroupIds: [2, 5, 1, 3] });
  });

  it("moves a group's only column past another group as a group reorder", () => {
    const plan = planColumnDrag({
      ...base,
      orderedColumnIds: [11, 12, 31, 21, 22, 91, 92],
      draggedColumnId: 31
    });
    expect(plan).toEqual({ kind: "reorder-groups", orderedGroupIds: [1, 5, 3, 2] });
  });

  it("does nothing when a lone column only moves past the default group, which stays last", () => {
    const groupIds = new Map([
      [11, 1],
      [12, 1],
      [31, 3],
      [91, DEFAULT]
    ]);
    const plan = planColumnDrag({
      groupIdByColumnId: groupIds,
      currentGroupOrder: [1, 3],
      defaultGroupId: DEFAULT,
      orderedColumnIds: [11, 12, 91, 31],
      draggedColumnId: 31
    });
    expect(plan).toEqual({ kind: "noop" });
  });

  it("does nothing when the default group's only column is dragged in front of other groups", () => {
    const groupIds = new Map([
      [11, 1],
      [21, 2],
      [91, DEFAULT]
    ]);
    const plan = planColumnDrag({
      groupIdByColumnId: groupIds,
      currentGroupOrder: [1, 2],
      defaultGroupId: DEFAULT,
      orderedColumnIds: [91, 11, 21],
      draggedColumnId: 91
    });
    expect(plan).toEqual({ kind: "noop" });
  });
});

describe("display order with the default group pinned at the top of int4", () => {
  it("puts the default group last and an unknown group after it", () => {
    const groups = [group(1, "Ungrouped", 2147483647, { is_default: true }), group(2, "Labs", 1), group(3, "Quiz", 0)];
    const columns = [col(11, 1, 0), col(21, 2, 0), col(31, 3, 0), col(41, 999, 0)];
    expect(sortColumnsForDisplay(columns, groups).map((c) => c.id)).toEqual([31, 21, 11, 41]);
    expect(visibleGroupsInOrder(columns, groups).map((g) => g.id)).toEqual([3, 2, 1]);
  });
});
