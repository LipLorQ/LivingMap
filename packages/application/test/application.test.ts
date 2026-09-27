import type { Probe } from "@living-map/domain";
import { describe, expect, it } from "vitest";
import { type Clock, createApplication, type IdGenerator, isAllowed, type Store } from "../src";

// In-memory Store fake: exercises application logic without any storage technology.
function memoryStore(): Store & { revision: number; changes: string[]; rollbacks: number } {
  const rows = new Map<string, Probe>();
  const state = {
    revision: 0,
    changes: [] as string[],
    rollbacks: 0,
    read: <T>(work: Parameters<Store["read"]>[0]) =>
      work({
        probes: { findById: (id) => rows.get(id), list: () => [...rows.values()] },
        stateRevision: () => state.revision,
      }) as T,
    write: <T>(_ctx: Parameters<Store["write"]>[0], work: Parameters<Store["write"]>[1]) => {
      // Mirrors a real transaction: a throw from `work` means rollback.
      const snapshot = { rows: new Map(rows), revision: state.revision, changes: [...state.changes] };
      try {
        return runWork(work);
      } catch (error) {
        rows.clear();
        for (const [k, v] of snapshot.rows) rows.set(k, v);
        state.revision = snapshot.revision;
        state.changes = snapshot.changes;
        state.rollbacks++;
        throw error;
      }
      function runWork(w: Parameters<Store["write"]>[1]): T {
        return w({
          probes: {
            findById: (id) => rows.get(id),
            list: () => [...rows.values()],
            insert: (p) => void rows.set(p.id, p),
            updateIfVersion: (p, expected) => {
              if (rows.get(p.id)?.version !== expected) return false;
              rows.set(p.id, p);
              return true;
            },
          },
          recordChange: (c) => {
            state.changes.push(c.commandType);
            return ++state.revision;
          },
        }) as T;
      }
    },
  };
  return state;
}

const fakeClock: Clock = { now: () => "2026-09-27T10:00:00.000Z" };
function sequentialIds(): IdGenerator {
  let n = 0;
  return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}

function setup() {
  const store = memoryStore();
  const app = createApplication({ store, clock: fakeClock, ids: sequentialIds() });
  return { store, app };
}

describe("capability policy", () => {
  it("denies by default and allows only listed actor/command pairs", () => {
    expect(isAllowed("probe.rename", "mcp-ai")).toBe(true);
    expect(isAllowed("probe.create", "mcp-ai")).toBe(false);
    expect(isAllowed("probe.delete", "user-ui")).toBe(false);
    expect(isAllowed("toString", "user-ui")).toBe(false);
  });

  it("returns PERMISSION_DENIED and writes nothing when actor lacks capability", () => {
    const { app, store } = setup();
    const r = app.commands.createProbe(app.newContext("mcp-ai", "test"), { title: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(store.revision).toBe(0);
  });
});

describe("probe use cases", () => {
  it("create → rename with correct version increments revision and logs changes", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");
    const created = app.commands.createProbe(ui, { title: "a" });
    if (!created.ok) throw new Error(created.error.message);
    const renamed = app.commands.renameProbe(ui, { id: created.value.id, expectedVersion: 1, title: "b" });
    expect(renamed).toMatchObject({ ok: true, value: { title: "b", version: 2 } });
    expect(store.revision).toBe(2);
    expect(store.changes).toEqual(["probe.create", "probe.rename"]);
  });

  it("stale expectedVersion returns CONFLICT_RELOAD and does not overwrite", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");
    const created = app.commands.createProbe(ui, { title: "a" });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.id;
    expect(app.commands.renameProbe(ui, { id, expectedVersion: 1, title: "first" }).ok).toBe(true);
    const stale = app.commands.renameProbe(app.newContext("mcp-ai", "test"), {
      id,
      expectedVersion: 1,
      title: "stale",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });
    expect(app.queries.getProbe({ id })).toMatchObject({ ok: true, value: { title: "first", version: 2 } });
    expect(store.revision).toBe(2);
  });

  it("a failed Result from inside a write transaction rolls it back (never commits half a command)", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");
    const created = app.commands.createProbe(ui, { title: "a" });
    if (!created.ok) throw new Error(created.error.message);
    expect(store.rollbacks).toBe(0);
    const r = app.commands.renameProbe(ui, { id: created.value.id, expectedVersion: 7, title: "b" });
    expect(r).toEqual({ ok: false, error: { code: "CONFLICT_RELOAD", message: expect.any(String) } });
    expect(store.rollbacks).toBe(1);
  });

  it("maps domain invariant violations to VALIDATION_ERROR and unknown ids to NOT_FOUND", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    expect(app.commands.createProbe(ui, { title: "   " })).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(app.queries.getProbe({ id: "missing" })).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("storage exceptions become STORAGE_ERROR without leaking details", () => {
    const failing: Store = {
      read: () => {
        throw new Error("SQLITE_BUSY at C:\\secret\\path");
      },
      write: () => {
        throw new Error("boom");
      },
    };
    const app = createApplication({ store: failing, clock: fakeClock, ids: sequentialIds() });
    expect(app.queries.listProbes()).toEqual({
      ok: false,
      error: { code: "STORAGE_ERROR", message: "Storage operation failed" },
    });
  });
});
