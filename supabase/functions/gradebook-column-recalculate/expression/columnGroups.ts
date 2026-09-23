// Shared by the Deno recalculator and the browser evaluators, so it must stay import-free.

export const COLUMN_GROUP_FUNCTION = "gradebook_column_group";

/**
 * `gradebook_columns([...])` receives a mathjs Matrix, not a JS array, because an ArrayNode
 * evaluates to a Matrix. Returns the slugs for either shape, or null for a single slug.
 */
export function slugListArgument(input: unknown): string[] | null {
  if (Array.isArray(input)) return input as string[];
  const matrix = input as { toArray?: () => unknown } | null;
  if (matrix && typeof matrix === "object" && typeof matrix.toArray === "function") {
    return (matrix.toArray() as unknown[]).flat() as string[];
  }
  return null;
}

export type ColumnGroupRef = { id: number; slug: string };

export type ColumnGroupMember = {
  id: number;
  slug: string | null;
  gradebook_column_group_id: number;
  position_in_group: number;
  /** The column's stored `dependencies` JSON. Only `gradebook_column_groups` is read. */
  dependencies?: unknown;
};

/** The group ids a column's stored `dependencies` JSON says its expression references. */
export function referencedColumnGroupIds(dependencies: unknown): number[] {
  if (!dependencies || typeof dependencies !== "object") return [];
  const ids = (dependencies as { gradebook_column_groups?: unknown }).gradebook_column_groups;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
}

export type ExpandedColumnGroup = { groupId: number; columnIds: number[]; slugs: string[] };

/**
 * The one definition of group membership: the group's columns in display order
 * (position_in_group, then id). Two kinds of member are left out, so a total column can
 * live inside the group it totals:
 * - `excludeColumnId`, the column being evaluated;
 * - any member whose own dependencies reference this group, i.e. another total of it.
 *   Without this, two totals in one group would each count the other.
 * Returns undefined for an unknown slug.
 */
export function expandColumnGroup(args: {
  groupSlug: string;
  groups: readonly ColumnGroupRef[];
  columns: readonly ColumnGroupMember[];
  excludeColumnId?: number | null;
}): ExpandedColumnGroup | undefined {
  const group = args.groups.find((g) => g.slug === args.groupSlug);
  if (!group) return undefined;
  const members = args.columns
    .filter(
      (c) =>
        c.gradebook_column_group_id === group.id &&
        c.id !== args.excludeColumnId &&
        c.slug &&
        !referencedColumnGroupIds(c.dependencies).includes(group.id)
    )
    .sort((a, b) => a.position_in_group - b.position_in_group || a.id - b.id);
  return {
    groupId: group.id,
    columnIds: members.map((c) => c.id),
    slugs: members.map((c) => c.slug as string)
  };
}

type CallLike = { type: string; fn?: { name?: string }; args?: readonly { type: string; value?: unknown }[] };

function isColumnGroupCall(node: unknown): node is CallLike {
  const n = node as CallLike | null;
  return !!n && n.type === "FunctionNode" && n.fn?.name === COLUMN_GROUP_FUNCTION;
}

/** The group slug a `gradebook_column_group(...)` call names. Only a single string literal is accepted. */
export function columnGroupSlugArgument(node: CallLike): string {
  const args = node.args ?? [];
  const arg = args[0];
  if (args.length !== 1 || arg.type !== "ConstantNode" || typeof arg.value !== "string") {
    throw new Error(
      `${COLUMN_GROUP_FUNCTION}() takes one group slug in quotes, e.g. ${COLUMN_GROUP_FUNCTION}("homework")`
    );
  }
  return arg.value;
}

export function unknownColumnGroupError(slug: string): string {
  return `Invalid dependency: ${slug} for function ${COLUMN_GROUP_FUNCTION}`;
}

export class UnknownColumnGroupError extends Error {
  constructor(slug: string) {
    super(unknownColumnGroupError(slug));
    this.name = "UnknownColumnGroupError";
  }
}

/**
 * If `node` is a `gradebook_column_group("x")` call, the member slugs it stands for;
 * otherwise null. Evaluators replace the call with `gradebook_columns([...slugs])`,
 * so everything downstream (mean, drop_lowest, privacy, missing and excused handling)
 * is the existing `gradebook_columns` path.
 */
export function columnGroupCallSlugs(
  node: unknown,
  membership: { groups: readonly ColumnGroupRef[]; columns: readonly ColumnGroupMember[] },
  excludeColumnId?: number | null
): string[] | null {
  if (!isColumnGroupCall(node)) return null;
  const groupSlug = columnGroupSlugArgument(node);
  const expanded = expandColumnGroup({ groupSlug, ...membership, excludeColumnId });
  if (!expanded) throw new UnknownColumnGroupError(groupSlug);
  return expanded.slugs;
}
