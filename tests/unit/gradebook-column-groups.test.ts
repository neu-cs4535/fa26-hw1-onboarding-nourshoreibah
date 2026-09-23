import {
  buildColumnGroupKeyMap,
  buildGroupedColumns,
  columnLayoutPatches,
  groupKey,
  groupOrderPatches,
  groupSlugProblem,
  planColumnDrop,
  slugForGroupName,
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

describe("what dropping a column does", () => {
  const DEFAULT = 99;
  const groupIdByColumnId = new Map([
    [11, 1],
    [12, 1],
    [21, 2],
    [22, 2],
    [31, 3],
    [41, 4],
    [91, DEFAULT]
  ]);
  const orderedColumnIds = [11, 12, 21, 22, 31, 41, 91];
  const drop = (draggedColumnId: number, groupId: number, beforeColumnId: number | null) =>
    planColumnDrop({ orderedColumnIds, groupIdByColumnId, draggedColumnId, target: { groupId, beforeColumnId } });

  it("reorders within a group", () => {
    expect(drop(12, 1, 11)).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [12, 11] });
  });

  it("moves a group's only column into another single-column group, rather than swapping the groups", () => {
    expect(drop(31, 4, null)).toEqual({ kind: "move-column", columnId: 31, groupId: 4, position: 1 });
    expect(drop(31, 4, 41)).toEqual({ kind: "move-column", columnId: 31, groupId: 4, position: 0 });
  });

  it("lands before the named column of another group", () => {
    expect(drop(21, 1, 12)).toEqual({ kind: "move-column", columnId: 21, groupId: 1, position: 1 });
  });

  it("puts a column at the end of a group when no column is named", () => {
    expect(drop(11, 2, null)).toEqual({ kind: "move-column", columnId: 11, groupId: 2, position: 2 });
  });

  it("moves into the default group like any other", () => {
    expect(drop(41, DEFAULT, 91)).toEqual({ kind: "move-column", columnId: 41, groupId: DEFAULT, position: 0 });
  });

  it("moves into an empty group at position 0", () => {
    expect(drop(11, 5, null)).toEqual({ kind: "move-column", columnId: 11, groupId: 5, position: 0 });
  });

  it("does nothing when the column lands where it already is", () => {
    expect(drop(11, 1, 12)).toEqual({ kind: "noop" });
    expect(drop(12, 1, null)).toEqual({ kind: "noop" });
  });

  it("does nothing for a column it does not know", () => {
    expect(drop(777, 1, null)).toEqual({ kind: "noop" });
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

describe("the rows a drop changes before the save returns", () => {
  const groupIdByColumnId = new Map([
    [11, 1],
    [12, 1],
    [13, 1],
    [21, 2],
    [22, 2]
  ]);
  const orderedColumnIds = [11, 12, 13, 21, 22];
  const patches = (plan: Parameters<typeof columnLayoutPatches>[0]["plan"]) =>
    columnLayoutPatches({ plan, orderedColumnIds, groupIdByColumnId });

  it("renumbers a reordered group from zero, in its new order", () => {
    expect(patches({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [13, 11, 12] })).toEqual([
      { id: 13, values: { position_in_group: 0 } },
      { id: 11, values: { position_in_group: 1 } },
      { id: 12, values: { position_in_group: 2 } }
    ]);
  });

  it("closes the gap in the old group and opens one in the new, moving only the dragged column's group", () => {
    expect(patches({ kind: "move-column", columnId: 12, groupId: 2, position: 1 })).toEqual([
      { id: 11, values: { position_in_group: 0 } },
      { id: 13, values: { position_in_group: 1 } },
      { id: 21, values: { position_in_group: 0 } },
      { id: 12, values: { gradebook_column_group_id: 2, position_in_group: 1 } },
      { id: 22, values: { position_in_group: 2 } }
    ]);
  });

  it("puts a column moved into an empty group at position 0", () => {
    expect(patches({ kind: "move-column", columnId: 22, groupId: 7, position: 0 })).toEqual([
      { id: 21, values: { position_in_group: 0 } },
      { id: 22, values: { gradebook_column_group_id: 7, position_in_group: 0 } }
    ]);
  });

  it("clamps a position past the end of the group to the end", () => {
    const moved = patches({ kind: "move-column", columnId: 11, groupId: 2, position: 99 });
    expect(moved.find((p) => p.id === 11)).toEqual({
      id: 11,
      values: { gradebook_column_group_id: 2, position_in_group: 2 }
    });
  });

  it("changes nothing for a noop", () => {
    expect(patches({ kind: "noop" })).toEqual([]);
  });

  it("numbers groups by their new order", () => {
    expect(groupOrderPatches([5, 3, 9])).toEqual([
      { id: 5, values: { sort_order: 0 } },
      { id: 3, values: { sort_order: 1 } },
      { id: 9, values: { sort_order: 2 } }
    ]);
  });
});

describe("group slugs", () => {
  it("derives a slug from the name, lowercase with single hyphens", () => {
    expect(slugForGroupName("Homework", [])).toBe("homework");
    expect(slugForGroupName("  Lab Reports (Fall '26)! ", [])).toBe("lab-reports-fall-26");
  });

  it("adds -2, -3 until the slug is unused", () => {
    expect(slugForGroupName("Homework", ["homework"])).toBe("homework-2");
    expect(slugForGroupName("Homework", ["homework", "homework-2"])).toBe("homework-3");
  });

  it("falls back to group for a name with no letters or digits", () => {
    expect(slugForGroupName("!!!", [])).toBe("group");
  });

  it("accepts a well-formed unused slug", () => {
    expect(groupSlugProblem("lab-reports", ["homework"])).toBeNull();
  });

  it("rejects capitals, spaces, underscores and stray hyphens", () => {
    for (const bad of ["Homework", "lab reports", "lab_reports", "-lab", "lab-", "lab--reports", ""]) {
      expect(groupSlugProblem(bad, [])).toMatch(/lowercase letters/);
    }
  });

  it("rejects a slug another group already uses", () => {
    expect(groupSlugProblem("homework", ["homework"])).toMatch(/already uses/);
  });
});
