/**
 * TableController.applyLocalPatches moves rows on screen before an RPC saves them, and hands back
 * a rollback for when the save fails. The gradebook's optimistic drags depend on both halves.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController from "@/lib/TableController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type Row = { id: number; name: string; position: number; __db_pending?: boolean };

function makeController(rows: Row[]) {
  const fetchStub = jest.fn(
    async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
  );
  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;
  const controller = new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from("profiles").select("*") as any,
    client,
    table: "profiles",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialData: rows as any,
    loadEntireTable: true
  });
  const view = () => controller.rows as unknown as Row[];
  return { controller, view };
}

/** A patch for the test rows; the controller is typed for profiles, which these rows stand in for. */
function patch(id: number, values: Partial<Row>) {
  return { id, values } as unknown as Parameters<TableController<"profiles">["applyLocalPatches"]>[0][number];
}

describe("TableController.applyLocalPatches", () => {
  it("changes the loaded rows at once and marks them pending", () => {
    const { controller, view } = makeController([
      { id: 1, name: "a", position: 0 },
      { id: 2, name: "b", position: 1 }
    ]);
    controller.applyLocalPatches([patch(1, { position: 1 }), patch(2, { position: 0 })]);
    expect(view().map((r) => [r.id, r.position, r.__db_pending])).toEqual([
      [1, 1, true],
      [2, 0, true]
    ]);
    expect(view().find((r) => r.id === 1)?.name).toBe("a");
    controller.close();
  });

  it("tells list listeners, so the table re-renders from the patched rows", () => {
    const { controller } = makeController([{ id: 1, name: "a", position: 0 }]);
    const seen: number[] = [];
    controller.list((rows) => seen.push((rows as unknown as Row[])[0].position));
    controller.applyLocalPatches([patch(1, { position: 5 })]);
    expect(seen).toContain(5);
    controller.close();
  });

  it("rolls every patched row back to what it was, no longer pending", () => {
    const { controller, view } = makeController([
      { id: 1, name: "a", position: 0 },
      { id: 2, name: "b", position: 1 }
    ]);
    const rollback = controller.applyLocalPatches([
      patch(1, { position: 1, name: "moved" }),
      patch(2, { position: 0 })
    ]);
    rollback();
    expect(view().map((r) => [r.id, r.name, r.position, Boolean(r.__db_pending)])).toEqual([
      [1, "a", 0, false],
      [2, "b", 1, false]
    ]);
    controller.close();
  });

  it("skips ids it has not loaded instead of failing the whole patch", () => {
    const { controller, view } = makeController([{ id: 1, name: "a", position: 0 }]);
    const rollback = controller.applyLocalPatches([patch(99, { position: 3 })]);
    expect(view()).toHaveLength(1);
    expect(() => rollback()).not.toThrow();
    controller.close();
  });

  it("tells list listeners once for the whole batch, not once per row", () => {
    const { controller } = makeController([
      { id: 1, name: "a", position: 0 },
      { id: 2, name: "b", position: 1 },
      { id: 3, name: "c", position: 2 }
    ]);
    let calls = 0;
    controller.list(() => calls++);
    const rollback = controller.applyLocalPatches([
      patch(1, { position: 2 }),
      patch(2, { position: 0 }),
      patch(3, { position: 1 })
    ]);
    expect(calls).toBe(1);
    rollback();
    expect(calls).toBe(2);
    controller.close();
  });

  it("leaves rows whose values would not change alone, not pending", () => {
    const { controller, view } = makeController([
      { id: 1, name: "a", position: 0 },
      { id: 2, name: "b", position: 1 }
    ]);
    let calls = 0;
    controller.list(() => calls++);
    controller.applyLocalPatches([patch(1, { position: 0 }), patch(2, { position: 5 })]);
    expect(view().map((r) => [r.id, r.position, Boolean(r.__db_pending)])).toEqual([
      [1, 0, false],
      [2, 5, true]
    ]);
    expect(calls).toBe(1);
    controller.applyLocalPatches([patch(1, { position: 0 })]);
    expect(calls).toBe(1);
    controller.close();
  });

  it("rolls back only the patched fields, and keeps a value that changed in the meantime", () => {
    const { controller, view } = makeController([
      { id: 1, name: "a", position: 0 },
      { id: 2, name: "b", position: 1 }
    ]);
    const rollback = controller.applyLocalPatches([patch(1, { position: 1 }), patch(2, { position: 0 })]);
    // Someone else's edit lands before the save fails: row 1's name, row 2's position.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._updateRow(1, { ...view()[0], name: "renamed" }, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._updateRow(2, { ...view()[1], position: 7 }, false);
    rollback();
    expect(view().map((r) => [r.id, r.name, r.position, Boolean(r.__db_pending)])).toEqual([
      [1, "renamed", 0, false],
      [2, "b", 7, false]
    ]);
    controller.close();
  });

  it("refuses a patch after close, and a rollback after close does nothing", () => {
    const { controller } = makeController([{ id: 1, name: "a", position: 0 }]);
    const rollback = controller.applyLocalPatches([patch(1, { position: 2 })]);
    controller.close();
    expect(() => rollback()).not.toThrow();
    expect(() => controller.applyLocalPatches([patch(1, { position: 3 })])).toThrow("closed");
  });
});
