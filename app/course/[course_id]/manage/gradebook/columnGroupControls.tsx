"use client";

import { Label } from "@/components/ui/label";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { Tooltip as WrappedTooltip } from "@/components/ui/tooltip";
import { useGradebookColumnGroups, useGradebookColumns, useGradebookController } from "@/hooks/useGradebook";
import {
  groupSlugProblem,
  slugForGroupName,
  sortColumnsForDisplay,
  type GradebookColumnGroup
} from "@/lib/gradebookColumnGroups";
import { createClient } from "@/utils/supabase/client";
import {
  Box,
  Button,
  Code,
  Dialog,
  HStack,
  Icon,
  IconButton,
  Input,
  Portal,
  Tag,
  Text,
  VStack
} from "@chakra-ui/react";
import { useDraggable } from "@dnd-kit/core";
import { Select, type GroupBase } from "chakra-react-select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FiChevronDown } from "react-icons/fi";
import {
  LuArrowLeft,
  LuArrowRight,
  LuChevronsLeftRight,
  LuChevronsRightLeft,
  LuGripVertical,
  LuPencil,
  LuPlus,
  LuTrash2
} from "react-icons/lu";

type ColumnOption = { value: number; label: string };

/** Draggable ids for groups, alongside the `grade_<id>` ids columns use. */
export const GROUP_DRAG_PREFIX = "group_";

/**
 * Each group gets a color so its band and the top edge of each of its column headers match, which
 * is what makes membership readable across a wide table. Ungrouped stays gray.
 */
const GROUP_PALETTES = ["blue", "purple", "teal", "orange", "pink", "cyan", "green", "yellow"] as const;

export function groupPalette(group: Pick<GradebookColumnGroup, "is_default"> | undefined, index: number): string {
  if (!group || group.is_default) return "gray";
  return GROUP_PALETTES[index % GROUP_PALETTES.length];
}

export type ColumnGroupActions = {
  onEdit: (group: GradebookColumnGroup) => void;
  onDelete: (group: GradebookColumnGroup) => void;
  onAddColumn: (group: GradebookColumnGroup) => void;
  onMove: (group: GradebookColumnGroup, delta: -1 | 1) => void;
  onToggleCollapse: (group: GradebookColumnGroup) => void;
};

function ColumnGroupOptionsMenu({
  group,
  actions,
  canMoveLeft,
  canMoveRight,
  isLayoutSaving = false
}: {
  group: GradebookColumnGroup;
  actions: ColumnGroupActions;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** A layout save is in flight; moving the group now would race it. */
  isLayoutSaving?: boolean;
}) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <IconButton
          size="2xs"
          variant="surface"
          aria-label={`Options for group ${group.name}`}
          flexShrink={0}
          borderRadius={0}
        >
          <Icon as={FiChevronDown} />
        </IconButton>
      </MenuTrigger>
      <MenuContent minW="180px">
        <MenuItem value="edit" onClick={() => actions.onEdit(group)}>
          <Icon as={LuPencil} boxSize={3} mr={2} />
          Edit group
        </MenuItem>
        <MenuItem value="add-column" onClick={() => actions.onAddColumn(group)}>
          <Icon as={LuPlus} boxSize={3} mr={2} />
          Add column to group
        </MenuItem>
        <MenuSeparator />
        <MenuItem value="move-left" disabled={!canMoveLeft || isLayoutSaving} onClick={() => actions.onMove(group, -1)}>
          <Icon as={LuArrowLeft} boxSize={3} mr={2} />
          Move group left
        </MenuItem>
        <MenuItem
          value="move-right"
          disabled={!canMoveRight || isLayoutSaving}
          onClick={() => actions.onMove(group, 1)}
        >
          <Icon as={LuArrowRight} boxSize={3} mr={2} />
          Move group right
        </MenuItem>
        <MenuSeparator />
        <MenuItem value="delete" color="fg.error" onClick={() => actions.onDelete(group)}>
          <Icon as={LuTrash2} boxSize={3} mr={2} />
          Delete group
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

/**
 * The band over a group's columns: name, column count, collapse toggle, drag handle and options.
 * Anyone can collapse a group; only instructors get the drag handle and the options menu.
 */
export function ColumnGroupHeader({
  group,
  palette,
  left,
  width,
  columnCount,
  isCollapsed,
  isInstructor,
  actions,
  canMoveLeft,
  canMoveRight,
  isDragging,
  dragDisabled,
  anyDragging,
  isLayoutSaving = false
}: {
  group: GradebookColumnGroup;
  palette: string;
  left: number;
  width: number;
  columnCount: number;
  isCollapsed: boolean;
  isInstructor: boolean;
  actions: ColumnGroupActions;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  isDragging: boolean;
  dragDisabled: boolean;
  anyDragging: boolean;
  /** A layout save is in flight: Move group left/right are disabled until it settles. */
  isLayoutSaving?: boolean;
}) {
  const movable = isInstructor && !group.is_default;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `${GROUP_DRAG_PREFIX}${group.id}`,
    disabled: !movable || dragDisabled
  });
  const narrow = width < 170;
  // A collapsed group's strip is too thin for a name; the strip below shows it running down.
  const compact = width < 60;
  const countLabel = columnCount === 0 ? "empty" : String(columnCount);
  // A collapsed strip is too narrow for the chevron; the strip under it expands the group instead.
  const showCollapseToggle = (columnCount > 1 || isCollapsed) && !(compact && isCollapsed);

  return (
    <Box
      ref={setNodeRef}
      position="absolute"
      left={`${left}px`}
      top={0}
      w={`${width}px`}
      h="36px"
      colorPalette={palette}
      className="group"
      bg="bg.subtle"
      borderTop="2px solid"
      borderTopColor={group.is_default ? "transparent" : "colorPalette.solid"}
      borderLeft="2px solid"
      borderLeftColor="border.emphasized"
      borderBottom="1px solid"
      borderBottomColor="border.emphasized"
      display="flex"
      alignItems="center"
      gap={1}
      px={compact ? 1 : 2}
      overflow="hidden"
      opacity={isDragging ? 0.4 : 1}
      pointerEvents={anyDragging ? "none" : "auto"}
      role="group"
      aria-label={`Column group ${group.name} (${countLabel})`}
      data-group-id={group.id}
    >
      {movable && (
        <Box
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder group ${group.name}`}
          cursor={dragDisabled ? "not-allowed" : "grab"}
          _active={{ cursor: "grabbing" }}
          display="flex"
          flexShrink={0}
        >
          <Icon as={LuGripVertical} boxSize={3} color="fg.muted" />
        </Box>
      )}
      {showCollapseToggle && (
        <WrappedTooltip content={isCollapsed ? "Expand group" : "Collapse group"}>
          <IconButton
            size="2xs"
            variant="ghost"
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} group ${group.name}`}
            aria-expanded={!isCollapsed}
            flexShrink={0}
            onClick={() => actions.onToggleCollapse(group)}
          >
            <Icon as={isCollapsed ? LuChevronsLeftRight : LuChevronsRightLeft} />
          </IconButton>
        </WrappedTooltip>
      )}
      {!compact && (
        <WrappedTooltip content={`${group.name} · ${group.slug}`}>
          <Text fontWeight="semibold" fontSize="sm" color={group.is_default ? "fg.muted" : "fg"} truncate minW={0}>
            {group.name}
          </Text>
        </WrappedTooltip>
      )}
      {!narrow && (
        <Text fontSize="xs" color="fg.subtle" flexShrink={0}>
          ({countLabel})
        </Text>
      )}
      <Box flex="1" />
      {movable && (
        <Box flexShrink={0}>
          <ColumnGroupOptionsMenu
            group={group}
            actions={actions}
            canMoveLeft={canMoveLeft}
            canMoveRight={canMoveRight}
            isLayoutSaving={isLayoutSaving}
          />
        </Box>
      )}
    </Box>
  );
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Unexpected error";
}

/** Create a group (optionally moving existing columns into it) or edit one's name and slug. */
export function ColumnGroupDialog({
  mode,
  group,
  onClose
}: {
  mode: "create" | "edit";
  group?: GradebookColumnGroup;
  onClose: () => void;
}) {
  const gradebookController = useGradebookController();
  const groups = useGradebookColumnGroups();
  const columns = useGradebookColumns();
  const supabase = useMemo(() => createClient(), []);

  const [name, setName] = useState(group?.name ?? "");
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(mode === "edit");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const otherSlugs = useMemo(() => groups.filter((g) => g.id !== group?.id).map((g) => g.slug), [groups, group]);

  useEffect(() => {
    if (!slugEdited) setSlug(name.trim() ? slugForGroupName(name, otherSlugs) : "");
  }, [name, slugEdited, otherSlugs]);

  const slugError = slug ? groupSlugProblem(slug, otherSlugs) : null;
  const groupNameById = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const orderedColumns = useMemo(() => sortColumnsForDisplay(columns, groups), [columns, groups]);
  /** Every column, grouped under the group it is in now, so a long gradebook stays searchable. */
  const columnOptions = useMemo(() => {
    const byGroup = new Map<number, ColumnOption[]>();
    for (const c of orderedColumns) {
      const list = byGroup.get(c.gradebook_column_group_id) ?? [];
      list.push({ value: c.id, label: c.name });
      byGroup.set(c.gradebook_column_group_id, list);
    }
    return [...byGroup.entries()].map(([groupId, options]) => ({
      label: groupNameById.get(groupId) ?? "Ungrouped",
      options
    }));
  }, [orderedColumns, groupNameById]);
  const selectedOptions = useMemo(
    () => orderedColumns.filter((c) => selected.has(c.id)).map((c) => ({ value: c.id, label: c.name })),
    [orderedColumns, selected]
  );

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || !slug || slugError) return;
    setBusy(true);
    try {
      if (mode === "create") {
        // The server assigns sort_order on insert; the type still wants one, so send our best guess.
        const nextSortOrder =
          groups.filter((g) => !g.is_default).reduce((max, g) => Math.max(max, g.sort_order), -1) + 1;
        const { data: created, error } = await supabase
          .from("gradebook_column_groups")
          .insert({
            class_id: gradebookController.class_id,
            gradebook_id: gradebookController.gradebook_id,
            name: trimmed,
            slug,
            sort_order: nextSortOrder,
            name_is_auto: false
          })
          .select("id")
          .single();
        if (error) throw error;
        // From here the group exists, so the dialog closes whatever happens: leaving it open
        // invites a second Create and a duplicate group.
        const toMove = orderedColumns.filter((c) => selected.has(c.id));
        let moved = 0;
        let moveError: unknown = null;
        for (const column of toMove) {
          const { error: assignError } = await supabase.rpc("gradebook_column_assign_group", {
            p_column_id: column.id,
            p_group_id: created.id
          });
          if (assignError) {
            moveError = assignError;
            break;
          }
          moved++;
        }
        void gradebookController.reconcileLayout();
        if (moveError) {
          toaster.error({
            title: `Group ${trimmed} created, but only ${moved} of ${toMove.length} columns moved into it`,
            description: errorMessage(moveError)
          });
        } else {
          toaster.create({ title: "Group created", type: "success" });
        }
        onClose();
        return;
      }
      if (group) {
        const values: { name?: string; slug?: string } = {};
        if (trimmed !== group.name) values.name = trimmed;
        if (slug !== group.slug) values.slug = slug;
        if (Object.keys(values).length > 0) {
          const { error } = await supabase.from("gradebook_column_groups").update(values).eq("id", group.id);
          if (error) throw error;
        }
        void gradebookController.reconcileLayout();
        toaster.create({ title: "Group saved", type: "success" });
        onClose();
      }
    } catch (e) {
      toaster.error({
        title: mode === "create" ? "Could not create the group" : "Could not save the group",
        description: errorMessage(e)
      });
    } finally {
      setBusy(false);
    }
  }, [name, slug, slugError, mode, groups, supabase, gradebookController, orderedColumns, selected, group, onClose]);

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} size="md" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{mode === "create" ? "Add Column Group" : "Edit Column Group"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Label htmlFor="column-group-name">Name</Label>
                  <Input
                    id="column-group-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Homework"
                    autoFocus
                  />
                </Box>
                <Box>
                  <Label htmlFor="column-group-slug">Slug</Label>
                  <Input
                    id="column-group-slug"
                    fontFamily="mono"
                    spellCheck={false}
                    value={slug}
                    onChange={(e) => {
                      setSlugEdited(true);
                      setSlug(e.target.value.trim());
                    }}
                    placeholder="homework"
                  />
                  {slugError ? (
                    <Text color="fg.error" fontSize="sm" mt={1}>
                      {slugError}
                    </Text>
                  ) : (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Score expressions name the group by its slug, e.g.{" "}
                      <Code>mean(gradebook_column_group(&quot;{slug || "homework"}&quot;))</Code>. A slug an expression
                      uses cannot be changed.
                    </Text>
                  )}
                </Box>
                {mode === "create" && orderedColumns.length > 0 && (
                  <Box>
                    <Label htmlFor="column-group-move-columns">Move columns into this group</Label>
                    <Select<ColumnOption, true, GroupBase<ColumnOption>>
                      inputId="column-group-move-columns"
                      size="sm"
                      isMulti
                      isSearchable
                      closeMenuOnSelect={false}
                      hideSelectedOptions
                      // The chips below show the selection, so the control stays one line however many
                      // columns are picked.
                      controlShouldRenderValue={false}
                      isClearable={false}
                      placeholder={
                        selected.size > 0 ? `${selected.size} selected. Search for more…` : "Search columns…"
                      }
                      options={columnOptions}
                      value={selectedOptions}
                      onChange={(options) => setSelected(new Set(options.map((o) => o.value)))}
                      menuPlacement="auto"
                      chakraStyles={{
                        control: (provided) => ({ ...provided, bg: "bg.surface", borderColor: "border.emphasized" }),
                        menu: (provided) => ({
                          ...provided,
                          bg: "bg.surface",
                          border: "1px solid",
                          borderColor: "border.muted",
                          zIndex: 10
                        })
                      }}
                    />
                    {selectedOptions.length > 0 && (
                      <HStack wrap="wrap" gap={1} mt={2}>
                        {selectedOptions.map((o) => (
                          <Tag.Root key={o.value} size="sm" variant="subtle">
                            <Tag.Label>{o.label}</Tag.Label>
                            <Tag.EndElement>
                              <Tag.CloseTrigger
                                aria-label={`Remove ${o.label}`}
                                onClick={() =>
                                  setSelected((prev) => {
                                    const next = new Set(prev);
                                    next.delete(o.value);
                                    return next;
                                  })
                                }
                              />
                            </Tag.EndElement>
                          </Tag.Root>
                        ))}
                      </HStack>
                    )}
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                loading={busy}
                disabled={!name.trim() || !slug || Boolean(slugError)}
                onClick={save}
              >
                {mode === "create" ? "Create group" : "Save"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export function DeleteColumnGroupDialog({ group, onClose }: { group: GradebookColumnGroup; onClose: () => void }) {
  const gradebookController = useGradebookController();
  const columns = useGradebookColumns();
  const supabase = useMemo(() => createClient(), []);
  const [busy, setBusy] = useState(false);
  const count = columns.filter((c) => c.gradebook_column_group_id === group.id).length;

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("gradebook_column_group_delete", { p_group_id: group.id });
      if (error) throw error;
    } catch (e) {
      toaster.error({ title: "Could not delete the group", description: errorMessage(e) });
      setBusy(false);
      return;
    }
    // Deleted: close and report success; reloading the layout is best-effort and never fails here.
    void gradebookController.reconcileLayout();
    toaster.create({ title: "Group deleted", type: "success" });
    setBusy(false);
    onClose();
  }, [supabase, group.id, gradebookController, onClose]);

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} size="sm" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Delete group {group.name}?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm">
                {count === 0
                  ? "The group has no columns."
                  : `Its ${count === 1 ? "column moves" : `${count} columns move`} to Ungrouped. No column or grade is deleted.`}
              </Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button colorPalette="red" loading={busy} onClick={remove}>
                Delete group
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
