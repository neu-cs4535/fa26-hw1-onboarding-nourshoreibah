/**
 * Grouping had no unit coverage at all. It was a memo inside a 4,000-line component, duplicated
 * into a second component, with three more partial copies alongside it, and the only thing any
 * test said about it was that a "Expand All" button existed.
 *
 * These cover the shaping and the drag planning now that both are ordinary functions.
 */
import {
  buildColumnGroupKeyMap,
  buildGroupedColumns,
  formatGroupWeight,
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
    weight: null,
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
    // Every group starts again at zero, so position on its own puts one column of each group
    // first, then the next of each, which is a plausible order and the wrong one.
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
    // This is the case the old heuristic could not represent. A family split by a deleted column
    // produced two groups both rendering "Quiz", and collapse state was keyed on that text, so
    // collapsing one collapsed both.
    const groups = [group(1, "Quiz", 0), group(2, "Quiz", 1)];
    const columns = [col(11, 1, 0), col(12, 1, 1), col(13, 2, 0)];

    const grouped = buildGroupedColumns(columns, groups);

    expect(Object.keys(grouped)).toHaveLength(2);
    expect(grouped[groupKey(groups[0])].columns.map((c) => c.id)).toEqual([11, 12]);
    expect(grouped[groupKey(groups[1])].columns.map((c) => c.id)).toEqual([13]);
    expect(grouped[groupKey(groups[0])].groupName).toBe(grouped[groupKey(groups[1])].groupName);
  });

  it("omits a group whose columns are all hidden instead of leaving an empty header", () => {
    // A student's column list has instructor-only and unreleased columns filtered out of it.
    const groups = [group(1, "Labs", 0), group(2, "Hidden", 1)];
    const visibleToStudent = [col(11, 1, 0)];

    const grouped = buildGroupedColumns(visibleToStudent, groups);

    expect(Object.keys(grouped)).toEqual([groupKey(groups[0])]);
    expect(visibleGroupsInOrder(visibleToStudent, groups).map((g) => g.name)).toEqual(["Labs"]);
  });

  it("does not split a group when a column is filtered out of the middle of it", () => {
    // The old grouping started a new group whenever sort_order skipped a number, so filtering a
    // column out of a student's list split the group around the hole and showed them groups no
    // instructor ever saw. Membership is a foreign key now, so a gap is just a gap.
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
  const groups = [group(1, "Labs", 0), group(2, "Exams", 1)];
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
      draggedColumnId: 12
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [12, 11] });
  });

  it("reads a whole group moving past another as a group reorder", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [21, 22, 11, 12],
      groupIdByColumnId,
      currentGroupOrder,
      draggedColumnId: 21
    });
    expect(plan).toEqual({ kind: "reorder-groups", orderedGroupIds: [2, 1] });
  });

  it("reads a column landing among another group's columns as a move, never a reorder", () => {
    // The distinction is the whole point. A reorder writes positions and cannot change
    // membership, so a drag that changes membership has to come out as a different operation.
    const plan = planColumnDrag({
      orderedColumnIds: [11, 21, 12, 22],
      groupIdByColumnId,
      currentGroupOrder,
      draggedColumnId: 21
    });
    expect(plan).toEqual({ kind: "move-column", columnId: 21, groupId: 1, position: 1 });
  });

  it("leaves an unchanged order alone", () => {
    const plan = planColumnDrag({
      orderedColumnIds: [11, 12, 21, 22],
      groupIdByColumnId,
      currentGroupOrder,
      draggedColumnId: 11
    });
    expect(plan).toEqual({ kind: "reorder-in-group", groupId: 1, orderedColumnIds: [11, 12] });
  });
});

describe("weights", () => {
  it("reads a share of the course as a percentage", () => {
    expect(formatGroupWeight(0.4)).toBe("40%");
    expect(formatGroupWeight(0.125)).toBe("12.5%");
  });

  it("says nothing when a group carries no weight", () => {
    expect(formatGroupWeight(null)).toBeNull();
  });
});
