import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { create, all } from "mathjs";
import { columnGroupCallSlugs, expandColumnGroup, referencedColumnGroupIds, slugListArgument } from "./columnGroups.ts";
import {
  EXAM_GROUP,
  FIXTURE_COLUMNS,
  FIXTURE_GROUPS,
  HOMEWORK_GROUP,
  HW_AVG_COLUMN,
  TOTAL_COLUMN
} from "./columnGroups.testFixture.ts";

const ALL_COLUMNS = [...FIXTURE_COLUMNS, TOTAL_COLUMN];
const math = create(all, {});

Deno.test("expandColumnGroup: display order, and the evaluated column left out", () => {
  const expanded = expandColumnGroup({
    groupSlug: "hw",
    groups: FIXTURE_GROUPS,
    columns: ALL_COLUMNS,
    excludeColumnId: TOTAL_COLUMN.id
  });
  assertEquals(expanded?.slugs, ["hw-1", "hw-2", "hw-3"]);
});

Deno.test("expandColumnGroup: another total of the same group is left out, a total of another group is not", () => {
  const examTotal = {
    ...HW_AVG_COLUMN,
    id: 9,
    slug: "exam-total",
    dependencies: { gradebook_column_groups: [EXAM_GROUP] }
  };
  const expanded = expandColumnGroup({
    groupSlug: "hw",
    groups: FIXTURE_GROUPS,
    columns: [...ALL_COLUMNS, HW_AVG_COLUMN, examTotal],
    excludeColumnId: TOTAL_COLUMN.id
  });
  assertEquals(expanded?.slugs, ["hw-1", "hw-2", "hw-3", "exam-total"]);
});

Deno.test("referencedColumnGroupIds: tolerates any stored dependencies shape", () => {
  assertEquals(referencedColumnGroupIds({ gradebook_column_groups: [HOMEWORK_GROUP] }), [HOMEWORK_GROUP]);
  assertEquals(referencedColumnGroupIds({ gradebook_columns: [1] }), []);
  assertEquals(referencedColumnGroupIds(null), []);
  assertEquals(referencedColumnGroupIds("junk"), []);
});

Deno.test("expandColumnGroup: unknown slug is undefined, empty group is []", () => {
  assertEquals(expandColumnGroup({ groupSlug: "nope", groups: FIXTURE_GROUPS, columns: ALL_COLUMNS }), undefined);
  assertEquals(expandColumnGroup({ groupSlug: "empty", groups: FIXTURE_GROUPS, columns: ALL_COLUMNS })?.slugs, []);
});

Deno.test("columnGroupCallSlugs: refuses anything but one string literal", () => {
  const membership = { groups: FIXTURE_GROUPS, columns: ALL_COLUMNS };
  assertEquals(columnGroupCallSlugs(math.parse('gradebook_columns("hw-1")'), membership), null);
  assertThrows(
    () => columnGroupCallSlugs(math.parse("gradebook_column_group(hw)"), membership),
    Error,
    "takes one group slug in quotes"
  );
  assertThrows(
    () => columnGroupCallSlugs(math.parse('gradebook_column_group("nope")'), membership),
    Error,
    "Invalid dependency: nope for function gradebook_column_group"
  );
});

Deno.test("slugListArgument: reads the Matrix an ArrayNode evaluates to", () => {
  assertEquals(slugListArgument(math.evaluate('["a", "b"]')), ["a", "b"]);
  assertEquals(slugListArgument(["a"]), ["a"]);
  assertEquals(slugListArgument("a"), null);
});
