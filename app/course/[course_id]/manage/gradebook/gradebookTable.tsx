"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import PersonName from "@/components/ui/person-name";
import { toaster } from "@/components/ui/toaster";
import { PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip as WrappedTooltip } from "@/components/ui/tooltip";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import {
  useAllStudentRoles,
  useCanShowGradeFor,
  useCourseController,
  useObfuscatedGradesMode,
  useSetOnlyShowGradesFor
} from "@/hooks/useCourseController";
import {
  useAreAllDependenciesReleased,
  useGradebookColumn,
  useGradebookColumnGrades,
  useGradebookColumns,
  useGradebookColumnGroups,
  useGradebookController,
  useGradebookRefetchStatus,
  useIsGradebookDataReady,
  useStudentDetailView
} from "@/hooks/useGradebook";
import { GradebookWhatIfProvider } from "@/hooks/useGradebookWhatIf";
import {
  buildColumnGroupKeyMap,
  planColumnDrop,
  columnLayoutPatches,
  groupOrderPatches,
  type ColumnLayoutPatch,
  resolveGroupForSlug,
  buildGroupedColumns,
  ORPHAN_GROUP_KEY,
  groupKey as columnGroupKey,
  sortColumnsForDisplay,
  type GradebookColumnGroup
} from "@/lib/gradebookColumnGroups";
import {
  ColumnGroupDialog,
  ColumnGroupHeader,
  DeleteColumnGroupDialog,
  GROUP_DRAG_PREFIX,
  groupPalette,
  type ColumnGroupActions
} from "./columnGroupControls";
import { createClient } from "@/utils/supabase/client";
import {
  ClassSection,
  GradebookColumn,
  GradebookColumnExternalData,
  GradebookColumnStudent,
  LabSection,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  chakra,
  Code,
  Dialog,
  HStack,
  Icon,
  IconButton,
  Input,
  Link,
  List,
  NativeSelect,
  Portal,
  Spinner,
  Table,
  Text,
  Textarea,
  Tooltip,
  VStack
} from "@chakra-ui/react";
import { useList, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import {
  Column,
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  Header,
  RowModel,
  useReactTable,
  type Column as TanStackColumn
} from "@tanstack/react-table";
import { useVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Select } from "chakra-react-select";
import { LucideInfo } from "lucide-react";
import { useParams } from "next/navigation";
import pluralize from "pluralize";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FieldValues } from "react-hook-form";
import { FaLock } from "react-icons/fa";
import { FaLockOpen } from "react-icons/fa6";
import { FiChevronDown, FiDownload, FiFilter, FiPlus } from "react-icons/fi";
import {
  LuArrowDown,
  LuArrowLeft,
  LuArrowRight,
  LuArrowUp,
  LuCalculator,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuChevronsLeftRight,
  LuColumns3,
  LuFile,
  LuGripVertical,
  LuGroup,
  LuLayoutGrid,
  LuPencil,
  LuTrash,
  LuX
} from "react-icons/lu";
import { TbEye, TbEyeOff, TbFilter } from "react-icons/tb";
import { WhatIf } from "../../gradebook/whatIf";
import { ExpressionBuilder, shouldBlockSave } from "@/app/course/[course_id]/manage/gradebook/expressionBuilder";
import type { ValidationResult } from "@/lib/gradebookExpressionTester";
import GradebookCell from "./gradebookCell";
import { GradebookPopoverProvider, useGradebookPopover } from "./GradebookPopoverProvider";
import ImportGradebookColumn from "./importGradebookColumn";

const GRADE_COL_WIDTH = 120;
/** Width a collapsed group shrinks to. */
const COLLAPSED_GROUP_COL_WIDTH = 48;
/** Width of the placeholder an empty group shows, wide enough for its call to action. */
const EMPTY_GROUP_COL_WIDTH = 200;
/** Leaf ids of the placeholder column an empty group renders, alongside `grade_<id>`. */
const EMPTY_GROUP_PREFIX = "emptygroup_";
/** Droppable id of the zone after the last column that sends a dropped column to Ungrouped. */
const UNGROUP_DROP_ID = "ungroup_drop";
/** Droppable ids of those placeholders, so a column can be dropped straight into an empty group. */
const EMPTY_GROUP_DROP_PREFIX = "emptygroupdrop_";

function isScrollableLeafId(id: string): boolean {
  return id.startsWith("grade_") || id.startsWith(EMPTY_GROUP_PREFIX);
}

/** Line clamp for gradebook column header titles (see GradebookColumnHeader / GenericGradebookColumnHeader). */
const GRADE_HEADER_MAX_TITLE_LINES = 2;

/** Used by measureMaxHeaderHeight to approximate toolbar + status rows under the title. */
const GRADE_HEADER_TOOLBAR_ROW_PX = 22;
const GRADE_HEADER_STATUS_ROW_PX = 22;
const GRADE_HEADER_VERTICAL_PADDING_EXTRA_PX = 16;

/**
 * Pre-measure max leaf header height for all grade columns (full-width title layout + line clamp).
 * Avoids per-render DOM walks and viewport-only measurement when columns are virtualized horizontally.
 */
function measureMaxGradeHeaderHeight(columnNames: string[], colWidth: number, maxLines: number): number {
  if (typeof document === "undefined") return 48;
  if (columnNames.length === 0) return 48;

  const container = document.createElement("div");
  container.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "pointer-events:none",
    `width:${colWidth}px`,
    "padding:8px",
    "box-sizing:border-box",
    "font-size:14px",
    "font-weight:600",
    "line-height:1.25",
    "font-family:inherit"
  ].join(";");

  const textEl = document.createElement("div");
  textEl.style.cssText = [
    "display:-webkit-box",
    `-webkit-line-clamp:${maxLines}`,
    "-webkit-box-orient:vertical",
    "overflow:hidden",
    "word-break:break-word"
  ].join(";");

  container.appendChild(textEl);
  document.body.appendChild(container);

  let maxTextH = 0;
  for (const name of columnNames) {
    textEl.textContent = name;
    maxTextH = Math.max(maxTextH, textEl.offsetHeight);
  }

  document.body.removeChild(container);

  const totalH =
    GRADE_HEADER_TOOLBAR_ROW_PX + maxTextH + GRADE_HEADER_STATUS_ROW_PX + GRADE_HEADER_VERTICAL_PADDING_EXTRA_PX;
  return Math.max(totalH, 48);
}

const GRADEBOOK_GAP_PREFIX = "gradebook-gap-";

/** Joins raw score strings when a bucketed renderer maps multiple scores to one filter label. */
const GRADEBOOK_SCORE_FILTER_GROUP_SEP = ",";

function parseGradebookEntryScore(
  scoreOverride: number | null | undefined,
  score: number | null | undefined
): number | null {
  const raw = scoreOverride ?? score;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Aligns map values with filter tokens built from `String(score ?? "")` in the column filter UI. */
function gradebookScoreToFilterRawString(value: number | null): string {
  return value === null ? "" : String(value);
}

function compareGradeColumnSortValues(a: unknown, b: unknown): number {
  const na = typeof a === "number" && Number.isFinite(a) ? a : null;
  const nb = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (na === null && nb === null) return 0;
  if (na === null) return 1;
  if (nb === null) return -1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

function gradebookScoreFilterMatches(filterValue: unknown, cellRaw: string): boolean {
  if (!filterValue) return true;
  const selected = Array.isArray(filterValue) ? filterValue : [filterValue];
  for (const token of selected) {
    if (typeof token !== "string") continue;
    const raws = token.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
      ? token.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
      : [token];
    if (raws.includes(cellRaw)) return true;
  }
  return false;
}

/** Shape of `groupedColumns[*].columns` (matches `columnsForGrouping` entries). */
type GradebookGroupedColumnRef = {
  id: number;
  slug: GradebookColumn["slug"];
  name: GradebookColumn["name"];
  max_score: GradebookColumn["max_score"];
  gradebook_column_group_id: GradebookColumn["gradebook_column_group_id"];
  position_in_group: GradebookColumn["position_in_group"];
};

function buildVisibleReorderUnits(args: {
  scrollableLeafColumns: TanStackColumn<UserProfile, unknown>[];
  groupedColumns: Record<string, { groupName: string; columns: GradebookGroupedColumnRef[] }>;
  collapsedGroups: Set<string>;
  findBestColumnToShow: (columns: GradebookGroupedColumnRef[]) => GradebookGroupedColumnRef;
  columnGroupKeyById: Map<number, string>;
}): number[][] {
  const { scrollableLeafColumns, groupedColumns, collapsedGroups, findBestColumnToShow, columnGroupKeyById } = args;
  const units: number[][] = [];
  for (const leaf of scrollableLeafColumns) {
    if (String(leaf.id).startsWith(EMPTY_GROUP_PREFIX)) {
      units.push([]);
      continue;
    }
    if (!String(leaf.id).startsWith("grade_")) continue;
    const colId = Number(String(leaf.id).slice(6));
    const key = columnGroupKeyById.get(colId);
    const group = key ? groupedColumns[key] : undefined;
    if (!group || group.columns.length <= 1) {
      units.push([colId]);
      continue;
    }
    if (collapsedGroups.has(key!)) {
      const best = findBestColumnToShow(group.columns);
      if (colId !== best.id) continue;
      units.push(group.columns.map((c) => c.id));
    } else {
      units.push([colId]);
    }
  }
  return units;
}

const MemoizedGradebookCell = React.memo(GradebookCell);

/**
 * Whether a column-layout save (drag, group move, Move Left/Right, auto-layout) is in flight, and
 * how to start one. While one runs every other way of moving columns is disabled, so two saves
 * never race on the layout version.
 */
type GradebookLayoutSaveState = {
  layoutSaveInFlight: boolean;
  /** Marks a layout save as started; call the returned function when it ends. */
  beginLayoutSave: () => () => void;
};
const GradebookLayoutSaveContext = React.createContext<GradebookLayoutSaveState>({
  layoutSaveInFlight: false,
  beginLayoutSave: () => () => {}
});

function isLayoutConflict(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "40001";
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "An unexpected error occurred";
}

const GradebookPointerOpener = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof Box>>(
  function GradebookPointerOpener({ children, ...rest }, ref) {
    const { openAt } = useGradebookPopover();
    const onPointerDownCapture = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest("[data-gradebook-cell-trigger]");
        if (!el || !(el instanceof HTMLElement)) return;
        const columnId = el.getAttribute("data-column-id");
        const studentId = el.getAttribute("data-student-id");
        if (columnId == null || studentId == null) return;
        e.preventDefault();
        e.stopPropagation();
        openAt({ targetElement: el, columnId: Number(columnId), studentId });
      },
      [openAt]
    );
    return (
      <Box ref={ref} onPointerDownCapture={onPointerDownCapture} {...rest}>
        {children}
      </Box>
    );
  }
);

function RenderExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Refers to the score as variable <Code>score</Code>. Convert to letter with <Code>letter(score)</Code>
      <Link
        href="https://docs.pawtograder.com/staff/gradebook#gradebook-expression-syntax-documentation"
        target="_blank"
        colorPalette="green"
      >
        Read the docs
      </Link>
    </Text>
  );
}
function ScoreExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Reference a gradebook column or assignment with <Code>gradebook_columns(&quot;slug&quot;)</Code>, globs supported.{" "}
      <Link
        href="https://docs.pawtograder.com/staff/gradebook#gradebook-expression-syntax-documentation"
        target="_blank"
        colorPalette="green"
      >
        Read the docs
      </Link>
    </Text>
  );
}

function normalizeScoreExpression(scoreExpression: string | undefined): string | null {
  const normalized = scoreExpression?.trim();
  return normalized ? normalized : null;
}

function effectiveInstructorOnlyForSubmit(scoreExpression: string | undefined, instructorOnly: boolean | undefined) {
  return Boolean(normalizeScoreExpression(scoreExpression)) && Boolean(instructorOnly);
}

/**
 * The group a column goes in: a dropdown, or "choose automatically from the slug" with a live
 * preview of where that lands. The preview reads only; nothing is created until the dialog saves.
 */
function ColumnGroupField({
  id,
  groups,
  autoGroup,
  onAutoGroupChange,
  slug,
  active,
  selectProps,
  error,
  emptySlugHint,
  manualHint
}: {
  id: string;
  groups: GradebookColumnGroup[];
  autoGroup: boolean;
  onAutoGroupChange: (checked: boolean) => void;
  slug: string;
  /** Whether the dialog is open; the preview only runs then. */
  active: boolean;
  selectProps: React.SelectHTMLAttributes<HTMLSelectElement> & { ref?: React.Ref<HTMLSelectElement> };
  error?: string;
  emptySlugHint?: string;
  manualHint?: string;
}) {
  const gradebookController = useGradebookController();
  const [slugRoute, setSlugRoute] = useState<{ name: string; isNew: boolean } | null>(null);
  const [slugRouteFailed, setSlugRouteFailed] = useState(false);
  useEffect(() => {
    const trimmed = slug.trim();
    setSlugRouteFailed(false);
    if (!active || !autoGroup || !trimmed) {
      setSlugRoute(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data, error: previewError } = await createClient().rpc("gradebook_column_group_preview_for_slug", {
        p_gradebook_id: gradebookController.gradebook_id,
        p_class_id: gradebookController.class_id,
        p_slug: trimmed
      });
      if (cancelled) return;
      const row = previewError ? undefined : data?.[0];
      setSlugRoute(row ? { name: row.group_name, isNew: row.is_new } : null);
      setSlugRouteFailed(!row);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, autoGroup, slug, gradebookController]);

  return (
    <Box>
      <Label htmlFor={id}>Group</Label>
      <NativeSelect.Root size="sm" disabled={autoGroup}>
        <NativeSelect.Field id={id} {...selectProps}>
          <option value="" disabled>
            Choose a group
          </option>
          {groups.map((g) => (
            <option key={g.id} value={String(g.id)}>
              {g.name}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {error && !autoGroup && (
        <Text color="red.500" fontSize="sm" mt={1}>
          {error}
        </Text>
      )}
      <Box mt={2}>
        <Checkbox checked={autoGroup} onCheckedChange={(details) => onAutoGroupChange(details.checked === true)}>
          Choose automatically from the slug
        </Checkbox>
      </Box>
      {autoGroup ? (
        <Text fontSize="xs" color="fg.muted" mt={1}>
          {!slug.trim()
            ? (emptySlugHint ?? "")
            : slugRouteFailed
              ? "Could not preview the group. The column still joins one when you save."
              : slugRoute === null
                ? "Checking…"
                : slugRoute.isNew
                  ? `Starts a new group, ${slugRoute.name}.`
                  : `Joins ${slugRoute.name}.`}
        </Text>
      ) : (
        manualHint && (
          <Text fontSize="xs" color="fg.muted" mt={1}>
            {manualHint}
          </Text>
        )
      )}
    </Box>
  );
}

function AddColumnDialog({
  isOpen,
  onClose,
  defaultGroupId
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Preselects a group, e.g. when opened from a group's "Add column to group". */
  defaultGroupId?: number | null;
}) {
  const addDialogGroups = useGradebookColumnGroups();
  const gradebookController = useGradebookController();

  const [isLoading, setIsLoading] = useState(false);
  const setIsOpen = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose]
  );

  type FormValues = {
    name: string;
    description?: string;
    maxScore: number;
    slug: string;
    scoreExpression?: string;
    renderExpression?: string;
    instructorOnly: boolean;
    autoGroup: boolean;
    gradebookColumnGroupId: string;
  };

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: "",
      description: "",
      maxScore: 0,
      slug: "",
      scoreExpression: "",
      renderExpression: "",
      instructorOnly: false,
      autoGroup: true,
      gradebookColumnGroupId: ""
    }
  });
  const scoreExpression = watch("scoreExpression") ?? "";
  const autoGroup = watch("autoGroup");
  const slugValue = watch("slug") ?? "";

  const renderExpressionValue = watch("renderExpression") ?? "";
  const maxScoreValue = watch("maxScore");
  const [isExpressionBuilderExpanded, setIsExpressionBuilderExpanded] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (!isOpen) {
      reset();
      setIsExpressionBuilderExpanded(false);
      setValidation(null);
    } else if (defaultGroupId) {
      setValue("autoGroup", false);
      setValue("gradebookColumnGroupId", String(defaultGroupId));
    }
  }, [isOpen, reset, defaultGroupId, setValue]);

  const onSubmit = async (data: FieldValues) => {
    if (shouldBlockSave(validation, data.scoreExpression)) {
      toaster.error({
        title: "Invalid score expression",
        description: validation?.parseError || validation?.dependencyError || "Fix the expression before saving."
      });
      return;
    }
    setIsLoading(true);
    try {
      const dependencies = gradebookController.extractAndValidateDependencies(data.scoreExpression ?? "", -1);
      const created = await gradebookController.gradebook_columns.create({
        name: data.name,
        description: data.description,
        max_score: data.maxScore,
        slug: data.slug,
        score_expression: normalizeScoreExpression(data.scoreExpression),
        render_expression: data.renderExpression?.length ? data.renderExpression : null,
        instructor_only: effectiveInstructorOnlyForSubmit(data.scoreExpression, data.instructorOnly),
        dependencies,
        class_id: gradebookController.class_id,
        gradebook_id: gradebookController.gradebook_id,
        // Left null when choosing automatically: the insert trigger picks (or makes) the group from the
        // slug in the same statement, so a failed insert never leaves an empty group behind. The
        // generated Insert type says number because the column is NOT NULL after the trigger runs.
        gradebook_column_group_id: data.autoGroup ? (null as unknown as number) : Number(data.gradebookColumnGroupId)
      });
      // A group the trigger just made may not have reached us over realtime yet.
      if (!gradebookController.gradebook_column_groups.rows.some((g) => g.id === created.gradebook_column_group_id)) {
        void gradebookController.reconcileLayout();
      }

      setIsLoading(false);
      toaster.create({
        title: "Success",
        description: "Column created successfully",
        type: "success"
      });
      setIsOpen(false);
    } catch (e) {
      setIsLoading(false);
      toaster.dismiss();
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      if (message.includes("duplicate key value") && message.includes("slug_key")) {
        message = "A column with this slug already exists. Please choose a different slug.";
      }
      toaster.error({
        title: "Error",
        description: message
      });
    }
  };

  return (
    <Dialog.Root
      open={isOpen}
      size={isExpressionBuilderExpanded ? "cover" : "md"}
      placement={"center"}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            maxW={isExpressionBuilderExpanded ? "100vw" : undefined}
            maxH={isExpressionBuilderExpanded ? "100dvh" : undefined}
            display={isExpressionBuilderExpanded ? "flex" : undefined}
            flexDirection={isExpressionBuilderExpanded ? "column" : undefined}
            overflow={isExpressionBuilderExpanded ? "hidden" : undefined}
          >
            <Dialog.Header>
              <Dialog.Title>Add Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body
              as="form"
              onSubmit={handleSubmit(onSubmit)}
              flex={isExpressionBuilderExpanded ? "1" : undefined}
              minH={isExpressionBuilderExpanded ? "0" : undefined}
              overflowY={isExpressionBuilderExpanded ? "auto" : undefined}
            >
              <VStack gap={3} align="stretch">
                <Box>
                  <Label htmlFor="name">
                    Name
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="name" {...register("name", { required: "Name is required" })} placeholder="Column Name" />
                  {errors.name && (
                    <Text color="red.500" fontSize="sm">
                      {errors.name.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" {...register("description")} placeholder="Description" />
                  {errors.description && (
                    <Text color="red.500" fontSize="sm">
                      {errors.description.message as string}
                    </Text>
                  )}
                </Box>
                <ColumnGroupField
                  id="gradebookColumnGroupId"
                  groups={addDialogGroups}
                  autoGroup={autoGroup}
                  onAutoGroupChange={(checked) => setValue("autoGroup", checked)}
                  slug={slugValue}
                  active={isOpen}
                  selectProps={register("gradebookColumnGroupId", {
                    validate: (value, values) => values.autoGroup || value !== "" || "Choose a group"
                  })}
                  error={errors.gradebookColumnGroupId?.message as string | undefined}
                  emptySlugHint="Type a slug to see which group the column joins."
                />
                <Box>
                  <Label htmlFor="maxScore">
                    Max Score
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="maxScore"
                    type="number"
                    {...register("maxScore", {
                      required: "Max Score is required",
                      valueAsNumber: true,
                      min: { value: 1, message: "Max Score must be at least 1" }
                    })}
                    step="any"
                    placeholder="Max Score"
                  />
                  {errors.maxScore && (
                    <Text color="red.500" fontSize="sm">
                      {errors.maxScore.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="slug">
                    Slug
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="slug" {...register("slug", { required: "Slug is required" })} placeholder="Slug" />
                  {errors.slug && (
                    <Text color="red.500" fontSize="sm">
                      {errors.slug.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <ExpressionBuilder
                    expression={scoreExpression}
                    onExpressionChange={(val) =>
                      setValue("scoreExpression", val, { shouldDirty: true, shouldValidate: true })
                    }
                    editingColumnId={null}
                    isExpanded={isExpressionBuilderExpanded}
                    onExpandToggle={() => setIsExpressionBuilderExpanded((prev) => !prev)}
                    math={null}
                    renderExpression={renderExpressionValue}
                    maxScore={Number.isFinite(Number(maxScoreValue)) ? Number(maxScoreValue) : null}
                    onValidationChange={setValidation}
                  />
                  {errors.scoreExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.scoreExpression.message as string}
                    </Text>
                  )}
                  <ScoreExprDocs />
                </Box>
                <Box>
                  <Label htmlFor="renderExpression">Render Expression</Label>
                  <Input id="renderExpression" {...register("renderExpression")} placeholder="Render Expression" />
                  {errors.renderExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.renderExpression.message as string}
                    </Text>
                  )}
                  <RenderExprDocs />
                </Box>
                <Box>
                  <Checkbox {...register("instructorOnly")}>
                    Staff-only column (hidden from students until you release it)
                  </Checkbox>
                </Box>
                <HStack justifyContent="flex-end">
                  <Button
                    type="submit"
                    colorPalette="green"
                    loading={isLoading}
                    disabled={shouldBlockSave(validation, scoreExpression)}
                  >
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EditColumnDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const gradebookController = useGradebookController();
  const editDialogGroups = useGradebookColumnGroups();
  const { mutateAsync: updateColumn } = useUpdate<GradebookColumn>({
    resource: "gradebook_columns"
  });
  const [isLoading, setIsLoading] = useState(false);
  const column = useGradebookColumn(columnId);

  type FormValues = {
    name: string;
    description?: string;
    maxScore: number;
    slug: string;
    scoreExpression?: string;
    renderExpression?: string;
    showCalculatedRanges?: boolean;
    instructorOnly: boolean;
    autoGroup: boolean;
    gradebookColumnGroupId: string;
  };

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: column?.name ?? "",
      description: column?.description ?? "",
      maxScore: column?.max_score ?? 0,
      slug: column?.slug ?? "",
      scoreExpression: column?.score_expression ?? "",
      renderExpression: column?.render_expression ?? "",
      showCalculatedRanges: column?.show_calculated_ranges ?? false,
      instructorOnly: column?.instructor_only ?? false,
      autoGroup: false,
      gradebookColumnGroupId: column ? String(column.gradebook_column_group_id) : ""
    }
  });

  const scoreExpression = watch("scoreExpression") ?? "";
  const renderExpressionValue = watch("renderExpression") ?? "";
  const maxScoreValue = watch("maxScore");
  const editAutoGroup = watch("autoGroup");
  // The slug as typed, for the "choose automatically" preview and resolution.
  const editSlugValue = watch("slug") ?? "";
  const [isExpressionBuilderExpanded, setIsExpressionBuilderExpanded] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  // Filled once per column the dialog opens on. Refilling on every update to the row would let a
  // realtime echo of this dialog's own save wipe what the instructor chose and the error that
  // explains why the save failed.
  const formFilledForColumnId = useRef<number | null>(null);
  useEffect(() => {
    if (column && formFilledForColumnId.current !== columnId) {
      formFilledForColumnId.current = columnId;
      const expr = column.score_expression ?? "";
      reset({
        name: column.name ?? "",
        description: column.description ?? "",
        maxScore: column.max_score ?? 0,
        slug: column.slug ?? "",
        scoreExpression: expr,
        renderExpression: column.render_expression ?? "",
        showCalculatedRanges: column.show_calculated_ranges ?? false,
        instructorOnly: column.instructor_only ?? false,
        autoGroup: false,
        gradebookColumnGroupId: String(column.gradebook_column_group_id)
      });
      // Clear any ValidationResult cached from a previously-edited column so
      // a stale error state can't briefly gate the Save button before
      // ExpressionBuilder's first `onValidationChange` fires for the new one.
      setValidation(null);
    }
  }, [columnId, column, reset]);

  if (!columnId) return null;
  if (!column) throw new Error(`Column ${columnId} not found`);

  // Pin the "is this column assignment-backed?" gate to the column's
  // PERSISTED score expression, not the live-watched form value. Otherwise
  // the moment an instructor types `assignments(` while editing a regular
  // column, `canEditScoreExpression` flips to `false`, ExpressionBuilder
  // unmounts mid-edit, and the instructor loses the full-screen state
  // (expanded mode, selected student, and the mathjs / intermediate
  // annotations that had already loaded).
  const canEditScoreExpression = !(column.score_expression?.startsWith("assignments(") ?? false);

  const onSubmit = async (data: FieldValues) => {
    // When the score expression is not user-editable (assignment-backed
    // columns), ExpressionBuilder is not mounted, so `validation` never
    // updates. Skipping the client-side guard in that case lets instructors
    // save metadata-only edits (name, description, max_score, etc.); the
    // server-side extractAndValidateDependencies below still runs.
    if (canEditScoreExpression && shouldBlockSave(validation, data.scoreExpression)) {
      toaster.error({
        title: "Invalid score expression",
        description: validation?.parseError || validation?.dependencyError || "Fix the score expression before saving."
      });
      return;
    }
    toaster.create({
      title: "Saving...",
      description: "This may take a few seconds to recalculate...",
      type: "info"
    });
    setIsLoading(true);
    try {
      const dependencies = gradebookController.extractAndValidateDependencies(data.scoreExpression ?? "", columnId);

      // Track which settings changed
      const settingsChanged: string[] = [];
      if (column.name !== data.name) settingsChanged.push("name");
      if (column.description !== data.description) settingsChanged.push("description");
      if (column.max_score !== data.maxScore) settingsChanged.push("max_score");
      if (column.slug !== data.slug) settingsChanged.push("slug");
      const normalizedExpr = normalizeScoreExpression(data.scoreExpression);
      if ((column.score_expression ?? null) !== normalizedExpr) settingsChanged.push("score_expression");
      if ((column.render_expression ?? "") !== (data.renderExpression ?? "")) settingsChanged.push("render_expression");
      if ((column.show_calculated_ranges ?? false) !== (data.showCalculatedRanges ?? false))
        settingsChanged.push("show_calculated_ranges");
      const submittedInstructorOnly = effectiveInstructorOnlyForSubmit(data.scoreExpression, data.instructorOnly);
      if ((column.instructor_only ?? false) !== submittedInstructorOnly) settingsChanged.push("instructor_only");

      try {
        await updateColumn({
          resource: "gradebook_columns",
          id: columnId,
          values: {
            name: data.name,
            description: data.description,
            max_score: data.maxScore,
            slug: data.slug,
            score_expression: normalizedExpr,
            render_expression: data.renderExpression?.length ? data.renderExpression : null,
            show_calculated_ranges: data.showCalculatedRanges ?? false,
            instructor_only: submittedInstructorOnly,
            dependencies
          }
        });
      } catch (e) {
        throw new Error(`Could not save the column: ${describeError(e)}`);
      }

      // The group move runs after the settings save, so a failed save never leaves the column moved
      // (or a group made for its slug). Moving goes through the RPC, which keeps positions in both
      // groups dense.
      try {
        const slugForGroup = data.slug || editSlugValue || column.slug;
        const targetGroupId = data.autoGroup
          ? await resolveGroupForSlug(
              createClient(),
              gradebookController.gradebook_id,
              gradebookController.class_id,
              slugForGroup
            )
          : Number(data.gradebookColumnGroupId);
        if (Number.isFinite(targetGroupId) && targetGroupId > 0 && targetGroupId !== column.gradebook_column_group_id) {
          const { error: moveError } = await createClient().rpc("gradebook_column_assign_group", {
            p_column_id: columnId,
            p_group_id: targetGroupId
          });
          if (moveError) throw moveError;
          settingsChanged.push("group");
        }
      } catch (e) {
        throw new Error(`Saved the column's settings, but could not move it to the new group: ${describeError(e)}`);
      }
      if (settingsChanged.includes("group")) {
        void gradebookController.reconcileLayout();
      }

      setIsLoading(false);
      toaster.dismiss();
      onClose();
    } catch (e) {
      setIsLoading(false);
      toaster.dismiss();
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      setError("root", { message });
    }
  };

  return (
    <Dialog.Root
      open={true}
      size={isExpressionBuilderExpanded ? "cover" : "md"}
      placement={"center"}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            maxW={isExpressionBuilderExpanded ? "100vw" : undefined}
            maxH={isExpressionBuilderExpanded ? "100dvh" : undefined}
            display={isExpressionBuilderExpanded ? "flex" : undefined}
            flexDirection={isExpressionBuilderExpanded ? "column" : undefined}
            overflow={isExpressionBuilderExpanded ? "hidden" : undefined}
          >
            <Dialog.Header>
              <Dialog.Title>Edit Column{isExpressionBuilderExpanded ? " — Expression Builder" : ""}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body
              as="form"
              onSubmit={handleSubmit(onSubmit)}
              flex={isExpressionBuilderExpanded ? "1" : undefined}
              minH={isExpressionBuilderExpanded ? "0" : undefined}
              overflowY={isExpressionBuilderExpanded ? "auto" : undefined}
            >
              <VStack gap={3} align="stretch">
                <Box>
                  <Label htmlFor="name">
                    Name
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="name" {...register("name", { required: "Name is required" })} placeholder="Column Name" />
                  {errors.name && (
                    <Text color="red.500" fontSize="sm">
                      {errors.name.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" {...register("description")} placeholder="Description" />
                  {errors.description && (
                    <Text color="red.500" fontSize="sm">
                      {errors.description.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="maxScore">
                    Max Score
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="maxScore"
                    type="number"
                    {...register("maxScore", {
                      required: "Max Score is required",
                      valueAsNumber: true,
                      min: { value: 1, message: "Max Score must be at least 1" }
                    })}
                    step="any"
                    placeholder="Max Score"
                  />
                  {errors.maxScore && (
                    <Text color="red.500" fontSize="sm">
                      {errors.maxScore.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="slug">
                    Slug
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="slug"
                    {...register("slug", { required: "Slug is required" })}
                    placeholder="Slug"
                    disabled
                  />
                  {errors.slug && (
                    <Text color="red.500" fontSize="sm">
                      {errors.slug.message as string}
                    </Text>
                  )}
                </Box>
                <ColumnGroupField
                  id="editGradebookColumnGroupId"
                  groups={editDialogGroups}
                  autoGroup={editAutoGroup}
                  onAutoGroupChange={(checked) => setValue("autoGroup", checked)}
                  slug={editSlugValue || (column.slug ?? "")}
                  active
                  selectProps={register("gradebookColumnGroupId")}
                  manualHint="Moving a column puts it at the end of the new group. Totals that name the group pick it up."
                />
                <Box>
                  {canEditScoreExpression ? (
                    <ExpressionBuilder
                      expression={scoreExpression}
                      onExpressionChange={(val) =>
                        setValue("scoreExpression", val, { shouldDirty: true, shouldValidate: true })
                      }
                      editingColumnId={columnId}
                      isExpanded={isExpressionBuilderExpanded}
                      onExpandToggle={() => setIsExpressionBuilderExpanded((prev) => !prev)}
                      math={null}
                      renderExpression={renderExpressionValue}
                      maxScore={Number.isFinite(Number(maxScoreValue)) ? Number(maxScoreValue) : null}
                      onValidationChange={setValidation}
                    />
                  ) : (
                    <>
                      <Label htmlFor="scoreExpression">Score Expression</Label>
                      {/*
                        Use `readOnly` instead of `disabled` — a bare HTML
                        `disabled` attribute tells the browser to omit the
                        field from form submission (react-hook-form then
                        hands `undefined` back to `onSubmit`, which would
                        wipe the persisted `assignments(...)` expression
                        when the instructor saves a metadata-only edit).
                        `readOnly` keeps the field non-editable while still
                        letting react-hook-form read the registered value.
                      */}
                      <Textarea
                        id="scoreExpression"
                        readOnly
                        {...register("scoreExpression")}
                        placeholder="Score Expression"
                        rows={4}
                      />
                    </>
                  )}
                  {errors.scoreExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.scoreExpression.message as string}
                    </Text>
                  )}
                  <ScoreExprDocs />
                </Box>
                {scoreExpression && (
                  <Box>
                    <Checkbox {...register("showCalculatedRanges")} checked={watch("showCalculatedRanges") ?? false}>
                      Show calculated grade range predictions to students
                    </Checkbox>
                    {errors.showCalculatedRanges && (
                      <Text color="red.500" fontSize="sm">
                        {errors.showCalculatedRanges.message as string}
                      </Text>
                    )}
                  </Box>
                )}
                <Box>
                  <Checkbox {...register("instructorOnly")} checked={watch("instructorOnly") ?? false}>
                    Staff-only column (hidden from students until you release it)
                  </Checkbox>
                </Box>
                <Box>
                  <Label htmlFor="renderExpression">Render Expression</Label>
                  <Input id="renderExpression" {...register("renderExpression")} placeholder="Render Expression" />
                  {errors.renderExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.renderExpression.message as string}
                    </Text>
                  )}
                  <RenderExprDocs />
                </Box>
                {errors.root && (
                  <Text color="red.500" fontSize="sm">
                    {errors.root.message as string}
                  </Text>
                )}
                <HStack justifyContent="flex-end">
                  <Button
                    type="submit"
                    colorPalette="green"
                    loading={isLoading}
                    disabled={canEditScoreExpression && shouldBlockSave(validation, scoreExpression)}
                  >
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ConvertMissingToZeroDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const supabase = createClient();
  const [isConverting, setIsConverting] = useState(false);
  const column = useGradebookColumn(columnId);

  return (
    <Dialog.Root open={true} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Convert Missing to 0</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={2} alignItems="flex-start">
                <Text>
                  &quot;Missing&quot; is a special value in Pawtograder to indicate that a student&apos;s grade for a
                  column has not been entered. Missing values do not count as 0s by default, and instead if a calculated
                  column depends on one, it is marked as &quot;not final.&quot; You should only convert missing values
                  to 0 if you are sure that you have finalized the grades for all students, and truly want to count this
                  item as 0. Are you sure you want to convert all missing values in column &quot;{column?.name}&quot; to
                  0? This action cannot be undone.
                </Text>
                <Text color="fg.error" fontWeight="bold">
                  All missing grades will be set to 0 with a note indicating the conversion.
                </Text>
                <HStack gap={2}>
                  <Button
                    colorPalette="red"
                    loading={isConverting}
                    onClick={async () => {
                      setIsConverting(true);
                      try {
                        await supabase
                          .from("gradebook_column_students")
                          .update({
                            score: 0,
                            is_missing: false,
                            score_override_note: "Missing value converted to 0"
                          })
                          .eq("gradebook_column_id", columnId)
                          .eq("is_private", true)
                          .or("is_missing.eq.true,and(score.is.null,score_override.is.null)");

                        toaster.success({
                          title: "Success",
                          description: "Missing values have been converted to 0"
                        });

                        onClose();
                      } catch {
                        toaster.error({
                          title: "Error",
                          description: "Failed to convert missing values"
                        });
                      } finally {
                        setIsConverting(false);
                      }
                    }}
                  >
                    Convert Missing to 0
                  </Button>
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function DeleteColumnDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const supabase = createClient();
  const [isDeleting, setIsDeleting] = useState(false);
  const columns = useGradebookColumns();
  const gradebookController = useGradebookController();
  const dependentColumns = useMemo(() => {
    return columns.filter(
      (c) =>
        c.dependencies &&
        typeof c.dependencies === "object" &&
        "gradebook_columns" in c.dependencies &&
        (c.dependencies.gradebook_columns as number[])?.includes(columnId)
    );
  }, [columns, columnId]);
  return (
    <Dialog.Root open={true} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Delete Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {dependentColumns.length > 0 ? (
                <>
                  <Text>
                    You can not currently delete this column because it is a dependency for the following columns:
                  </Text>
                  <List.Root as="ul">
                    {dependentColumns.map((c) => (
                      <List.Item key={c.id}>
                        <Text fontWeight="bold">{c.name}</Text> <Code>{c.score_expression}</Code>
                      </List.Item>
                    ))}
                  </List.Root>
                  Please edit the dependent columns to remove this column as a dependency before deleting this column.
                  <Button w="100%" variant="ghost" onClick={onClose}>
                    Close
                  </Button>
                </>
              ) : (
                <VStack gap={2} alignItems="flex-start">
                  <Text>
                    Are you sure you want to delete this column? This action cannot be undone. All grades for this
                    column will be permanently deleted.
                  </Text>
                  <Text color="fg.error" fontWeight="bold">
                    You should expect that there is no way to undo this.
                  </Text>
                  <HStack gap={2}>
                    <Button
                      colorPalette="red"
                      loading={isDeleting}
                      onClick={async () => {
                        setIsDeleting(true);
                        await supabase.from("gradebook_column_students").delete().eq("gradebook_column_id", columnId);
                        await gradebookController.gradebook_columns.hardDelete(columnId);
                        onClose();
                      }}
                    >
                      Delete Column
                    </Button>
                    <Button variant="ghost" onClick={onClose}>
                      Cancel
                    </Button>
                  </HStack>
                </VStack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ExternalDataAdvice({ externalData }: { externalData: GradebookColumnExternalData }) {
  return (
    <VStack gap={0} align="flex-start">
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Imported from CSV
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        File: {externalData.fileName}
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Date: <TimeZoneAwareDate date={externalData.date} format="compact" />
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Creator:
      </Text>
      <PersonName uid={externalData.creator} showAvatar={false} />
    </VStack>
  );
}

function filterOptionsAllSelected<T extends { value: string }>(options: T[], selected: T[]): boolean {
  if (options.length === 0) return false;
  const selectedSet = new Set(selected.map((s) => s.value));
  return options.every((o) => selectedSet.has(o.value));
}

function FilterSelectAllNoneToolbar({
  onSelectAll,
  onSelectNone,
  disableSelectAll,
  disableSelectNone
}: {
  onSelectAll: () => void;
  onSelectNone: () => void;
  disableSelectAll: boolean;
  disableSelectNone: boolean;
}) {
  return (
    <HStack justifyContent="flex-end" gap={1} mb={2} flexWrap="wrap">
      <Button type="button" size="xs" variant="ghost" onClick={onSelectAll} disabled={disableSelectAll}>
        Select all
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onSelectNone} disabled={disableSelectNone}>
        Select none
      </Button>
    </HStack>
  );
}

// New component for filtering a gradebook column
function GradebookColumnFilter({
  columnName,
  column_id,
  values,
  columnModel,
  isOpen,
  onClose,
  triggerRef
}: {
  columnName: string;
  column_id: number;
  values: GradebookColumnStudent[];
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const column = useGradebookColumn(column_id);
  const gradebookController = useGradebookController();
  const renderer = useMemo(() => gradebookController.getRendererForColumn(column_id), [gradebookController, column_id]);

  const uniqueValues = useMemo(() => {
    return [...new Set(values.map((grade) => String(grade.score_override ?? grade.score ?? "")))];
  }, [values]);

  const formatFilterLabel = useCallback(
    (rawNumeric: string) => {
      const n = Number(rawNumeric);
      if (rawNumeric === "" || Number.isNaN(n)) {
        return rawNumeric;
      }
      return String(
        renderer({
          score: n,
          score_override: null,
          max_score: column.max_score,
          is_missing: false,
          is_excused: false,
          is_droppable: false,
          released: true
        })
      );
    },
    [renderer, column.max_score]
  );

  const selectOptions = useMemo(() => {
    const labelToRaws = new Map<string, string[]>();
    for (const raw of uniqueValues) {
      const label = formatFilterLabel(raw);
      const list = labelToRaws.get(label);
      if (list) {
        if (!list.includes(raw)) list.push(raw);
      } else {
        labelToRaws.set(label, [raw]);
      }
    }
    return [...labelToRaws.entries()]
      .map(([label, raws]) => {
        raws.sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });
        return {
          label,
          value: raws.join(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
        };
      })
      .sort((a, b) => {
        const aFirst = a.value.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0] ?? "";
        const bFirst = b.value.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0] ?? "";
        const na = Number(aFirst);
        const nb = Number(bFirst);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return a.label.localeCompare(b.label);
      });
  }, [uniqueValues, formatFilterLabel]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => {
        const firstRaw = val.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
          ? val.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0]
          : val;
        return { label: formatFilterLabel(firstRaw ?? val), value: val };
      })
    : currentValue
      ? [
          {
            label: formatFilterLabel(
              currentValue.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
                ? currentValue.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0]!
                : currentValue
            ),
            value: currentValue
          }
        ]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          {/* Header with close button */}
          <HStack justifyContent="space-between" mb={3}>
            <Text fontWeight="semibold" fontSize="sm">
              Filter {columnName}
            </Text>
            <IconButton size="xs" variant="ghost" onClick={onClose} aria-label="Close filter">
              <Icon as={LuX} boxSize={4} />
            </IconButton>
          </HStack>

          <FilterSelectAllNoneToolbar
            onSelectAll={() => columnModel.setFilterValue(selectOptions.map((o) => o.value))}
            onSelectNone={() => columnModel.setFilterValue("")}
            disableSelectAll={selectOptions.length === 0 || filterOptionsAllSelected(selectOptions, selectedOptions)}
            disableSelectNone={selectedOptions.length === 0}
          />

          {/* Filter input */}
          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
            chakraStyles={{
              control: (provided) => ({
                ...provided,
                bg: "bg.surface",
                borderColor: "border.muted",
                _focus: { borderColor: "border.primary" }
              }),
              menu: (provided) => ({
                ...provided,
                bg: "bg.surface",
                border: "1px solid",
                borderColor: "border.muted"
              }),
              option: (provided, state) => ({
                ...provided,
                bg: state.isSelected ? "bg.primary" : state.isFocused ? "bg.subtle" : "bg.surface",
                color: state.isSelected ? "fg.inverse" : "fg.default",
                _hover: { bg: state.isSelected ? "bg.primary" : "bg.subtle" }
              })
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

// Section filter component with enhanced select functionality
function SectionFilter({
  columnName,
  columnModel,
  isOpen,
  onClose,
  triggerRef,
  sections,
  type
}: {
  columnName: string;
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  sections: ClassSection[] | LabSection[];
  type: "class" | "lab";
}) {
  const selectOptions = useMemo(() => {
    return sections.map((section) => ({
      label: type === "class" ? section.name : `${section.name}`,
      value: String(section.id)
    }));
  }, [sections, type]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => {
        const section = sections.find((s) => String(s.id) === val);
        return {
          label: section ? (type === "class" ? section.name : `${section.name}`) : val,
          value: val
        };
      })
    : currentValue
      ? [
          {
            label: sections.find((s) => String(s.id) === currentValue)?.name || currentValue,
            value: currentValue
          }
        ]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          <HStack justifyContent="space-between" mb={3}>
            <Text fontWeight="semibold" fontSize="sm">
              Filter {columnName}
            </Text>
            <IconButton size="xs" variant="ghost" onClick={onClose} aria-label="Close filter">
              <Icon as={LuX} boxSize={4} />
            </IconButton>
          </HStack>

          <FilterSelectAllNoneToolbar
            onSelectAll={() => columnModel.setFilterValue(selectOptions.map((o) => o.value))}
            onSelectNone={() => columnModel.setFilterValue("")}
            disableSelectAll={selectOptions.length === 0 || filterOptionsAllSelected(selectOptions, selectedOptions)}
            disableSelectNone={selectedOptions.length === 0}
          />

          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
            chakraStyles={{
              control: (provided) => ({
                ...provided,
                bg: "bg.surface",
                borderColor: "border.muted",
                _focus: { borderColor: "border.primary" }
              }),
              menu: (provided) => ({
                ...provided,
                bg: "bg.surface",
                border: "1px solid",
                borderColor: "border.muted"
              }),
              option: (provided, state) => ({
                ...provided,
                bg: state.isSelected ? "bg.primary" : state.isFocused ? "bg.subtle" : "bg.surface",
                color: state.isSelected ? "fg.inverse" : "fg.default",
                _hover: { bg: state.isSelected ? "bg.primary" : "bg.subtle" }
              })
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

function GenericColumnFilter({
  columnName,
  columnModel,
  isOpen,
  onClose,
  triggerRef,
  rowModel
}: {
  columnName: string;
  rowModel: RowModel<UserProfile>;
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const uniqueValues = useMemo(() => {
    const accessor = columnModel.accessorFn;
    if (!accessor) {
      return [];
    }
    const ret = rowModel.rows.map((row, idx) => accessor(row.original, idx) as string);
    return [...new Set(ret)];
  }, [rowModel, columnModel]);
  const selectOptions = useMemo(() => uniqueValues.map((value) => ({ label: value, value })), [uniqueValues]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => ({ label: val, value: val }))
    : currentValue
      ? [{ label: currentValue, value: currentValue }]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          <FilterSelectAllNoneToolbar
            onSelectAll={() => columnModel.setFilterValue(selectOptions.map((o) => o.value))}
            onSelectNone={() => columnModel.setFilterValue("")}
            disableSelectAll={selectOptions.length === 0 || filterOptionsAllSelected(selectOptions, selectedOptions)}
            disableSelectNone={selectedOptions.length === 0}
          />
          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
function GenericGradebookColumnHeader({
  columnName,
  isSorted,
  toggleSorting,
  clearSorting,
  columnModel,
  header,
  coreRowModel,
  classSections,
  labSections,
  dragHandle
}: {
  columnName: string;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
  header: Header<UserProfile, unknown>;
  coreRowModel: RowModel<UserProfile>;
  classSections?: ClassSection[];
  labSections?: LabSection[];
  dragHandle?: React.ReactNode;
}) {
  const [showFilter, setShowFilter] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Determine if this is a section column
  const isClassSection = columnName === "class_section";
  const isLabSection = columnName === "lab_section";
  const isSectionColumn = isClassSection || isLabSection;

  return (
    <VStack gap={0} alignItems="stretch" w="100%" minH="48px">
      {/* Main header content */}
      <Box
        ref={ref}
        position="relative"
        p={0}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        <HStack
          w="100%"
          justify="space-between"
          align="flex-start"
          minH={`${GRADE_HEADER_TOOLBAR_ROW_PX}px`}
          flexShrink={0}
          px={0}
          gap={0}
        >
          <Box flexShrink={0}>{dragHandle}</Box>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options" flexShrink={0} borderRadius={0}>
                <Icon as={FiChevronDown} />
              </IconButton>
            </MenuTrigger>
            <MenuContent minW="120px">
              <MenuItem value="filter" onClick={() => setShowFilter(!showFilter)}>
                <Icon as={FiFilter} boxSize={3} mr={2} />
                {showFilter ? "Hide Filter" : "Show Filter"}
              </MenuItem>
              <MenuItem value="asc" onClick={() => toggleSorting(false)}>
                {columnModel.getIsSorted() === "asc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowUp} boxSize={3} mr={2} />
                Sort Ascending
              </MenuItem>
              <MenuItem value="desc" onClick={() => toggleSorting(true)}>
                {columnModel.getIsSorted() === "desc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowDown} boxSize={3} mr={2} />
                Sort Descending
              </MenuItem>
              {isSorted && (
                <MenuItem value="clear" onClick={() => clearSorting()}>
                  Clear Sort
                </MenuItem>
              )}
            </MenuContent>
          </MenuRoot>
        </HStack>
        <Box px={1.5} pr={3} pb={0} flex="1" display="flex" flexDirection="column" justifyContent="space-between">
          <Text
            fontWeight="semibold"
            fontSize="sm"
            color="fg.default"
            lineHeight="tight"
            w="100%"
            minW={0}
            style={{
              userSelect: "none",
              display: "-webkit-box",
              WebkitLineClamp: GRADE_HEADER_MAX_TITLE_LINES,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word"
            }}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </Text>
          {showFilter && isSectionColumn && (
            <SectionFilter
              columnName={columnName}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={ref}
              sections={isClassSection ? classSections || [] : labSections || []}
              type={isClassSection ? "class" : "lab"}
            />
          )}
          {showFilter && !isSectionColumn && (
            <GenericColumnFilter
              columnName={columnName}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={ref}
              rowModel={coreRowModel}
            />
          )}
        </Box>
      </Box>
      <HStack alignItems="flex-end" w="100%" px={1.5}>
        <Box flex="1" display="flex" justifyContent="flex-end">
          {columnModel?.getIsFiltered() && (
            <WrappedTooltip content="Clear filter">
              <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={() => setShowFilter(true)}>
                <Icon as={TbFilter} />
              </IconButton>
            </WrappedTooltip>
          )}
        </Box>
      </HStack>
    </VStack>
  );
}

function GradebookColumnHeader({
  column_id,
  isSorted,
  toggleSorting,
  clearSorting,
  columnModel,
  dragHandle
}: {
  column_id: number;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
  dragHandle?: React.ReactNode;
}) {
  const column = useGradebookColumn(column_id);
  const gradebookController = useGradebookController();
  const areAllDependenciesReleased = useAreAllDependenciesReleased(column_id);
  const allGrades = useGradebookColumnGrades(column_id);

  // Check for mixed release status (some students have released grades, others don't)
  const hasMixedReleaseStatus = useMemo(() => {
    if (allGrades.length === 0) return false;

    const releasedCount = allGrades.filter((grade) => grade.released).length;
    const totalCount = allGrades.length;

    // Mixed status: some but not all grades are released
    return releasedCount > 0 && releasedCount < totalCount;
  }, [allGrades]);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConvertingMissing, setIsConvertingMissing] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [isMovingLeft, setIsMovingLeft] = useState(false);
  const [isMovingRight, setIsMovingRight] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [isUnreleasing, setIsUnreleasing] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const headerRef = useRef<HTMLDivElement>(null);
  const isMovingRef = useRef(false);

  const { layoutSaveInFlight, beginLayoutSave } = React.useContext(GradebookLayoutSaveContext);

  /**
   * What Move Left/Right will do, read from the loaded layout the same way the RPC reads the table:
   * swap with a neighbor in the group, else swap the whole group with the next movable group, else
   * nothing (first/last group, or Ungrouped, which is pinned last).
   */
  const predictMove = useCallback(
    (direction: "left" | "right"): "column" | "group" | "edge" => {
      const before = (a: number, b: number) => (direction === "left" ? a < b : a > b);
      const groupId = column.gradebook_column_group_id;
      const hasNeighbor = gradebookController.gradebook_columns.rows.some(
        (c) =>
          c.id !== column_id &&
          c.gradebook_column_group_id === groupId &&
          before(c.position_in_group, column.position_in_group)
      );
      if (hasNeighbor) return "column";
      const groups = gradebookController.gradebook_column_groups.rows;
      const group = groups.find((g) => g.id === groupId);
      if (!group || group.is_default) return "edge";
      return groups.some((g) => !g.is_default && g.id !== group.id && before(g.sort_order, group.sort_order))
        ? "group"
        : "edge";
    },
    [column, column_id, gradebookController]
  );

  const moveColumn = useCallback(
    async (direction: "left" | "right") => {
      if (isMovingRef.current || layoutSaveInFlight) return;
      const expected = predictMove(direction);
      if (expected === "edge") {
        toaster.create({
          title: "Already at the edge",
          description: `"${column.name}" is already as far ${direction} as it can go.`,
          type: "info"
        });
        return;
      }
      const groupName =
        gradebookController.gradebook_column_groups.rows.find((g) => g.id === column.gradebook_column_group_id)?.name ??
        "its group";

      isMovingRef.current = true;
      const setMoving = direction === "left" ? setIsMovingLeft : setIsMovingRight;
      setMoving(true);
      const endLayoutSave = beginLayoutSave();
      try {
        const { error } = await supabase.rpc(
          direction === "left" ? "gradebook_column_move_left" : "gradebook_column_move_right",
          { p_column_id: column_id }
        );
        if (error) throw error;

        toaster.create(
          expected === "column"
            ? {
                title: `Column moved ${direction}`,
                description: `Moved "${column.name}" to the ${direction}`,
                type: "success"
              }
            : {
                title: `Group moved ${direction}`,
                description: `"${column.name}" is at the ${direction} edge of ${groupName}, so the whole group moved ${direction}`,
                type: "success"
              }
        );
      } catch (error) {
        toaster.create({
          title: "Failed to move column",
          description: describeError(error),
          type: "error"
        });
      } finally {
        // Moves touch neighbors and group order too, not only this column.
        void gradebookController.reconcileLayout();
        endLayoutSave();
        isMovingRef.current = false;
        setMoving(false);
      }
    },
    [column_id, column, supabase, gradebookController, predictMove, layoutSaveInFlight, beginLayoutSave]
  );
  const moveLeft = useCallback(() => moveColumn("left"), [moveColumn]);
  const moveRight = useCallback(() => moveColumn("right"), [moveColumn]);

  const releaseColumn = useCallback(async () => {
    if (column.instructor_only) {
      // Block release while grades are being recalculated
      const hasRecalculating = allGrades.some((grade) => grade.is_recalculating);
      if (hasRecalculating) {
        toaster.create({
          title: "Column is recalculating",
          description: "Some grades are still being recalculated. Please try again in a moment.",
          type: "error"
        });
        return;
      }

      const confirmed = window.confirm(
        `Releasing "${column.name}" will make it permanently visible to students and it will behave as a normal column. This cannot be undone. Continue?`
      );
      if (!confirmed) return;
    }

    setIsReleasing(true);
    try {
      if (column.instructor_only) {
        // Atomic: release + clear instructor_only in a single transaction
        const { error } = await supabase.rpc("release_instructor_only_gradebook_column", {
          p_column_id: column_id
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("gradebook_columns").update({ released: true }).eq("id", column_id);
        if (error) throw error;
      }

      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column released",
        description: `Successfully released "${column.name}" column`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to release column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setIsReleasing(false);
    }
  }, [column_id, column, supabase, gradebookController, allGrades]);

  const unreleaseColumn = useCallback(async () => {
    setIsUnreleasing(true);
    try {
      const { error } = await supabase.from("gradebook_columns").update({ released: false }).eq("id", column_id);

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column unreleased",
        description: `Successfully unreleased "${column.name}" column`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to unrelease column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setIsUnreleasing(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const toolTipText = useMemo(() => {
    const ret: string[] = [];
    if (column.description) {
      ret.push(`Description: ${column.description}`);
    }
    if (column.score_expression) {
      ret.push(`Auto-calculated using: ${column.score_expression}`);
      if (areAllDependenciesReleased) {
        ret.push("Students see the same calculation as you");
      } else {
        ret.push("Some dependencies are not released - students cannot see the same calculation that you see");
      }

      // Add mixed release status information
      if (hasMixedReleaseStatus) {
        const releasedCount = allGrades.filter((grade) => grade.released).length;
        const totalCount = allGrades.length;
        ret.push(`Mixed release status: ${releasedCount}/${totalCount} students can see their grades`);
      }
    }
    if (column.instructor_only) {
      ret.push("Staff-only: hidden from students until released");
    }
    if (column.render_expression) {
      ret.push(`Rendered as ${column.render_expression}`);
    }
    if (!column.score_expression && !column.instructor_only) {
      if (column.released) {
        ret.push("Released to students");
      } else {
        ret.push("Not released to students");
      }
    }
    return (
      <VStack gap={0} align="flex-start">
        {ret.map((t) => (
          <Text key={t}>{t}</Text>
        ))}
      </VStack>
    );
  }, [column, areAllDependenciesReleased, hasMixedReleaseStatus, allGrades]);

  return (
    <VStack gap={0} alignItems="stretch" w="100%" minH="48px" height="100%">
      {isEditing && (
        <EditColumnDialog
          columnId={column_id}
          onClose={() => {
            setIsEditing(false);
          }}
        />
      )}
      {isDeleting && (
        <DeleteColumnDialog
          columnId={column_id}
          onClose={() => {
            setIsDeleting(false);
          }}
        />
      )}
      {isConvertingMissing && (
        <ConvertMissingToZeroDialog
          columnId={column_id}
          onClose={() => {
            setIsConvertingMissing(false);
          }}
        />
      )}

      {/* Main header content */}
      <Box
        ref={headerRef}
        position="relative"
        h="100%"
        p={0}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        <HStack
          w="100%"
          justify="space-between"
          align="flex-start"
          minH={`${GRADE_HEADER_TOOLBAR_ROW_PX}px`}
          flexShrink={0}
          px={0}
          gap={0}
        >
          <Box flexShrink={0}>{dragHandle}</Box>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options" flexShrink={0} borderRadius={0}>
                <Icon as={FiChevronDown} />
              </IconButton>
            </MenuTrigger>
            <MenuContent minW="160px">
              <MenuItem value="filter" onClick={() => setShowFilter(!showFilter)}>
                <Icon as={FiFilter} boxSize={3} mr={2} />
                {showFilter ? "Hide Filter" : "Show Filter"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem value="asc" onClick={() => toggleSorting(false)}>
                {isSorted === "asc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowUp} boxSize={3} mr={2} />
                Sort Ascending
              </MenuItem>
              <MenuItem value="desc" onClick={() => toggleSorting(true)}>
                {isSorted === "desc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowDown} boxSize={3} mr={2} />
                Sort Descending
              </MenuItem>
              {isSorted && (
                <MenuItem value="clear" onClick={() => clearSorting()}>
                  Clear Sort
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem value="edit" onClick={() => setIsEditing(true)}>
                <Icon as={LuPencil} boxSize={3} mr={2} />
                Edit Column
              </MenuItem>
              <MenuItem
                value="moveLeft"
                onClick={moveLeft}
                disabled={isMovingLeft || isMovingRight || layoutSaveInFlight}
                _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
              >
                {isMovingLeft ? <Spinner size="xs" mr={2} /> : <Icon as={LuArrowLeft} boxSize={3} mr={2} />}
                Move Left
              </MenuItem>
              <MenuItem
                value="moveRight"
                onClick={moveRight}
                disabled={isMovingLeft || isMovingRight || layoutSaveInFlight}
                _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
              >
                {isMovingRight ? <Spinner size="xs" mr={2} /> : <Icon as={LuArrowRight} boxSize={3} mr={2} />}
                Move Right
              </MenuItem>
              {(!column.score_expression || column.instructor_only) && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    value="release"
                    onClick={releaseColumn}
                    disabled={isReleasing || isUnreleasing}
                    _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  >
                    {isReleasing ? <Spinner size="xs" mr={2} /> : <Icon as={LuCheck} boxSize={3} mr={2} />}
                    Release Column
                  </MenuItem>
                  <MenuItem
                    value="unrelease"
                    onClick={unreleaseColumn}
                    disabled={isReleasing || isUnreleasing}
                    _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  >
                    {isUnreleasing ? <Spinner size="xs" mr={2} /> : <Icon as={LuX} boxSize={3} mr={2} />}
                    Unrelease Column
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              {(!column.score_expression ||
                (column.score_expression && column.score_expression.startsWith("assignments("))) && (
                <MenuItem
                  value="convertMissing"
                  onClick={() => setIsConvertingMissing(true)}
                  color="fg.error"
                  _hover={{ bg: "bg.error", color: "fg.error" }}
                >
                  <Icon as={LuCalculator} boxSize={3} mr={2} />
                  Convert Missing to 0
                </MenuItem>
              )}
              <MenuItem
                value="delete"
                onClick={() => setIsDeleting(true)}
                color="fg.error"
                _hover={{ bg: "bg.error", color: "fg.error" }}
              >
                <Icon as={LuTrash} boxSize={3} mr={2} />
                Delete Column
              </MenuItem>
            </MenuContent>
          </MenuRoot>
        </HStack>

        <Box px={1.5} pr={3} pb={0} flex="1" display="flex" flexDirection="column" justifyContent="space-between">
          <WrappedTooltip content={toolTipText}>
            <Text
              fontWeight="semibold"
              fontSize="sm"
              color="fg.default"
              lineHeight="tight"
              w="100%"
              minW={0}
              style={{
                userSelect: "none",
                display: "-webkit-box",
                WebkitLineClamp: GRADE_HEADER_MAX_TITLE_LINES,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word"
              }}
            >
              {column.name}
            </Text>
          </WrappedTooltip>
          {showFilter && (
            <GradebookColumnFilter
              columnName={column.name}
              column_id={column_id}
              values={allGrades}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={headerRef}
            />
          )}
          <HStack gap={2} mt={0.5} justifyContent="space-between" w="100%" minW="fit-content">
            <HStack>
              {column.external_data && (
                <Box position="relative" zIndex={100}>
                  <Tooltip.Root lazyMount>
                    <Tooltip.Trigger asChild>
                      <Box position="relative" zIndex={100}>
                        <Icon as={LuFile} size="sm" color="fg.info" />
                      </Box>
                    </Tooltip.Trigger>
                    <Portal>
                      <Tooltip.Positioner style={{ zIndex: 10000 }}>
                        <Tooltip.Content>
                          <ExternalDataAdvice externalData={column.external_data as GradebookColumnExternalData} />
                        </Tooltip.Content>
                      </Tooltip.Positioner>
                    </Portal>
                  </Tooltip.Root>
                </Box>
              )}
              {column.instructor_only ? (
                <Box position="relative" zIndex={10000}>
                  <WrappedTooltip content="Staff-only: hidden from students until released">
                    <Icon as={LucideInfo} size="sm" color="purple.500" />
                  </WrappedTooltip>
                </Box>
              ) : column.score_expression ? (
                <Box position="relative" zIndex={10000}>
                  <WrappedTooltip content="Visibility: Students see this value calculated based on released dependencies">
                    <Icon as={LucideInfo} size="sm" color="blue.500" />
                  </WrappedTooltip>
                </Box>
              ) : hasMixedReleaseStatus ? (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Some students have released grades, others don't">
                    <Icon as={LucideInfo} size="sm" color="red.500" />
                  </WrappedTooltip>
                </Box>
              ) : column.released ? (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Released to students">
                    <Icon as={FaLockOpen} size="sm" color="green.500" />
                  </WrappedTooltip>
                </Box>
              ) : (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Not released to students">
                    <Icon as={FaLock} size="sm" color="orange.500" />
                  </WrappedTooltip>
                </Box>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted" fontWeight="medium" minW="fit-content">
              Max: {column.max_score ?? "N/A"}
            </Text>
            {columnModel?.getIsFiltered() && (
              <WrappedTooltip content="Clear filter">
                <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={() => setShowFilter(true)}>
                  <Icon as={TbFilter} />
                </IconButton>
              </WrappedTooltip>
            )}
          </HStack>
        </Box>
      </Box>
    </VStack>
  );
}

function GradebookGapDropTarget({
  gapIndex,
  boundaryLeftPx,
  leafHeaderHeight,
  showHitLayer,
  side,
  accent
}: {
  gapIndex: number;
  boundaryLeftPx: number;
  leafHeaderHeight: number;
  showHitLayer: boolean;
  /** At a group boundary, which half: "L" ends the group on the left, "R" starts the one on the right. */
  side?: "L" | "R";
  /** Color palette of the group the drop lands in. */
  accent?: string;
}) {
  const id = `${GRADEBOOK_GAP_PREFIX}${gapIndex}${side ? `:${side}` : ""}`;
  // The gap lights itself from isOver, so hovering during a drag re-renders only this gap rather
  // than the whole table.
  const { setNodeRef, isOver: lineVisible } = useDroppable({ id });
  const hitW = side ? 14 : 28;
  const hitLeft = side === "L" ? boundaryLeftPx - hitW : side === "R" ? boundaryLeftPx : boundaryLeftPx - hitW / 2;
  return (
    <Box
      ref={setNodeRef}
      position="absolute"
      left={`${hitLeft}px`}
      top={0}
      w={`${hitW}px`}
      h={`${leafHeaderHeight}px`}
      zIndex={showHitLayer ? 45 : 0}
      pointerEvents={showHitLayer ? "auto" : "none"}
    >
      {lineVisible && (
        <Box
          position="absolute"
          left={side === "L" ? undefined : side === "R" ? "2px" : "50%"}
          right={side === "L" ? "2px" : undefined}
          top={0}
          h="100%"
          w="3px"
          ml={side ? undefined : "-1.5px"}
          bg={accent && accent !== "gray" ? `${accent}.solid` : "blue.500"}
          borderRadius="1px"
          pointerEvents="none"
          boxShadow="md"
        />
      )}
    </Box>
  );
}

const COL_MIN_WIDTH = 60;
const COL_MAX_WIDTH = 500;

function ColumnResizeHandle({
  columnId,
  liveWidthsRef,
  getColWidth,
  onResizeEnd
}: {
  columnId: string;
  liveWidthsRef: React.MutableRefObject<Map<string, number>>;
  getColWidth: (id: string) => number;
  onResizeEnd: (id: string, width: number) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = liveWidthsRef.current.get(columnId) ?? getColWidth(columnId);
      const handleEl = handleRef.current;
      if (handleEl) handleEl.style.backgroundColor = "var(--chakra-colors-blue-400)";

      let rafId = 0;
      let latestWidth = startWidth;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const clamped = Math.max(COL_MIN_WIDTH, Math.min(COL_MAX_WIDTH, startWidth + delta));
        latestWidth = clamped;
        liveWidthsRef.current.set(columnId, clamped);

        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            const headerCell = document.querySelector(`[data-col-id="${columnId}"]`) as HTMLElement | null;
            if (headerCell) {
              headerCell.style.width = `${clamped}px`;
              headerCell.style.minWidth = `${clamped}px`;
            }
          });
        }
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        if (rafId) cancelAnimationFrame(rafId);
        if (handleEl) handleEl.style.backgroundColor = "";
        onResizeEnd(columnId, latestWidth);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [columnId, liveWidthsRef, getColWidth, onResizeEnd]
  );

  return (
    <Box
      ref={handleRef}
      position="absolute"
      right={0}
      top={0}
      bottom={0}
      w="6px"
      cursor="col-resize"
      zIndex={30}
      bg="transparent"
      _hover={{ bg: "blue.300" }}
      onPointerDown={onPointerDown}
      style={{ touchAction: "none" }}
    />
  );
}

type CollapsedGroupMeta = {
  isCollapsed?: boolean;
  groupKey?: string;
  groupName?: string;
  hiddenCount?: number;
  /** A column whose group is not loaded; see ORPHAN_GROUP_KEY. */
  isOrphan?: boolean;
};

/**
 * closestCenter measured from the pointer rather than from the middle of the dragged element. A
 * group band can be hundreds of pixels wide and is grabbed by a handle at its left end, so its
 * middle is far from where the instructor is pointing. Keyboard drags have no pointer and keep the
 * element's middle, which the arrow keys move.
 */
const closestCenterToPointer: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (!pointer) return closestCenter(args);
  return closestCenter({
    ...args,
    collisionRect: { top: pointer.y, bottom: pointer.y, left: pointer.x, right: pointer.x, width: 0, height: 0 }
  });
};

/** "4 Labs...": the member count and the pluralized, capitalized group name. */
function collapsedGroupSummary(groupName: string, count: number): string {
  const name = groupName.charAt(0).toUpperCase() + groupName.slice(1);
  return `${count} ${pluralize(name)}...`;
}

/** The thin strip a collapsed group shrinks to: its summary running down, and a click to expand. */
function CollapsedGroupStrip({
  meta,
  onToggleGroup
}: {
  meta: CollapsedGroupMeta;
  onToggleGroup?: (key: string) => void;
}) {
  return (
    <WrappedTooltip content={`${meta.groupName}: ${meta.hiddenCount} columns. Click to show them.`}>
      <chakra.button
        type="button"
        onClick={() => meta.groupKey && onToggleGroup?.(meta.groupKey)}
        aria-label={`Show all ${meta.hiddenCount} columns of ${meta.groupName}`}
        position="absolute"
        inset={0}
        display="flex"
        flexDirection="column"
        alignItems="center"
        gap={1}
        pt={1}
        cursor="pointer"
        _hover={{ bg: "bg.info" }}
        overflow="hidden"
      >
        <Icon as={LuChevronsLeftRight} boxSize={3} color="fg.muted" flexShrink={0} />
        {/* The same "4 Labs..." summary the collapsed header showed before groups were rows. */}
        <Text
          fontSize="xs"
          fontWeight="semibold"
          color="fg.muted"
          whiteSpace="nowrap"
          style={{ writingMode: "vertical-rl" }}
        >
          {collapsedGroupSummary(meta.groupName ?? "", meta.hiddenCount ?? 0)}
        </Text>
      </chakra.button>
    </WrappedTooltip>
  );
}

/** What an empty group shows under its band: a drop target and a way to add its first column. */
function EmptyGroupPlaceholderHeader({
  groupId,
  onAddColumn
}: {
  groupId: number;
  onAddColumn?: (groupId: number) => void;
}) {
  // Only columns can be dropped into a group; while a group is being dragged this is not a target.
  const { active } = useDndContext();
  const draggingGroup = String(active?.id ?? "").startsWith(GROUP_DRAG_PREFIX);
  const { setNodeRef, isOver } = useDroppable({
    id: `${EMPTY_GROUP_DROP_PREFIX}${groupId}`,
    disabled: draggingGroup
  });
  return (
    <Box
      ref={setNodeRef}
      position="absolute"
      inset="6px"
      display="flex"
      alignItems="center"
      justifyContent="center"
      borderWidth="1px"
      borderStyle="dashed"
      borderColor={isOver ? "border.info" : "border.emphasized"}
      bg={isOver ? "bg.info" : undefined}
      borderRadius="md"
    >
      {onAddColumn && (
        <Button size="xs" variant="ghost" onClick={() => onAddColumn(groupId)}>
          <Icon as={FiPlus} /> Add column
        </Button>
      )}
    </Box>
  );
}

/** Appears after the last column while a column is dragged; dropping there takes it out of its group. */
function UngroupDropZone({ left, height }: { left: number; height: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUP_DROP_ID });
  return (
    <Box
      ref={setNodeRef}
      position="absolute"
      left={`${left + 8}px`}
      top="6px"
      w="140px"
      h={`${Math.max(height - 12, 24)}px`}
      display="flex"
      alignItems="center"
      justifyContent="center"
      borderWidth="1px"
      borderStyle="dashed"
      borderColor={isOver ? "border.info" : "border.emphasized"}
      bg={isOver ? "bg.info" : "bg.subtle"}
      borderRadius="md"
      zIndex={45}
    >
      <Text fontSize="xs" color="fg.muted">
        Ungrouped
      </Text>
    </Box>
  );
}

function DraggableGradebookHeaderBox({
  header,
  vc,
  leafHeaderHeight,
  coreRowModel,
  classSections,
  labSections,
  showDragHandle,
  groupStyle,
  onToggleGroup,
  onAddColumnToGroup,
  reorderDisabled,
  isDraggingThis,
  anyColumnDragging,
  liveWidthsRef,
  getColWidth,
  onResizeEnd
}: {
  header: Header<UserProfile, unknown>;
  vc: VirtualItem;
  leafHeaderHeight: number;
  coreRowModel: RowModel<UserProfile>;
  classSections?: ClassSection[];
  labSections?: LabSection[];
  showDragHandle: boolean;
  groupStyle?: { palette: string; groupStart: boolean; isDefault: boolean };
  onToggleGroup?: (key: string) => void;
  onAddColumnToGroup?: (groupId: number) => void;
  reorderDisabled?: boolean;
  isDraggingThis: boolean;
  anyColumnDragging: boolean;
  liveWidthsRef?: React.MutableRefObject<Map<string, number>>;
  getColWidth?: (id: string) => number;
  onResizeEnd?: (id: string, width: number) => void;
}) {
  const collapsedMeta = header.column.columnDef.meta as CollapsedGroupMeta | undefined;
  const isEmptyGroup = header.column.id.startsWith(EMPTY_GROUP_PREFIX);
  const isCollapsedGroup = Boolean(collapsedMeta?.isCollapsed);
  const isCollapsedStub = isCollapsedGroup || isEmptyGroup;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: header.column.id,
    disabled: !showDragHandle || reorderDisabled || isCollapsedStub
  });

  const dragHandleEl =
    showDragHandle && !isCollapsedStub ? (
      <Box
        {...attributes}
        {...listeners}
        cursor={reorderDisabled ? "not-allowed" : "grab"}
        flexShrink={0}
        display="flex"
        alignItems="flex-start"
        aria-label="Drag to reorder column"
        opacity={reorderDisabled ? 0.35 : 1}
        _active={{ cursor: reorderDisabled ? "not-allowed" : "grabbing" }}
        pointerEvents={anyColumnDragging ? "none" : "auto"}
      >
        <Icon as={LuGripVertical} boxSize={3} color="fg.muted" />
      </Box>
    ) : undefined;

  const headerBody = isCollapsedGroup ? (
    <CollapsedGroupStrip meta={collapsedMeta!} onToggleGroup={onToggleGroup} />
  ) : isEmptyGroup ? (
    <EmptyGroupPlaceholderHeader
      groupId={Number(header.column.id.slice(EMPTY_GROUP_PREFIX.length))}
      onAddColumn={onAddColumnToGroup}
    />
  ) : header.column.id.startsWith("grade_") ? (
    <GradebookColumnHeader
      column_id={Number(header.column.id.slice(6))}
      isSorted={header.column.getIsSorted()}
      toggleSorting={header.column.toggleSorting}
      clearSorting={header.column.clearSorting}
      columnModel={header.column}
      dragHandle={dragHandleEl}
    />
  ) : header.isPlaceholder ? null : (
    <GenericGradebookColumnHeader
      columnName={header.column.id}
      isSorted={header.column.getIsSorted()}
      toggleSorting={header.column.toggleSorting}
      clearSorting={header.column.clearSorting}
      columnModel={header.column}
      header={header}
      coreRowModel={coreRowModel}
      classSections={classSections}
      labSections={labSections}
      dragHandle={dragHandleEl}
    />
  );

  return (
    <Box
      ref={setNodeRef}
      style={{
        position: "absolute",
        top: 0,
        left: `${vc.start}px`,
        width: `${vc.size}px`,
        zIndex: 10
      }}
      role="columnheader"
      bg="bg.muted"
      px={0}
      pt={0}
      pb={0}
      borderBottom="1px solid"
      borderLeft={groupStyle?.groupStart ? "2px solid" : "1px solid"}
      borderColor="border.emphasized"
      verticalAlign="top"
      minH={`${leafHeaderHeight}px`}
      opacity={isDraggingThis ? 0.35 : 1}
      pointerEvents={anyColumnDragging ? "none" : "auto"}
      data-col-id={header.column.id}
    >
      {headerBody}
      {liveWidthsRef && getColWidth && onResizeEnd && !isCollapsedGroup && (
        <ColumnResizeHandle
          columnId={header.column.id}
          liveWidthsRef={liveWidthsRef}
          getColWidth={getColWidth}
          onResizeEnd={onResizeEnd}
        />
      )}
    </Box>
  );
}

function StudentNameCell({ uid }: { uid: string }) {
  const isObfuscated = useObfuscatedGradesMode();
  const canShowGradeFor = useCanShowGradeFor(uid);
  const setOnlyShowGradesFor = useSetOnlyShowGradesFor();
  const { setView } = useStudentDetailView();
  const toggleOnlyShowGradesFor = useCallback(() => {
    setOnlyShowGradesFor(canShowGradeFor ? "" : uid);
  }, [setOnlyShowGradesFor, uid, canShowGradeFor]);

  return (
    <HStack w="100%" pl={3}>
      <Link onClick={() => setView(uid)}>
        {" "}
        <PersonName uid={uid} size="2xs" showAvatar={false} />
      </Link>
      <Box flex="1" display="flex" justifyContent="flex-end">
        {isObfuscated && (
          <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={toggleOnlyShowGradesFor}>
            <Icon as={canShowGradeFor ? TbEyeOff : TbEye} />
          </IconButton>
        )}
      </Box>
    </HStack>
  );
}
const MemoizedStudentNameCell = React.memo(StudentNameCell);
function StudentDetailDialog() {
  const { view, setView } = useStudentDetailView();
  return (
    <Dialog.Root open={!!view} onOpenChange={(details) => (!details.open ? setView(null) : undefined)} lazyMount>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{view && <PersonName uid={view} size="md" />}</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Text fontSize="sm" color="fg.muted">
              This view allows you to simulate the impact of a grade change. Students have the exact same interface (but
              can only see released gradebook columns and scores).
            </Text>
            {view && (
              <GradebookWhatIfProvider private_profile_id={view}>
                <WhatIf private_profile_id={view} whatIfEnabled={true} />
              </GradebookWhatIfProvider>
            )}
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
export default function GradebookTable() {
  const { course_id } = useParams();
  const students = useAllStudentRoles();
  const courseController = useCourseController();
  const gradebookController = useGradebookController();
  const gradebookColumns = useGradebookColumns();
  const columnGroups = useGradebookColumnGroups();
  const [gradebookDataEpoch, setGradebookDataEpoch] = useState(0);
  useEffect(() => {
    return gradebookController.table.subscribeToData(() => {
      setGradebookDataEpoch((n) => n + 1);
    });
  }, [gradebookController]);

  const scoreMaps = useMemo(() => {
    const sortVal = new Map<string, Map<number, number | null>>();
    const filterVal = new Map<string, Map<number, number | null>>();
    const preferPrivate = true;
    for (const student of gradebookController.table.data) {
      const sid = student.private_profile_id;
      const sSort = new Map<number, number | null>();
      const sFilt = new Map<number, number | null>();
      for (const col of gradebookColumns) {
        let entry = student.entries.find((e) => e.gc_id === col.id && e.is_private === preferPrivate);
        if (!entry) entry = student.entries.find((e) => e.gc_id === col.id && e.is_private === !preferPrivate);
        const num = parseGradebookEntryScore(entry?.score_override, entry?.score);
        sSort.set(col.id, num);
        sFilt.set(col.id, num);
      }
      sortVal.set(sid, sSort);
      filterVal.set(sid, sFilt);
    }
    return { sortVal, filterVal };
  }, [gradebookColumns, gradebookDataEpoch, gradebookController]);

  // Mirror scoreMaps into a ref so the accessor/filter closures baked into
  // our `columns` memo can always read the latest values without forcing a
  // ColumnDef rebuild on every gradebook data tick. Rebuilding `columns`
  // makes useReactTable regenerate every header object, which under some
  // conditions causes DraggableGradebookHeaderBox (keyed by `header.id`) to
  // unmount and remount its DOM subtree — and any in-flight playwright click
  // on the "Column options" button gets "element detached" mid-action. See
  // tests/e2e/gradebook.test.tsx Move Left/Move Right flake.
  const scoreMapsRef = useRef(scoreMaps);
  scoreMapsRef.current = scoreMaps;

  const isInstructor = useIsInstructor();
  const isRefetching = useGradebookRefetchStatus();
  const isGradebookDataReady = useIsGradebookDataReady();

  // State for collapsible groups - use base group name as key for stability
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [exportWithRenderExpressions, setExportWithRenderExpressions] = useState(false);
  const [activeDragColumnId, setActiveDragColumnId] = useState<string | null>(null);
  // Fetch class sections
  const { data: classSections } = useList<ClassSection>({
    resource: "class_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id as string }],
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    pagination: {
      pageSize: 1000
    }
  });

  // Get lab sections from course controller
  const { data: labSections } = courseController.listLabSections();

  // Map profile id to section ids and names
  const profileIdToSectionData = useMemo(() => {
    const map: Record<
      string,
      {
        classSection: { id: number | null; name: string };
        labSection: { id: number | null; name: string };
      }
    > = {};

    students.forEach((role) => {
      if (role.role === "student") {
        const classSection = classSections?.data?.find((s) => s.id === role.class_section_id);
        const labSection = labSections?.find((s) => s.id === role.lab_section_id);

        map[role.private_profile_id] = {
          classSection: {
            id: role.class_section_id ?? null,
            name: classSection?.name ?? "No Section"
          },
          labSection: {
            id: role.lab_section_id ?? null,
            name: labSection?.name ?? "No Lab Section"
          }
        };
      }
    });
    return map;
  }, [students, classSections?.data, labSections]);

  const columnsForGrouping = sortColumnsForDisplay(
    gradebookColumns.map((col) => ({
      id: col.id,
      slug: col.slug,
      name: col.name,
      max_score: col.max_score,
      gradebook_column_group_id: col.gradebook_column_group_id,
      position_in_group: col.position_in_group
    })),
    columnGroups
  );
  const cachedColumnsKey = JSON.stringify(columnsForGrouping);
  const groupedColumns = useMemo(
    () => buildGroupedColumns(JSON.parse(cachedColumnsKey) as typeof columnsForGrouping, columnGroups),
    [cachedColumnsKey, columnGroups]
  );

  const columnGroupKeyById = useMemo(
    () => buildColumnGroupKeyMap(JSON.parse(cachedColumnsKey) as typeof columnsForGrouping, columnGroups),
    [cachedColumnsKey, columnGroups]
  );

  const columnGroupById = useMemo(() => new Map(columnGroups.map((g) => [g.id, g])), [columnGroups]);
  /** Non-default groups in display order; the default group is pinned last and never moves. */
  const movableGroupOrder = useMemo(
    () =>
      columnGroups
        .filter((g) => !g.is_default)
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
        .map((g) => g.id),
    [columnGroups]
  );
  const paletteByGroupId = useMemo(() => {
    const map = new Map<number, string>();
    for (const g of columnGroups) map.set(g.id, groupPalette(g, movableGroupOrder.indexOf(g.id)));
    return map;
  }, [columnGroups, movableGroupOrder]);
  const [groupDialog, setGroupDialog] = useState<
    | { kind: "create" }
    | { kind: "edit"; group: GradebookColumnGroup }
    | { kind: "delete"; group: GradebookColumnGroup }
    | null
  >(null);
  const [addColumnDialog, setAddColumnDialog] = useState<{ groupId: number | null } | null>(null);

  const [layoutSavesInFlight, setLayoutSavesInFlight] = useState(0);
  const isReorderingColumns = layoutSavesInFlight > 0;
  const beginLayoutSave = useCallback(() => {
    setLayoutSavesInFlight((n) => n + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      setLayoutSavesInFlight((n) => Math.max(0, n - 1));
    };
  }, []);
  const layoutSaveState = useMemo<GradebookLayoutSaveState>(
    () => ({ layoutSaveInFlight: isReorderingColumns, beginLayoutSave }),
    [isReorderingColumns, beginLayoutSave]
  );

  /**
   * Moves the table first and saves second. The rows change locally before the RPC runs; a failed
   * save puts them back and says why, and a successful one is reconciled by a reload while further
   * layout changes stay disabled, so a later one never races a stale reload.
   *
   * `save` returns the gradebook's new column_layout_version when its RPC reports one, so the next
   * save sends the right expected version without waiting for the reload.
   */
  const runOptimisticLayoutChange = useCallback(
    async (opts: {
      columnPatches?: ColumnLayoutPatch[];
      groupPatches?: { id: number; values: { sort_order: number } }[];
      save: () => Promise<number | void>;
      failureTitle: string;
    }) => {
      const rollbacks = [
        opts.columnPatches?.length ? gradebookController.gradebook_columns.applyLocalPatches(opts.columnPatches) : null,
        opts.groupPatches?.length
          ? gradebookController.gradebook_column_groups.applyLocalPatches(opts.groupPatches)
          : null
      ].filter((r): r is () => void => r !== null);
      const endLayoutSave = beginLayoutSave();
      const saveAndRecordVersion = async () => {
        const version = await opts.save();
        if (typeof version === "number") gradebookController.setLayoutVersion(version);
      };
      try {
        try {
          await saveAndRecordVersion();
        } catch (e) {
          // Someone else changed the layout between our read and our write: take their version and retry once.
          if (!isLayoutConflict(e)) throw e;
          await gradebookController.reconcileLayout();
          await saveAndRecordVersion();
        }
      } catch (e) {
        rollbacks.forEach((rollback) => rollback());
        toaster.error({ title: opts.failureTitle, description: describeError(e) });
      } finally {
        // Held until the reload lands: a reload read before a later drag committed would otherwise
        // replace that drag's optimistic rows and move its column back until its own reload.
        try {
          await gradebookController.reconcileLayout();
        } finally {
          endLayoutSave();
        }
      }
    },
    [gradebookController, beginLayoutSave]
  );

  const reorderGroups = useCallback(
    (orderedGroupIds: number[]) =>
      runOptimisticLayoutChange({
        groupPatches: groupOrderPatches(orderedGroupIds),
        failureTitle: "Could not move the group",
        save: async () => {
          const { data, error } = await createClient().rpc("gradebook_column_groups_reorder", {
            p_gradebook_id: gradebookController.gradebook_id,
            p_ordered_group_ids: orderedGroupIds,
            p_expected_version: gradebookController.gradebook_row.rows[0]?.column_layout_version ?? 0
          });
          if (error) throw error;
          return data;
        }
      }),
    [runOptimisticLayoutChange, gradebookController]
  );

  const moveGroup = useCallback(
    async (group: GradebookColumnGroup, delta: -1 | 1) => {
      if (isReorderingColumns) return;
      const index = movableGroupOrder.indexOf(group.id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= movableGroupOrder.length) return;
      const next = [...movableGroupOrder];
      [next[index], next[target]] = [next[target], next[index]];
      await reorderGroups(next);
    },
    [movableGroupOrder, reorderGroups, isReorderingColumns]
  );

  // Groups start expanded. Forget collapse state only for groups that are gone, and only once the
  // groups have loaded: a group briefly holding fewer than two columns mid-move, or a reload, keeps it.
  useEffect(() => {
    if (!gradebookController.gradebook_column_groups.ready) return;
    const existingKeys = new Set(columnGroups.map((g) => columnGroupKey(g)));
    setCollapsedGroups((prev) => {
      const kept = [...prev].filter((key) => existingKeys.has(key));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [columnGroups, gradebookController]);

  // Force recalculation helper
  const forceRecalculation = useCallback(() => {
    setTimeout(() => {
      // Recalculate header height
      if (headerRef.current) {
        const height = headerRef.current.offsetHeight;
        setHeaderHeight(height);
      }

      // Recalculate first column width
      if (students && students.length > 0) {
        const tempElement = document.createElement("div");
        tempElement.style.position = "absolute";
        tempElement.style.visibility = "hidden";
        tempElement.style.whiteSpace = "nowrap";
        tempElement.style.fontSize = "14px";
        tempElement.style.fontFamily = "inherit";
        document.body.appendChild(tempElement);

        let maxWidth = 180;
        students.forEach((student) => {
          tempElement.textContent = student.profiles.name || student.profiles.short_name || "Unknown Student";
          const textWidth = tempElement.offsetWidth;
          maxWidth = Math.max(maxWidth, textWidth + 60);
        });

        document.body.removeChild(tempElement);
        const finalWidth = Math.min(maxWidth, 400);
        setFirstColumnWidth(finalWidth);
      }
    }, 50);
  }, [students]);

  // Toggle group collapse/expand using base group name
  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsedGroups((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(key)) {
          newSet.delete(key);
        } else {
          newSet.add(key);
        }
        return newSet;
      });

      // Force recalculation after toggle to fix alignment
      forceRecalculation();
    },
    [forceRecalculation]
  );

  const columnGroupActions = useMemo<ColumnGroupActions>(
    () => ({
      onEdit: (group) => setGroupDialog({ kind: "edit", group }),
      onDelete: (group) => setGroupDialog({ kind: "delete", group }),
      onAddColumn: (group) => setAddColumnDialog({ groupId: group.id }),
      onMove: (group, delta) => void moveGroup(group, delta),
      onToggleCollapse: (group) => toggleGroup(columnGroupKey(group))
    }),
    [moveGroup, toggleGroup]
  );

  const autoLayout = useCallback(async () => {
    const supabase = createClient();

    if (isReorderingColumns) return;
    setIsAutoLayouting(true);
    const endLayoutSave = beginLayoutSave();
    try {
      const { error } = await supabase.rpc("gradebook_auto_layout", {
        p_gradebook_id: gradebookController.gradebook_id
      });

      if (error) throw error;

      toaster.create({
        title: "Auto-layout complete",
        description: "Successfully reorganized gradebook columns",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Auto-layout failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      void gradebookController.reconcileLayout();
      endLayoutSave();
      setIsAutoLayouting(false);
    }
  }, [gradebookController, beginLayoutSave, isReorderingColumns]);

  const downloadGradebookCsv = useCallback(() => {
    const csv = gradebookController.exportGradebook(courseController, {
      useRenderExpressions: exportWithRenderExpressions
    });
    const csvText = csv
      .map((row) =>
        row
          .map((cell) => {
            let stringCell = cell === null || cell === undefined ? "" : String(cell);
            if (/^[=+@-]/.test(stringCell)) {
              stringCell = `'${stringCell}`;
            }
            return `"${stringCell.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\n");
    // UTF-8 BOM so Excel (especially on Windows) opens the file as UTF-8; otherwise emoji show as mojibake.
    const csvTextWithBom = `\uFEFF${csvText}`;
    const blob = new Blob([csvTextWithBom], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gradebook.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }, [courseController, exportWithRenderExpressions, gradebookController]);

  // Expand all groups
  const expandAll = useCallback(() => {
    setCollapsedGroups(new Set());
    forceRecalculation();
  }, [forceRecalculation]);

  // Collapse all groups
  const collapseAll = useCallback(() => {
    setCollapsedGroups(new Set(Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1)));
    forceRecalculation();
  }, [groupedColumns, forceRecalculation]);

  // Helper function to find the best column to show when collapsed
  const findBestColumnToShow = useCallback(
    (columns: typeof columnsForGrouping) => {
      // Start from the last column and work backwards
      for (let i = columns.length - 1; i >= 0; i--) {
        const col = columns[i];
        let hasNonMissingValues = false;

        // Check if this column has any non-missing values
        for (const student of students) {
          const controller = gradebookController.getStudentGradebookController(student.private_profile_id);
          const { item } = controller.getColumnForStudent(col.id);
          const score = item?.score_override ?? item?.score;

          if (score !== null && score !== undefined) {
            hasNonMissingValues = true;
            break;
          }
        }

        if (hasNonMissingValues) {
          return col;
        }
      }

      // If no column has non-missing values, return the last column
      return columns[columns.length - 1];
    },
    [students, gradebookController]
  );

  /**
   * Build columns with header groups
   *
   * Header groups are created from gradebook columns that share the same slug prefix
   * (everything before the first hyphen). Groups are only created when multiple
   * contiguous columns share the same prefix.
   *
   * Header Group Behavior:
   * - When EXPANDED: The group header spans all child columns using colSpan,
   *   and all individual column headers are shown below it
   * - When COLLAPSED: Only one representative column is shown (the one with
   *   the most recent non-missing data), and the group header covers just that column
   *
   * The width calculation ensures proper rendering:
   * - Collapsed: 120px (single column width)
   * - Expanded: 120px * number_of_columns_in_group
   */
  const columns: ColumnDef<UserProfile, unknown>[] = useMemo(() => {
    const cols: ColumnDef<UserProfile, unknown>[] = [
      {
        id: "student_name",
        header: "Student Name",
        accessorFn: (row) => row.name,
        cell: ({ row }) => <MemoizedStudentNameCell uid={row.original.id} />,
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const studentName = row.original.name || "";
          if (!filterValue) return true;
          if (Array.isArray(filterValue)) {
            // When multiple names are selected, check if student name is in the array
            return filterValue.some((name) => studentName.toLowerCase().includes(String(name).toLowerCase()));
          }
          // Single string filter - case-insensitive partial match
          return studentName.toLowerCase().includes(String(filterValue).toLowerCase());
        },
        enableSorting: true
      }
    ];

    // Only add class section column if there are class sections
    if (classSections?.data && classSections.data.length > 0) {
      cols.push({
        id: "class_section",
        header: "Class Section",
        accessorFn: (row) => profileIdToSectionData[row.id]?.classSection?.name ?? "No Section",
        cell: ({ row }) => {
          const name = profileIdToSectionData[row.original.id]?.classSection?.name ?? "No Section";
          return (
            <WrappedTooltip content={name}>
              <Text fontSize="sm" truncate>
                {name}
              </Text>
            </WrappedTooltip>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const sectionData = profileIdToSectionData[row.original.id]?.classSection;
          if (!sectionData || !filterValue) return true;
          if (Array.isArray(filterValue)) {
            return filterValue.includes(String(sectionData.id));
          }
          return String(sectionData.id) === filterValue;
        },
        enableSorting: true
      });
    }

    // Only add lab section column if there are lab sections
    if (labSections && labSections.length > 0) {
      cols.push({
        id: "lab_section",
        header: "Lab Section",
        accessorFn: (row) => profileIdToSectionData[row.id]?.labSection?.name ?? "No Lab Section",
        cell: ({ row }) => {
          const name = profileIdToSectionData[row.original.id]?.labSection?.name ?? "No Lab Section";
          return (
            <WrappedTooltip content={name}>
              <Text fontSize="sm" truncate>
                {name}
              </Text>
            </WrappedTooltip>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const sectionData = profileIdToSectionData[row.original.id]?.labSection;
          if (!sectionData || !filterValue) return true;
          if (Array.isArray(filterValue)) {
            return filterValue.includes(String(sectionData.id));
          }
          return String(sectionData.id) === filterValue;
        },
        enableSorting: true
      });
    }

    // Add grouped gradebook columns, walking every group in display order so an empty group still
    // gets a placeholder column to sit over.
    const orderedGroups = [
      ...movableGroupOrder.map((id) => columnGroupById.get(id)).filter((g): g is GradebookColumnGroup => !!g),
      ...columnGroups.filter((g) => g.is_default)
    ];
    orderedGroups.forEach((groupRow) => {
      const groupKey = columnGroupKey(groupRow);
      const group = groupedColumns[groupKey];
      if (!group) {
        if (!groupRow.is_default) {
          cols.push({
            id: `${EMPTY_GROUP_PREFIX}${groupRow.id}`,
            header: groupRow.name,
            accessorFn: () => null,
            cell: () => null,
            enableColumnFilter: false,
            enableSorting: false,
            meta: { emptyGroupId: groupRow.id }
          });
        }
        return;
      }
      if (group.columns.length === 1) {
        // Single column - no need for group header
        const col = group.columns[0];
        cols.push({
          id: `grade_${col.id}`,
          header: col.name,
          // Read scoreMaps via ref so this ColumnDef stays referentially
          // stable across gradebookDataEpoch ticks — see scoreMapsRef.
          accessorFn: (row) => scoreMapsRef.current.sortVal.get(row.id)?.get(col.id) ?? null,
          sortingFn: (rowA, rowB, columnId) =>
            compareGradeColumnSortValues(rowA.getValue(columnId), rowB.getValue(columnId)),
          cell: ({ row }) => {
            return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
          },
          enableColumnFilter: true,
          filterFn: (row, columnId, filterValue) => {
            const fv = scoreMapsRef.current.filterVal.get(row.original.id)?.get(col.id) ?? null;
            return gradebookScoreFilterMatches(filterValue, gradebookScoreToFilterRawString(fv));
          },
          enableSorting: true
        });
      } else {
        // Multiple columns - handle collapsed state using base group name
        const isCollapsed = collapsedGroups.has(groupKey);
        if (isCollapsed) {
          // A collapsed group shrinks to one thin strip. It borrows a member's id so the layout code
          // that keys on grade_<id> keeps working, but it shows no grades. Its members' filters stop
          // applying while it is collapsed, like those of the members that are not rendered at all, so
          // a filter set on the borrowed column must pass every row rather than match null against it.
          const representative = findBestColumnToShow(group.columns);
          cols.push({
            id: `grade_${representative.id}`,
            header: group.groupName,
            accessorFn: () => null,
            cell: () => null,
            enableColumnFilter: false,
            filterFn: () => true,
            enableSorting: false,
            meta: {
              groupName: group.groupName,
              groupKey: groupKey,
              isCollapsed: true,
              hiddenCount: group.columns.length
            }
          });
          return;
        }

        group.columns.forEach((col) => {
          cols.push({
            id: `grade_${col.id}`,
            header: col.name,
            accessorFn: (row) => scoreMapsRef.current.sortVal.get(row.id)?.get(col.id) ?? null,
            sortingFn: (rowA, rowB, columnId) =>
              compareGradeColumnSortValues(rowA.getValue(columnId), rowB.getValue(columnId)),
            cell: ({ row }) => {
              return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
            },
            enableColumnFilter: true,
            filterFn: (row, columnId, filterValue) => {
              const fv = scoreMapsRef.current.filterVal.get(row.original.id)?.get(col.id) ?? null;
              return gradebookScoreFilterMatches(filterValue, gradebookScoreToFilterRawString(fv));
            },
            enableSorting: true,
            meta: {
              groupName: group.groupName,
              groupKey: groupKey,
              isCollapsed: isCollapsed
            }
          });
        });
      }
    });

    // Columns whose group has not loaded (e.g. one the insert trigger just made) go last as plain
    // columns: no band, no group controls, no drag handle, since there is no group to act on yet.
    groupedColumns[ORPHAN_GROUP_KEY]?.columns.forEach((col) => {
      cols.push({
        id: `grade_${col.id}`,
        header: col.name,
        accessorFn: (row) => scoreMapsRef.current.sortVal.get(row.id)?.get(col.id) ?? null,
        sortingFn: (rowA, rowB, columnId) =>
          compareGradeColumnSortValues(rowA.getValue(columnId), rowB.getValue(columnId)),
        cell: ({ row }) => {
          return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
        },
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const fv = scoreMapsRef.current.filterVal.get(row.original.id)?.get(col.id) ?? null;
          return gradebookScoreFilterMatches(filterValue, gradebookScoreToFilterRawString(fv));
        },
        enableSorting: true,
        meta: { isOrphan: true }
      });
    });

    return cols;
  }, [
    profileIdToSectionData,
    gradebookController,
    groupedColumns,
    collapsedGroups,
    findBestColumnToShow,
    classSections?.data,
    labSections,
    movableGroupOrder,
    columnGroupById,
    columnGroups
    // intentionally NOT depending on `scoreMaps`: accessorFn/filterFn read
    // it via scoreMapsRef. Row-model invalidation on data ticks is driven by
    // `studentProfiles` getting a fresh array reference per epoch (see memo
    // below), which makes TanStack re-run accessor/filter/sort closures.
  ]);

  // NOTE: depending on `gradebookDataEpoch` here is load-bearing. Our `columns`
  // memo intentionally omits `scoreMaps` from its deps (see scoreMapsRef
  // comment above) so ColumnDef objects stay stable across data ticks. But
  // TanStack Table caches its sorted/filtered row models keyed by the
  // `(data, columns)` references, so with both stable across ticks the
  // accessor/filter closures never re-run and a sorted/filtered view stays
  // stale after a realtime score update. Returning a fresh array reference
  // per epoch tick invalidates the row-model memos without rebuilding any
  // ColumnDef — accessors then run with the live scoreMapsRef values.
  const studentProfiles = useMemo(() => {
    return students.map((student) => student.profiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, gradebookDataEpoch]);
  // Table instance
  const table = useReactTable({
    data: studentProfiles,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      sorting: [{ id: "student_name", desc: false }]
    }
  });

  const headerGroups = table.getHeaderGroups();
  const rowModel = table.getRowModel();
  const coreRowModel = table.getCoreRowModel();

  const visibleLeafColumns = table.getVisibleLeafColumns();
  const firstGradeColIdx = visibleLeafColumns.findIndex((c) => isScrollableLeafId(c.id));
  const frozenColumnCount = firstGradeColIdx === -1 ? visibleLeafColumns.length : firstGradeColIdx;
  const scrollableLeafColumns = useMemo(() => {
    const leaf = table.getVisibleLeafColumns();
    const idx = leaf.findIndex((c) => isScrollableLeafId(c.id));
    return idx === -1 ? [] : leaf.slice(idx);
  }, [table, columns, collapsedGroups, cachedColumnsKey]);

  /** Per visible grade column: its group's palette, and whether it is the first column of that group. */
  /** The group each scrollable leaf belongs to, index-aligned with scrollableLeafColumns. */
  const leafGroupIds = useMemo(
    () =>
      scrollableLeafColumns.map((leaf) => {
        if (leaf.id.startsWith(EMPTY_GROUP_PREFIX)) return Number(leaf.id.slice(EMPTY_GROUP_PREFIX.length));
        if (!leaf.id.startsWith("grade_")) return undefined;
        const groupId = gradebookColumns.find((c) => c.id === Number(leaf.id.slice(6)))?.gradebook_column_group_id;
        // A column whose group is not loaded belongs to no group a drop could target.
        return groupId !== undefined && columnGroupById.has(groupId) ? groupId : undefined;
      }),
    [scrollableLeafColumns, gradebookColumns, columnGroupById]
  );

  const leafGroupStyle = useMemo(() => {
    const map = new Map<string, { palette: string; groupStart: boolean; isDefault: boolean }>();
    let previousGroup: number | undefined;
    for (const [index, leaf] of scrollableLeafColumns.entries()) {
      const groupId = leafGroupIds[index];
      if (groupId === undefined) continue;
      map.set(leaf.id, {
        palette: paletteByGroupId.get(groupId) ?? "gray",
        groupStart: groupId !== previousGroup,
        isDefault: columnGroupById.get(groupId)?.is_default ?? false
      });
      previousGroup = groupId;
    }
    return map;
  }, [scrollableLeafColumns, leafGroupIds, paletteByGroupId, columnGroupById]);

  // Column resize state: committed widths (triggers re-render) + live ref (no re-render during drag)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const liveWidthsRef = useRef<Map<string, number>>(new Map());
  const collapsedLeafIds = useMemo(
    () =>
      new Set(
        scrollableLeafColumns
          .filter((leaf) => (leaf.columnDef.meta as CollapsedGroupMeta | undefined)?.isCollapsed)
          .map((leaf) => leaf.id)
      ),
    [scrollableLeafColumns]
  );
  const getColWidth = useCallback(
    (colId: string): number => {
      if (collapsedLeafIds.has(colId)) return COLLAPSED_GROUP_COL_WIDTH;
      return columnWidths[colId] ?? (colId.startsWith(EMPTY_GROUP_PREFIX) ? EMPTY_GROUP_COL_WIDTH : GRADE_COL_WIDTH);
    },
    [columnWidths, collapsedLeafIds]
  );

  const scrollableWidth = useMemo(
    () => scrollableLeafColumns.reduce((sum, col) => sum + getColWidth(col.id), 0),
    [scrollableLeafColumns, getColWidth]
  );

  const visibleReorderUnits = useMemo(
    () =>
      buildVisibleReorderUnits({
        scrollableLeafColumns,
        groupedColumns,
        collapsedGroups,
        findBestColumnToShow,
        columnGroupKeyById
      }),
    [scrollableLeafColumns, groupedColumns, collapsedGroups, findBestColumnToShow, columnGroupKeyById]
  );

  const fullGradeColumnIdsOrdered = useMemo(
    () => sortColumnsForDisplay(gradebookColumns, columnGroups).map((c) => c.id),
    [gradebookColumns, columnGroups]
  );

  const supabaseForGradebook = useMemo(() => createClient(), []);

  // Drops are picked by closestCenterToPointer over the gap targets, so the keyboard sensor's default
  // coordinates (arrow keys nudge the dragged header sideways) land on gaps the same way a pointer does.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  const handleGradebookColumnDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragColumnId(String(event.active.id));
  }, []);

  const handleGradebookColumnDragCancel = useCallback(() => {
    setActiveDragColumnId(null);
  }, []);

  const handleGradebookColumnDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragColumnId(null);
      if (!isInstructor || isReorderingColumns) return;

      const overId = over?.id;
      if (typeof overId !== "string") return;
      const activeIdStr = String(active.id);
      const groupIdByColumnId = new Map(gradebookColumns.map((c) => [c.id, c.gradebook_column_group_id]));

      const dropColumn = (draggedColumnId: number, target: { groupId: number; beforeColumnId: number | null }) => {
        const plan = planColumnDrop({
          orderedColumnIds: fullGradeColumnIdsOrdered,
          groupIdByColumnId,
          draggedColumnId,
          target
        });
        if (plan.kind === "noop") return;
        return runOptimisticLayoutChange({
          columnPatches: columnLayoutPatches({ plan, orderedColumnIds: fullGradeColumnIdsOrdered, groupIdByColumnId }),
          failureTitle: "Could not move the column",
          save: async () => {
            const { data, error } =
              plan.kind === "reorder-in-group"
                ? await supabaseForGradebook.rpc("gradebook_columns_reorder_in_group", {
                    p_group_id: plan.groupId,
                    p_ordered_column_ids: plan.orderedColumnIds,
                    p_expected_version: gradebookController.gradebook_row.rows[0]?.column_layout_version ?? 0
                  })
                : await supabaseForGradebook.rpc("gradebook_column_assign_group", {
                    p_column_id: plan.columnId,
                    p_group_id: plan.groupId,
                    p_position: plan.position,
                    p_expected_version: gradebookController.gradebook_row.rows[0]?.column_layout_version ?? 0
                  });
            if (error) throw error;
            // Both RPCs return the gradebook's new layout version.
            return typeof data === "number" ? data : undefined;
          }
        });
      };

      if (overId === UNGROUP_DROP_ID) {
        const defaultGroupId = columnGroups.find((g) => g.is_default)?.id;
        if (!activeIdStr.startsWith("grade_") || defaultGroupId === undefined) return;
        await dropColumn(Number(activeIdStr.slice(6)), { groupId: defaultGroupId, beforeColumnId: null });
        return;
      }

      // A column dropped on an empty group's placeholder moves into that group.
      if (overId.startsWith(EMPTY_GROUP_DROP_PREFIX)) {
        if (!activeIdStr.startsWith("grade_")) return;
        await dropColumn(Number(activeIdStr.slice(6)), {
          groupId: Number(overId.slice(EMPTY_GROUP_DROP_PREFIX.length)),
          beforeColumnId: null
        });
        return;
      }
      if (!overId.startsWith(GRADEBOOK_GAP_PREFIX)) return;

      // Gap ids are `gap_<n>`, or `gap_<n>:L` / `gap_<n>:R` for the two halves of a group boundary.
      const [gapPart, side] = overId.slice(GRADEBOOK_GAP_PREFIX.length).split(":");
      const gapIndex = Number(gapPart);
      if (!Number.isFinite(gapIndex) || gapIndex < 0 || gapIndex > visibleReorderUnits.length) return;

      if (activeIdStr.startsWith(GROUP_DRAG_PREFIX)) {
        // A group lands before whichever group owns the column after the gap, or last.
        const draggedGroupId = Number(activeIdStr.slice(GROUP_DRAG_PREFIX.length));
        const anchorGroupId = leafGroupIds[gapIndex];
        // Dropped on its own leading edge: it lands where it already is.
        if (anchorGroupId === draggedGroupId) return;
        const without = movableGroupOrder.filter((id) => id !== draggedGroupId);
        const at = anchorGroupId === undefined ? -1 : without.indexOf(anchorGroupId);
        const next =
          at === -1 ? [...without, draggedGroupId] : [...without.slice(0, at), draggedGroupId, ...without.slice(at)];
        if (next.every((id, k) => id === movableGroupOrder[k])) return;
        await reorderGroups(next);
        return;
      }
      if (!activeIdStr.startsWith("grade_")) return;

      // The left half of a boundary is the end of the group before it; anything else lands before the
      // column after the gap, in that column's group.
      const targetGroupId =
        side === "L" || gapIndex === visibleReorderUnits.length ? leafGroupIds[gapIndex - 1] : leafGroupIds[gapIndex];
      if (targetGroupId === undefined) return;
      // A column dropped on its own leading gap names itself as beforeColumnId; planColumnDrop reads
      // that as a no-op.
      await dropColumn(Number(activeIdStr.slice(6)), {
        groupId: targetGroupId,
        beforeColumnId:
          side === "L" || gapIndex === visibleReorderUnits.length ? null : (visibleReorderUnits[gapIndex]?.[0] ?? null)
      });
    },
    [
      isInstructor,
      isReorderingColumns,
      visibleReorderUnits,
      fullGradeColumnIdsOrdered,
      supabaseForGradebook,
      gradebookController,
      gradebookColumns,
      movableGroupOrder,
      leafGroupIds,
      runOptimisticLayoutChange,
      reorderGroups,
      columnGroups
    ]
  );

  const isDraggingGroup = Boolean(activeDragColumnId?.startsWith(GROUP_DRAG_PREFIX));
  /**
   * Ungrouped has no band to drop on while it is empty, so a zone stands in for it during a column
   * drag. Once it holds a column, its own band and drop lines are the target.
   */
  const showUngroupDropZone = useMemo(() => {
    if (!activeDragColumnId?.startsWith("grade_")) return false;
    const defaultGroupId = columnGroups.find((g) => g.is_default)?.id;
    return (
      defaultGroupId !== undefined && !gradebookColumns.some((c) => c.gradebook_column_group_id === defaultGroupId)
    );
  }, [activeDragColumnId, gradebookColumns, columnGroups]);
  /** Gaps a dragged group may land in: the ones between two groups, and the two ends. */
  const groupBoundaryGaps = useMemo(() => {
    const gaps = new Set<number>([0, visibleReorderUnits.length]);
    for (let g = 1; g < visibleReorderUnits.length; g++) {
      if (leafGroupIds[g - 1] !== leafGroupIds[g]) gaps.add(g);
    }
    return gaps;
  }, [visibleReorderUnits, leafGroupIds]);

  const dragOverlayGroup = useMemo(() => {
    if (!activeDragColumnId?.startsWith(GROUP_DRAG_PREFIX)) return null;
    return columnGroupById.get(Number(activeDragColumnId.slice(GROUP_DRAG_PREFIX.length))) ?? null;
  }, [activeDragColumnId, columnGroupById]);

  const dragOverlayColumn = useMemo(() => {
    if (!activeDragColumnId?.startsWith("grade_")) return null;
    const id = Number(activeDragColumnId.slice(6));
    return gradebookColumns.find((c) => c.id === id) ?? null;
  }, [activeDragColumnId, gradebookColumns]);

  // Virtualization setup
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLTableSectionElement>(null);

  // Dynamic first column width calculation
  const [firstColumnWidth, setFirstColumnWidth] = useState(180); // Default width

  // Header height state for Safari compatibility
  const [headerHeight, setHeaderHeight] = useState(0);

  /** Uniform height for leaf header row (pre-measured; matches clamped title + toolbar + status row). */
  const minGradeColWidth = useMemo(() => {
    if (scrollableLeafColumns.length === 0) return GRADE_COL_WIDTH;
    return Math.min(...scrollableLeafColumns.map((c) => getColWidth(c.id)));
  }, [scrollableLeafColumns, getColWidth]);

  const leafHeaderHeight = useMemo(() => {
    const names = gradebookColumns.map((c) => c.name).filter((n): n is string => Boolean(n && String(n).trim()));
    return measureMaxGradeHeaderHeight(names, minGradeColWidth, GRADE_HEADER_MAX_TITLE_LINES);
  }, [gradebookColumns, minGradeColWidth]);

  // Detect Safari browser
  const isSafari = useMemo(() => {
    if (typeof window === "undefined") return false;
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }, []);

  const calculateFirstColumnWidth = useCallback(() => {
    if (!students || students.length === 0) return;

    // Create a temporary element to measure text width
    const tempElement = document.createElement("div");
    tempElement.style.position = "absolute";
    tempElement.style.visibility = "hidden";
    tempElement.style.whiteSpace = "nowrap";
    tempElement.style.fontSize = "14px"; // Match the font size used in PersonName
    tempElement.style.fontFamily = "inherit";
    document.body.appendChild(tempElement);

    let maxWidth = 180; // Minimum width

    // Measure each student name
    students.forEach((student) => {
      tempElement.textContent = student.profiles.name || student.profiles.short_name || "Unknown Student";
      const textWidth = tempElement.offsetWidth;
      maxWidth = Math.max(maxWidth, textWidth + 60); // Add padding for icons and spacing
    });

    // Clean up
    document.body.removeChild(tempElement);

    // Set a reasonable maximum width
    const finalWidth = Math.min(maxWidth, 400); // Cap at 400px
    setFirstColumnWidth(finalWidth);
  }, [students]);

  const calculateHeaderHeight = useCallback(() => {
    if (headerRef.current) {
      const height = headerRef.current.offsetHeight;
      setHeaderHeight(height);
    }
  }, []);

  // Calculate width when students change
  useEffect(() => {
    calculateFirstColumnWidth();
  }, [calculateFirstColumnWidth]);

  // Calculate header height after render and when columns/groups / computed leaf height change
  useEffect(() => {
    calculateHeaderHeight();
  }, [calculateHeaderHeight, gradebookColumns.length, groupedColumns, collapsedGroups, leafHeaderHeight]);

  // Force recalculation after a short delay to handle async rendering
  useEffect(() => {
    const timer = setTimeout(() => {
      forceRecalculation();
    }, 100);
    return () => clearTimeout(timer);
  }, [forceRecalculation, groupedColumns, collapsedGroups]);

  // Add ResizeObserver to handle layout changes
  useEffect(() => {
    if (!parentRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      forceRecalculation();
    });

    resizeObserver.observe(parentRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [forceRecalculation]);

  const colEstimateSize = useCallback(
    (index: number) => getColWidth(scrollableLeafColumns[index]?.id ?? ""),
    [getColWidth, scrollableLeafColumns]
  );

  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollableLeafColumns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: colEstimateSize,
    // Key by column so cached sizes follow a column when it moves, instead of staying at its old index.
    getItemKey: (index) => scrollableLeafColumns[index]?.id ?? index,
    overscan: 3
  });

  // Group bands position themselves from the live widths, so the column virtualizer has to re-measure
  // in the same commit whenever the column list or a width changes, or headers and cells briefly sit
  // at the old offsets.
  useLayoutEffect(() => {
    columnVirtualizer.measure();
  }, [columnVirtualizer, scrollableLeafColumns, columnWidths]);

  const handleColumnResizeEnd = useCallback(
    (colId: string, newWidth: number) => {
      if (colId === "student_name") {
        setFirstColumnWidth(newWidth);
      } else {
        setColumnWidths((prev) => ({ ...prev, [colId]: newWidth }));
      }
      liveWidthsRef.current.delete(colId);
      setTimeout(() => {
        columnVirtualizer.measure();
        if (headerRef.current) {
          setHeaderHeight(headerRef.current.offsetHeight);
        }
      }, 0);
    },
    [columnVirtualizer]
  );

  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 45, // Estimated row height in pixels
    overscan: 20
  });

  const virtualRows = virtualizer.getVirtualItems();

  const scrollableRow1Segments = useMemo(() => {
    type Seg = {
      left: number;
      width: number;
      key: string;
      groupKey: string;
      groupId: number;
      isCollapsed: boolean;
      groupColumnsLen: number;
    };
    const segments: Seg[] = [];
    let pos = 0;
    let i = 0;
    while (i < scrollableLeafColumns.length) {
      const leaf = scrollableLeafColumns[i];
      if (leaf.id.startsWith(EMPTY_GROUP_PREFIX)) {
        const emptyGroupId = Number(leaf.id.slice(EMPTY_GROUP_PREFIX.length));
        segments.push({
          left: pos,
          width: getColWidth(leaf.id),
          key: `grp-empty-${emptyGroupId}`,
          groupKey: columnGroupKey({ id: emptyGroupId }),
          groupId: emptyGroupId,
          isCollapsed: false,
          groupColumnsLen: 0
        });
        pos += getColWidth(leaf.id);
        i++;
        continue;
      }
      const columnId = Number(leaf.id.slice(6));
      const groupKeyForColumn = columnGroupKeyById.get(columnId);
      const group = groupKeyForColumn ? groupedColumns[groupKeyForColumn] : undefined;
      if (!group) {
        pos += getColWidth(leaf.id);
        i++;
        continue;
      }
      const groupColumns = group.columns;
      const isFirstInGroup = groupColumns[0].id === columnId;
      const isCollapsed = collapsedGroups.has(groupKeyForColumn!);
      const bestCol = findBestColumnToShow(groupColumns);
      const isVisibleWhenCollapsed = isCollapsed && columnId === bestCol.id;

      if (isFirstInGroup || isVisibleWhenCollapsed) {
        const span = isCollapsed ? 1 : groupColumns.length;
        let width = 0;
        for (let j = 0; j < span && i + j < scrollableLeafColumns.length; j++) {
          width += getColWidth(scrollableLeafColumns[i + j].id);
        }
        segments.push({
          left: pos,
          width,
          key: `grp-${groupKeyForColumn}-${columnId}`,
          groupKey: groupKeyForColumn!,
          groupId: groupColumns[0].gradebook_column_group_id,
          isCollapsed,
          groupColumnsLen: groupColumns.length
        });
        pos += width;
        i += span;
      } else if (!isCollapsed) {
        i++;
      } else {
        i++;
      }
    }
    return segments;
  }, [scrollableLeafColumns, columnGroupKeyById, groupedColumns, collapsedGroups, findBestColumnToShow, getColWidth]);

  const filterHeader = useCallback(
    (header: Header<UserProfile, unknown>) => {
      if (header.column.id.startsWith("grade_")) {
        const columnId = Number(header.column.id.slice(6));
        const key = columnGroupKeyById.get(columnId);
        const group = key ? groupedColumns[key] : undefined;

        if (group && group.columns.length > 1 && collapsedGroups.has(key!)) {
          const bestColumn = findBestColumnToShow(group.columns);
          return columnId === bestColumn.id;
        }
      }
      return true;
    },
    [columnGroupKeyById, groupedColumns, collapsedGroups, findBestColumnToShow]
  );

  const renderVirtualRow = useCallback(
    (virtualRow: VirtualItem) => {
      const row = rowModel.rows[virtualRow.index];
      if (!row) return null;

      const idx = virtualRow.index;
      const cells = row.getVisibleCells();
      const frozenCells = cells.slice(0, frozenColumnCount);
      const scrollCells = cells.slice(frozenColumnCount);

      const cellBody = (cell: (typeof cells)[0], isStickyFirst: boolean, asTableCell: boolean) => {
        const inner = (
          <Box overflow="hidden" w="100%" minW={0}>
            {cell.column.columnDef.cell
              ? flexRender(cell.column.columnDef.cell, cell.getContext())
              : String(cell.getValue())}
          </Box>
        );

        const bg = idx % 2 === 0 ? "bg.subtle" : "bg.muted";
        const groupStart = !isStickyFirst && leafGroupStyle.get(cell.column.id)?.groupStart;

        const styleBase = {
          ...(isStickyFirst
            ? {
                position: "sticky" as const,
                left: 0,
                zIndex: 18,
                borderRight: "1px solid var(--chakra-colors-border-muted)",
                width: `${firstColumnWidth}px`,
                maxWidth: `${firstColumnWidth}px`,
                minWidth: `${firstColumnWidth}px`
              }
            : {
                width: `${getColWidth(cell.column.id)}px`,
                maxWidth: `${getColWidth(cell.column.id)}px`,
                minWidth: `${getColWidth(cell.column.id)}px`,
                zIndex: 1
              }),
          ...(groupStart ? { borderLeft: "2px solid var(--chakra-colors-border-emphasized)" } : {}),
          height: `${virtualRow.size}px`,
          verticalAlign: "middle" as const,
          boxSizing: "border-box" as const,
          overflow: "hidden" as const
        };

        if (asTableCell) {
          return (
            <Table.Cell
              key={cell.id}
              p={2}
              position="relative"
              bg={bg}
              style={{ ...styleBase, display: "table-cell" }}
              className={isStickyFirst ? "sticky-first-cell" : undefined}
            >
              {inner}
            </Table.Cell>
          );
        }

        return (
          <Box
            key={cell.id}
            data-gradebook-scroll-cell=""
            p={2}
            position="relative"
            bg={bg}
            {...styleBase}
            display="flex"
            alignItems="center"
          >
            {inner}
          </Box>
        );
      };

      return (
        <Table.Row
          key={`${row.id}-${virtualRow.index}`}
          role="row"
          aria-label={`Student ${row.original.name || "Unknown"} grades`}
          bg={idx % 2 === 0 ? "bg.subtle" : "bg.muted"}
          _hover={{ bg: "bg.info" }}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: `${virtualRow.size}px`,
            transform: `translateY(${virtualRow.start + (isSafari ? headerHeight || 120 : 0)}px)`,
            display: "table",
            tableLayout: "fixed"
          }}
        >
          {frozenCells.map((cell, colIdx) => cellBody(cell, colIdx === 0, true))}
          <Table.Cell
            key={`${row.id}-scroll-region`}
            p={0}
            position="relative"
            style={{
              width: scrollableWidth,
              minWidth: scrollableWidth,
              maxWidth: scrollableWidth,
              height: `${virtualRow.size}px`,
              verticalAlign: "middle",
              display: "table-cell",
              boxSizing: "border-box"
            }}
          >
            <Box position="relative" w={`${scrollableWidth}px`} h={`${virtualRow.size}px`}>
              {columnVirtualizer.getVirtualItems().map((vc) => {
                const cell = scrollCells[vc.index];
                if (!cell) return null;
                return (
                  <Box key={cell.id} position="absolute" top={0} left={`${vc.start}px`} w={`${vc.size}px`} h="100%">
                    {cellBody(cell, false, false)}
                  </Box>
                );
              })}
            </Box>
          </Table.Cell>
        </Table.Row>
      );
    },
    [
      rowModel.rows,
      frozenColumnCount,
      scrollableWidth,
      columnVirtualizer,
      firstColumnWidth,
      headerHeight,
      isSafari,
      getColWidth,
      leafGroupStyle
    ]
  );

  if (!students || !isGradebookDataReady) {
    return (
      <VStack gap={2} align="center" justify="center" minH="40vh">
        <Spinner size="lg" color="blue.500" />
        <Text fontSize="sm" color="fg.emphasized" fontWeight="medium">
          {!students ? "Loading students..." : "Loading gradebook data..."}
        </Text>
      </VStack>
    );
  }

  const body = (
    <VStack align="stretch" w="100%" gap={0} position="relative">
      {/* Gradebook data loading overlay */}
      {!isGradebookDataReady && (
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          bg="rgba(255, 255, 255, 0.8)"
          zIndex={1000}
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="md"
        >
          <VStack gap={2}>
            <Spinner size="lg" color="blue.500" />
            <Text fontSize="sm" color="fg.emphasized" fontWeight="medium">
              {isRefetching ? "Refreshing gradebook data..." : "Loading gradebook index..."}
            </Text>
          </VStack>
        </Box>
      )}

      <style jsx global>{`
        [data-gradebook-container] tbody tr:hover td,
        [data-gradebook-container] tbody tr:hover [data-gradebook-scroll-cell] {
          background-color: var(--chakra-colors-bg-info) !important;
        }
        @keyframes gradebook-pulse {
          0%,
          100% {
            opacity: 0.4;
          }
          50% {
            opacity: 1;
          }
        }
        .gradebook-cell-pulse {
          animation: gradebook-pulse 2s ease-in-out infinite;
        }
      `}</style>
      <StudentDetailDialog />
      <GradebookPopoverProvider>
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenterToPointer}
          onDragStart={handleGradebookColumnDragStart}
          onDragEnd={handleGradebookColumnDragEnd}
          onDragCancel={handleGradebookColumnDragCancel}
          modifiers={[restrictToHorizontalAxis]}
        >
          <GradebookPointerOpener
            ref={parentRef}
            data-gradebook-container=""
            overflowX="auto"
            overflowY="auto"
            maxW="100%"
            maxH="80vh"
            height="80vh"
            position="relative"
            role="region"
            aria-label="Instructor Gradebook Table"
            tabIndex={0}
          >
            <Table.Root
              minW={`${firstColumnWidth + visibleLeafColumns.slice(1, frozenColumnCount).reduce((s, c) => s + getColWidth(c.id), 0) + scrollableWidth}px`}
              w="100%"
              role="table"
              aria-label="Student grades by assignment"
              style={{
                tableLayout: "fixed",
                width: "100%",
                margin: 0,
                padding: 0,
                borderSpacing: 0,
                position: "relative"
              }}
            >
              <Table.Header
                ref={headerRef}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 20,
                  backgroundColor: "var(--chakra-colors-bg-subtle)",
                  borderBottom: "2px solid var(--chakra-colors-border-muted)",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)"
                }}
              >
                {/* 
              Group Header Row - This row contains the collapsible group headers
              
              Key behaviors:
              1. Each group header uses colSpan to span across all its child columns when expanded
              2. When collapsed, only shows one representative column with colSpan=1
              3. Width is calculated as 120px * colSpan to ensure proper visual alignment
              4. Clicking the header toggles the group's collapsed state
              5. Expanded groups have emphasized styling for clear visual grouping
              6. Expand/collapse all buttons are positioned discretely above the Student Name header
            */}
                <Table.Row>
                  {headerGroups[0].headers
                    .filter(filterHeader)
                    .slice(0, frozenColumnCount)
                    .map((header, colIdx) => (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.subtle"
                        style={{
                          position: "sticky",
                          top: 0,
                          left: colIdx === 0 ? 0 : undefined,
                          zIndex: colIdx === 0 ? 21 : 19,
                          minWidth: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                          width: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                          backgroundColor: "var(--chakra-colors-bg-subtle)"
                        }}
                      >
                        {colIdx === 0 &&
                          Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1).length >
                            0 && (
                            <HStack gap={1} justifyContent="flex-end" position="absolute" top={1} right={1} zIndex={22}>
                              <WrappedTooltip content="Auto-layout columns">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={autoLayout}
                                  colorPalette="blue"
                                  aria-label="Auto-layout columns"
                                  disabled={isAutoLayouting || isReorderingColumns}
                                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                                >
                                  {isAutoLayouting ? <Spinner size="xs" /> : <Icon as={LuLayoutGrid} boxSize={3} />}
                                </IconButton>
                              </WrappedTooltip>

                              <WrappedTooltip content="Expand all groups">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={expandAll}
                                  colorPalette="blue"
                                  aria-label="Expand all groups"
                                >
                                  <Icon as={LuChevronDown} boxSize={3} />
                                </IconButton>
                              </WrappedTooltip>
                              <WrappedTooltip content="Collapse all groups">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={collapseAll}
                                  colorPalette="blue"
                                  aria-label="Collapse all groups"
                                >
                                  <Icon as={LuChevronRight} boxSize={3} />
                                </IconButton>
                              </WrappedTooltip>
                            </HStack>
                          )}
                      </Table.ColumnHeader>
                    ))}
                  <Table.ColumnHeader
                    key="gradebook-h1-scroll"
                    p={0}
                    bg="bg.subtle"
                    verticalAlign="top"
                    style={{
                      width: scrollableWidth,
                      minWidth: scrollableWidth,
                      maxWidth: scrollableWidth,
                      position: "relative",
                      zIndex: 19
                    }}
                  >
                    <Box position="relative" w={`${scrollableWidth}px`} minH="36px">
                      {scrollableRow1Segments.map((seg) => {
                        const group = columnGroupById.get(seg.groupId);
                        if (!group) return null;
                        const order = movableGroupOrder.indexOf(group.id);
                        return (
                          <ColumnGroupHeader
                            key={seg.key}
                            group={group}
                            palette={paletteByGroupId.get(group.id) ?? "gray"}
                            left={seg.left}
                            width={seg.width}
                            columnCount={seg.groupColumnsLen}
                            isCollapsed={seg.isCollapsed}
                            isInstructor={isInstructor}
                            actions={columnGroupActions}
                            canMoveLeft={!isReorderingColumns && order > 0}
                            canMoveRight={!isReorderingColumns && order !== -1 && order < movableGroupOrder.length - 1}
                            isDragging={activeDragColumnId === `${GROUP_DRAG_PREFIX}${group.id}`}
                            dragDisabled={isReorderingColumns}
                            isLayoutSaving={isReorderingColumns}
                            anyDragging={Boolean(activeDragColumnId)}
                          />
                        );
                      })}
                    </Box>
                  </Table.ColumnHeader>
                </Table.Row>
                {/* Regular header row */}
                {headerGroups.map((headerGroup) => {
                  const row2Filtered = headerGroup.headers.filter(filterHeader);
                  const h2Frozen = row2Filtered.slice(0, frozenColumnCount);
                  const h2Scroll = row2Filtered.slice(frozenColumnCount);
                  return (
                    <Table.Row key={headerGroup.id}>
                      {h2Frozen.map((header, colIdx) => (
                        <Table.ColumnHeader
                          key={header.id}
                          bg="bg.muted"
                          p={0}
                          borderBottom="1px solid"
                          borderLeft="1px solid"
                          borderColor="border.emphasized"
                          verticalAlign="top"
                          data-col-id={header.column.id}
                          style={{
                            position: "sticky",
                            top: 0,
                            left: colIdx === 0 ? 0 : undefined,
                            zIndex: colIdx === 0 ? 21 : 19,
                            minWidth: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                            width: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                            height: "auto",
                            backgroundColor: "var(--chakra-colors-bg-subtle)"
                          }}
                        >
                          {header.column.id.startsWith("grade_") ? (
                            <GradebookColumnHeader
                              column_id={Number(header.column.id.slice(6))}
                              isSorted={header.column.getIsSorted()}
                              toggleSorting={header.column.toggleSorting}
                              clearSorting={header.column.clearSorting}
                              columnModel={header.column}
                            />
                          ) : header.isPlaceholder ? null : (
                            <GenericGradebookColumnHeader
                              columnName={header.column.id}
                              isSorted={header.column.getIsSorted()}
                              toggleSorting={header.column.toggleSorting}
                              clearSorting={header.column.clearSorting}
                              columnModel={header.column}
                              header={header}
                              coreRowModel={coreRowModel}
                              classSections={classSections?.data}
                              labSections={labSections}
                            />
                          )}
                          {isInstructor && (
                            <ColumnResizeHandle
                              columnId={header.column.id}
                              liveWidthsRef={liveWidthsRef}
                              getColWidth={colIdx === 0 ? () => firstColumnWidth : getColWidth}
                              onResizeEnd={handleColumnResizeEnd}
                            />
                          )}
                        </Table.ColumnHeader>
                      ))}
                      <Table.ColumnHeader
                        key={`${headerGroup.id}-scroll-h2`}
                        p={0}
                        borderBottom="1px solid"
                        borderColor="border.emphasized"
                        verticalAlign="top"
                        style={{
                          width: scrollableWidth,
                          minWidth: scrollableWidth,
                          maxWidth: scrollableWidth,
                          position: "relative",
                          height: "auto",
                          backgroundColor: "var(--chakra-colors-bg-subtle)"
                        }}
                      >
                        {isInstructor && scrollableLeafColumns.length > 0 ? (
                          <Box position="relative" w={`${scrollableWidth}px`} minH={`${leafHeaderHeight}px`}>
                            {Array.from({ length: visibleReorderUnits.length + 1 }, (_, gapIndex) => {
                              const isBoundary = groupBoundaryGaps.has(gapIndex);
                              if (isDraggingGroup && !isBoundary) return null;
                              let boundary = 0;
                              for (let g = 0; g < gapIndex && g < scrollableLeafColumns.length; g++) {
                                boundary += getColWidth(scrollableLeafColumns[g].id);
                              }
                              const common = {
                                gapIndex,
                                boundaryLeftPx: boundary,
                                leafHeaderHeight,
                                showHitLayer: Boolean(activeDragColumnId)
                              };
                              const paletteOf = (leafIndex: number) => {
                                const groupId = leafGroupIds[leafIndex];
                                return groupId === undefined ? undefined : paletteByGroupId.get(groupId);
                              };
                              // A column dropped on a group boundary needs to say which group it joins,
                              // so the boundary splits into the end of one and the start of the other.
                              if (isBoundary && !isDraggingGroup) {
                                return (
                                  <React.Fragment key={`gradebook-gap-${gapIndex}`}>
                                    {gapIndex > 0 && (
                                      <GradebookGapDropTarget {...common} side="L" accent={paletteOf(gapIndex - 1)} />
                                    )}
                                    {gapIndex < visibleReorderUnits.length && (
                                      <GradebookGapDropTarget {...common} side="R" accent={paletteOf(gapIndex)} />
                                    )}
                                  </React.Fragment>
                                );
                              }
                              return (
                                <GradebookGapDropTarget
                                  key={`gradebook-gap-${gapIndex}`}
                                  {...common}
                                  accent={isDraggingGroup ? undefined : paletteOf(gapIndex)}
                                />
                              );
                            })}
                            {showUngroupDropZone && (
                              <UngroupDropZone left={scrollableWidth} height={leafHeaderHeight} />
                            )}
                            {columnVirtualizer.getVirtualItems().map((vc) => {
                              const header = h2Scroll[vc.index];
                              if (!header) return null;
                              return (
                                <DraggableGradebookHeaderBox
                                  key={header.id}
                                  header={header}
                                  vc={vc}
                                  leafHeaderHeight={leafHeaderHeight}
                                  coreRowModel={coreRowModel}
                                  classSections={classSections?.data}
                                  labSections={labSections}
                                  showDragHandle={
                                    !(header.column.columnDef.meta as CollapsedGroupMeta | undefined)?.isOrphan
                                  }
                                  groupStyle={leafGroupStyle.get(header.column.id)}
                                  onToggleGroup={toggleGroup}
                                  onAddColumnToGroup={(groupId) => setAddColumnDialog({ groupId })}
                                  reorderDisabled={isReorderingColumns}
                                  isDraggingThis={activeDragColumnId === header.column.id}
                                  anyColumnDragging={Boolean(activeDragColumnId)}
                                  liveWidthsRef={liveWidthsRef}
                                  getColWidth={getColWidth}
                                  onResizeEnd={handleColumnResizeEnd}
                                />
                              );
                            })}
                          </Box>
                        ) : (
                          <Box position="relative" w={`${scrollableWidth}px`} minH={`${leafHeaderHeight}px`}>
                            {columnVirtualizer.getVirtualItems().map((vc) => {
                              const header = h2Scroll[vc.index];
                              if (!header) return null;
                              return (
                                <Box
                                  key={header.id}
                                  position="absolute"
                                  left={`${vc.start}px`}
                                  top={0}
                                  w={`${vc.size}px`}
                                  role="columnheader"
                                  bg="bg.muted"
                                  px={0}
                                  pt={0}
                                  pb={0}
                                  borderBottom="1px solid"
                                  borderLeft="1px solid"
                                  borderColor="border.emphasized"
                                  verticalAlign="top"
                                  minH={`${leafHeaderHeight}px`}
                                >
                                  {header.column.id.startsWith(EMPTY_GROUP_PREFIX) ? (
                                    <Text fontSize="xs" color="fg.muted" p={2}>
                                      No columns yet
                                    </Text>
                                  ) : (header.column.columnDef.meta as CollapsedGroupMeta | undefined)?.isCollapsed ? (
                                    <CollapsedGroupStrip
                                      meta={header.column.columnDef.meta as CollapsedGroupMeta}
                                      onToggleGroup={toggleGroup}
                                    />
                                  ) : header.column.id.startsWith("grade_") ? (
                                    <GradebookColumnHeader
                                      column_id={Number(header.column.id.slice(6))}
                                      isSorted={header.column.getIsSorted()}
                                      toggleSorting={header.column.toggleSorting}
                                      clearSorting={header.column.clearSorting}
                                      columnModel={header.column}
                                    />
                                  ) : header.isPlaceholder ? null : (
                                    <GenericGradebookColumnHeader
                                      columnName={header.column.id}
                                      isSorted={header.column.getIsSorted()}
                                      toggleSorting={header.column.toggleSorting}
                                      clearSorting={header.column.clearSorting}
                                      columnModel={header.column}
                                      header={header}
                                      coreRowModel={coreRowModel}
                                      classSections={classSections?.data}
                                      labSections={labSections}
                                    />
                                  )}
                                </Box>
                              );
                            })}
                          </Box>
                        )}
                      </Table.ColumnHeader>
                    </Table.Row>
                  );
                })}
              </Table.Header>
              <Table.Body
                style={{
                  height: `${virtualizer.getTotalSize() + (isSafari ? headerHeight || 120 : 0)}px`,
                  position: "relative",
                  margin: 0,
                  padding: 0,
                  borderSpacing: 0,
                  marginTop: 0,
                  paddingTop: 0
                }}
              >
                {virtualRows.map((virtualRow) => renderVirtualRow(virtualRow))}
              </Table.Body>
            </Table.Root>
          </GradebookPointerOpener>
          <DragOverlay dropAnimation={null}>
            {dragOverlayGroup ? (
              <Box
                colorPalette={paletteByGroupId.get(dragOverlayGroup.id)}
                bg="colorPalette.subtle"
                borderTop="3px solid"
                borderTopColor="colorPalette.solid"
                borderRadius="md"
                px={3}
                py={2}
                boxShadow="md"
              >
                <Text fontWeight="semibold" fontSize="sm" color="colorPalette.fg">
                  {dragOverlayGroup.name}
                </Text>
              </Box>
            ) : dragOverlayColumn ? (
              <Box
                bg="bg.muted"
                border="1px solid"
                borderColor="border.emphasized"
                borderRadius="md"
                p={2}
                minW={`${GRADE_COL_WIDTH}px`}
                boxShadow="md"
              >
                <Text fontWeight="semibold" fontSize="sm">
                  {dragOverlayColumn.name}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  Max: {dragOverlayColumn.max_score ?? "N/A"}
                </Text>
              </Box>
            ) : null}
          </DragOverlay>
        </DndContext>
      </GradebookPopoverProvider>
      {/* Show row count info */}
      <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
        <Text fontSize="sm" color="fg.muted">
          Showing {rowModel.rows.length} {pluralize("student", rowModel.rows.length)}
        </Text>
        {isInstructor && (
          <HStack gap={2} justifyContent="flex-end" px={4} py={0}>
            <PopoverRoot positioning={{ placement: "top-end" }}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Icon as={FiDownload} mr={2} /> Download Gradebook
                </Button>
              </PopoverTrigger>
              <PopoverContent maxW="300px">
                <PopoverBody p={3}>
                  <VStack align="start" gap={3}>
                    <Checkbox
                      checked={exportWithRenderExpressions}
                      onCheckedChange={(details) => setExportWithRenderExpressions(details.checked === true)}
                    >
                      Use render expressions in CSV
                    </Checkbox>
                    <Button size="sm" variant="subtle" colorPalette="green" onClick={downloadGradebookCsv}>
                      Download CSV
                    </Button>
                  </VStack>
                </PopoverBody>
              </PopoverContent>
            </PopoverRoot>
            <ImportGradebookColumn />
            <MenuRoot>
              <MenuTrigger asChild>
                <Button variant="solid" size="sm" colorPalette="green">
                  <Icon as={FiPlus} mr={2} /> Add
                </Button>
              </MenuTrigger>
              <MenuContent minW="180px">
                <MenuItem value="add-column" onClick={() => setAddColumnDialog({ groupId: null })}>
                  <Icon as={LuColumns3} boxSize={3} mr={2} />
                  Column
                </MenuItem>
                <MenuItem value="add-group" onClick={() => setGroupDialog({ kind: "create" })}>
                  <Icon as={LuGroup} boxSize={3} mr={2} />
                  Column group
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </HStack>
        )}
      </HStack>
      <AddColumnDialog
        isOpen={addColumnDialog !== null}
        onClose={() => setAddColumnDialog(null)}
        defaultGroupId={addColumnDialog?.groupId ?? null}
      />
      {groupDialog?.kind === "create" && <ColumnGroupDialog mode="create" onClose={() => setGroupDialog(null)} />}
      {groupDialog?.kind === "edit" && (
        <ColumnGroupDialog mode="edit" group={groupDialog.group} onClose={() => setGroupDialog(null)} />
      )}
      {groupDialog?.kind === "delete" && (
        <DeleteColumnGroupDialog group={groupDialog.group} onClose={() => setGroupDialog(null)} />
      )}
    </VStack>
  );
  return <GradebookLayoutSaveContext.Provider value={layoutSaveState}>{body}</GradebookLayoutSaveContext.Provider>;
}
