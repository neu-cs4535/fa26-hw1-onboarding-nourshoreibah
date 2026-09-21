"use client";

import { toaster } from "@/components/ui/toaster";
import { useGradebookColumnGroups, useGradebookColumns, useGradebookController } from "@/hooks/useGradebook";
import { formatGroupWeight } from "@/lib/gradebookColumnGroups";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Dialog, HStack, Icon, IconButton, Input, Portal, Table, Text, VStack } from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { LuChevronDown, LuChevronUp, LuPlus, LuTrash2 } from "react-icons/lu";

export default function ManageColumnGroupsDialog() {
  const gradebookController = useGradebookController();
  const groups = useGradebookColumnGroups();
  const columns = useGradebookColumns();
  const supabase = useMemo(() => createClient(), []);

  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const countsByGroup = useMemo(() => {
    const counts = new Map<number, number>();
    for (const c of columns) {
      counts.set(c.gradebook_column_group_id, (counts.get(c.gradebook_column_group_id) ?? 0) + 1);
    }
    return counts;
  }, [columns]);

  const ordered = useMemo(
    () => [...groups].sort((a, b) => Number(a.is_default) - Number(b.is_default) || a.sort_order - b.sort_order),
    [groups]
  );
  const reorderable = useMemo(() => ordered.filter((g) => !g.is_default), [ordered]);

  const refresh = useCallback(async () => {
    await Promise.all([
      gradebookController.gradebook_column_groups.refetchAll(),
      gradebookController.gradebook_columns.refetchAll(),
      gradebookController.gradebook_row.refetchAll()
    ]);
  }, [gradebookController]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        toaster.create({ title: label, type: "success" });
      } catch (e) {
        toaster.error({
          title: `Could not ${label.toLowerCase()}`,
          description: e instanceof Error ? e.message : "Unexpected error"
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const createGroup = useCallback(async () => {
    const name = newGroupName.trim();
    if (!name) return;
    await run("Group created", async () => {
      const { error } = await supabase.from("gradebook_column_groups").insert({
        class_id: gradebookController.class_id,
        gradebook_id: gradebookController.gradebook_id,
        name,
        slug: `group-${Date.now()}`,
        sort_order: reorderable.length,
        name_is_auto: false
      });
      if (error) throw error;
      setNewGroupName("");
    });
  }, [newGroupName, run, supabase, gradebookController, reorderable.length]);

  const rename = useCallback(
    async (id: number, name: string) => {
      await run("Group renamed", async () => {
        const { error } = await supabase.from("gradebook_column_groups").update({ name }).eq("id", id);
        if (error) throw error;
      });
    },
    [run, supabase]
  );

  const setWeight = useCallback(
    async (id: number, raw: string) => {
      const trimmed = raw.trim();
      const weight = trimmed === "" ? null : Number(trimmed) / 100;
      if (weight !== null && (Number.isNaN(weight) || weight < 0)) {
        toaster.error({ title: "Weight must be a number of percent, or blank" });
        return;
      }
      await run("Weight saved", async () => {
        const { error } = await supabase.from("gradebook_column_groups").update({ weight }).eq("id", id);
        if (error) throw error;
      });
    },
    [run, supabase]
  );

  const move = useCallback(
    async (id: number, delta: -1 | 1) => {
      const index = reorderable.findIndex((g) => g.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= reorderable.length) return;
      const next = reorderable.map((g) => g.id);
      [next[index], next[target]] = [next[target], next[index]];
      await run("Groups reordered", async () => {
        const { error } = await supabase.rpc("gradebook_column_groups_reorder", {
          p_gradebook_id: gradebookController.gradebook_id,
          p_ordered_group_ids: next,
          p_expected_version: gradebookController.gradebook_row.rows[0]?.column_layout_version ?? 0
        });
        if (error) throw error;
      });
    },
    [reorderable, run, supabase, gradebookController]
  );

  const remove = useCallback(
    async (id: number) => {
      await run("Group deleted", async () => {
        const { error } = await supabase.rpc("gradebook_column_group_delete", { p_group_id: id });
        if (error) throw error;
      });
    },
    [run, supabase]
  );

  const weightTotal = useMemo(() => reorderable.reduce((sum, g) => sum + (g.weight ?? 0), 0), [reorderable]);
  const anyWeighted = useMemo(() => reorderable.some((g) => g.weight !== null), [reorderable]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => setIsOpen(e.open)} size="lg" placement="center" lazyMount>
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline" aria-label="Manage column groups">
          Manage groups
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Column groups</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <HStack>
                  <Input
                    placeholder="New group name"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    aria-label="New group name"
                  />
                  <Button onClick={createGroup} disabled={busy || !newGroupName.trim()}>
                    <Icon as={LuPlus} /> Add
                  </Button>
                </HStack>

                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Group</Table.ColumnHeader>
                      <Table.ColumnHeader>Columns</Table.ColumnHeader>
                      <Table.ColumnHeader>Weight %</Table.ColumnHeader>
                      <Table.ColumnHeader>Order</Table.ColumnHeader>
                      <Table.ColumnHeader />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {ordered.map((group) => (
                      <Table.Row key={group.id}>
                        <Table.Cell>
                          <Input
                            size="sm"
                            defaultValue={group.name}
                            aria-label={`Name of group ${group.name}`}
                            disabled={busy || group.is_default}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (next && next !== group.name) rename(group.id, next);
                            }}
                          />
                        </Table.Cell>
                        <Table.Cell>{countsByGroup.get(group.id) ?? 0}</Table.Cell>
                        <Table.Cell>
                          <Input
                            size="sm"
                            width="5rem"
                            inputMode="decimal"
                            defaultValue={group.weight === null ? "" : String(group.weight * 100)}
                            aria-label={`Weight of group ${group.name}, in percent`}
                            disabled={busy || group.is_default}
                            onBlur={(e) => setWeight(group.id, e.target.value)}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          {group.is_default ? null : (
                            <HStack gap={1}>
                              <IconButton
                                size="xs"
                                variant="ghost"
                                aria-label={`Move ${group.name} left`}
                                disabled={busy}
                                onClick={() => move(group.id, -1)}
                              >
                                <Icon as={LuChevronUp} />
                              </IconButton>
                              <IconButton
                                size="xs"
                                variant="ghost"
                                aria-label={`Move ${group.name} right`}
                                disabled={busy}
                                onClick={() => move(group.id, 1)}
                              >
                                <Icon as={LuChevronDown} />
                              </IconButton>
                            </HStack>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {group.is_default ? (
                            <Text fontSize="xs" color="fg.muted">
                              Always last
                            </Text>
                          ) : (
                            <IconButton
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              aria-label={`Delete group ${group.name}`}
                              disabled={busy}
                              onClick={() => remove(group.id)}
                            >
                              <Icon as={LuTrash2} />
                            </IconButton>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>

                {anyWeighted ? (
                  <Box>
                    <Text fontSize="sm" color={Math.abs(weightTotal - 1) < 1e-9 ? "fg.muted" : "fg.error"}>
                      Weights total {formatGroupWeight(weightTotal)}
                      {Math.abs(weightTotal - 1) < 1e-9
                        ? "."
                        : ". Nothing is recalculated from weights until a column's score expression calls weighted_total()."}
                    </Text>
                  </Box>
                ) : null}

                <Text fontSize="xs" color="fg.muted">
                  Deleting a group moves its columns to Ungrouped; it never deletes a column.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={() => setIsOpen(false)}>
                Close
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
