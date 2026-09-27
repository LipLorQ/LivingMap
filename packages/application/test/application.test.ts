import type { Action, GoodLifeCondition, Instant, Intention, Season, Stage } from "@living-map/domain";
import { describe, expect, it } from "vitest";
import { type Clock, createApplication, type IdGenerator, isAllowed, type Store } from "../src";

// In-memory Store fake: exercises application logic without any storage technology.
function memoryStore(): Store & { revision: number; changes: string[]; rollbacks: number } {
  let seasonRow: Season | undefined;
  const glc = new Map<string, GoodLifeCondition>();
  const intentionRows = new Map<string, Intention>();
  const stageRows = new Map<string, Stage>();
  const actionRows = new Map<string, Action>();
  const changeLogRows: Array<{
    id: string;
    timestamp: Instant;
    actor: string;
    correlationId: string;
    stateRevision: number;
    commandType: string;
    entityType: string;
    entityId: string;
    summary: string;
  }> = [];

  const byPosition = <T extends { position: number }>(items: T[]) => items.sort((a, b) => a.position - b.position);

  const state = {
    revision: 0,
    changes: [] as string[],
    rollbacks: 0,
    read: <T>(work: Parameters<Store["read"]>[0]) =>
      work({
        season: { get: () => seasonRow },
        goodLifeConditions: { findById: (id) => glc.get(id), list: () => byPosition([...glc.values()]) },
        intentions: {
          findById: (id) => intentionRows.get(id),
          list: () => [...intentionRows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        },
        stages: {
          findById: (id) => stageRows.get(id),
          listByIntention: (iid) => byPosition([...stageRows.values()].filter((s) => s.intentionId === iid)),
        },
        actions: {
          findById: (id) => actionRows.get(id),
          listByStage: (sid) => byPosition([...actionRows.values()].filter((a) => a.stageId === sid)),
          listByStages: (sids) => byPosition([...actionRows.values()].filter((a) => sids.includes(a.stageId))),
        },
        changeLog: { listRecent: (limit) => changeLogRows.slice().reverse().slice(0, limit) },
        stateRevision: () => state.revision,
      }) as T,
    write: <T>(ctx: Parameters<Store["write"]>[0], work: Parameters<Store["write"]>[1]) => {
      const snapshot = {
        season: seasonRow,
        glc: new Map(glc),
        intentionRows: new Map(intentionRows),
        stageRows: new Map(stageRows),
        actionRows: new Map(actionRows),
        revision: state.revision,
        changes: [...state.changes],
        changeLogRows: [...changeLogRows],
      };
      try {
        return runWork(work);
      } catch (error) {
        seasonRow = snapshot.season;
        glc.clear();
        for (const [k, v] of snapshot.glc) glc.set(k, v);
        intentionRows.clear();
        for (const [k, v] of snapshot.intentionRows) intentionRows.set(k, v);
        stageRows.clear();
        for (const [k, v] of snapshot.stageRows) stageRows.set(k, v);
        actionRows.clear();
        for (const [k, v] of snapshot.actionRows) actionRows.set(k, v);
        state.revision = snapshot.revision;
        state.changes = snapshot.changes;
        changeLogRows.length = 0;
        changeLogRows.push(...snapshot.changeLogRows);
        state.rollbacks++;
        throw error;
      }
      function runWork(w: Parameters<Store["write"]>[1]): T {
        return w({
          season: {
            get: () => seasonRow,
            insert: (s) => {
              seasonRow = s;
            },
            updateIfVersion: (s, expected) => {
              if (seasonRow?.version !== expected) return false;
              seasonRow = s;
              return true;
            },
          },
          goodLifeConditions: {
            findById: (id) => glc.get(id),
            list: () => byPosition([...glc.values()]),
            insert: (c) => void glc.set(c.id, c),
            updateIfVersion: (c, expected) => {
              if (glc.get(c.id)?.version !== expected) return false;
              glc.set(c.id, c);
              return true;
            },
            removeIfVersion: (id, expected) => {
              if (glc.get(id)?.version !== expected) return false;
              glc.delete(id);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = glc.get(id);
                if (cur) glc.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
          },
          intentions: {
            findById: (id) => intentionRows.get(id),
            list: () => [...intentionRows.values()],
            insert: (i) => void intentionRows.set(i.id, i),
            updateIfVersion: (i, expected) => {
              if (intentionRows.get(i.id)?.version !== expected) return false;
              intentionRows.set(i.id, i);
              return true;
            },
          },
          stages: {
            findById: (id) => stageRows.get(id),
            listByIntention: (iid) => byPosition([...stageRows.values()].filter((s) => s.intentionId === iid)),
            insert: (s) => void stageRows.set(s.id, s),
            updateIfVersion: (s, expected) => {
              if (stageRows.get(s.id)?.version !== expected) return false;
              stageRows.set(s.id, s);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = stageRows.get(id);
                if (cur) stageRows.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
            setCurrent: (intentionId, stageId, now) => {
              for (const [id, s] of stageRows) {
                if (s.intentionId !== intentionId || s.isCurrent === (id === stageId)) continue;
                stageRows.set(id, { ...s, isCurrent: id === stageId, version: s.version + 1, updatedAt: now });
              }
            },
          },
          actions: {
            findById: (id) => actionRows.get(id),
            listByStage: (sid) => byPosition([...actionRows.values()].filter((a) => a.stageId === sid)),
            listByStages: (sids) => byPosition([...actionRows.values()].filter((a) => sids.includes(a.stageId))),
            insert: (a) => void actionRows.set(a.id, a),
            updateIfVersion: (a, expected) => {
              if (actionRows.get(a.id)?.version !== expected) return false;
              actionRows.set(a.id, a);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = actionRows.get(id);
                if (cur) actionRows.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
          },
          recordChange: (c) => {
            state.changes.push(c.commandType);
            state.revision++;
            changeLogRows.push({
              id: `cl-${state.revision}`,
              timestamp: ctx.timestamp,
              actor: ctx.actor,
              correlationId: ctx.correlationId,
              stateRevision: state.revision,
              ...c,
            });
            return state.revision;
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
    expect(isAllowed("action.complete", "user-ui")).toBe(true);
    expect(isAllowed("action.complete", "mcp-ai")).toBe(false);
    expect(isAllowed("intention.create", "mcp-ai")).toBe(false);
    expect(isAllowed("toString", "user-ui")).toBe(false);
  });

  it("returns PERMISSION_DENIED and writes nothing when actor lacks capability", () => {
    const { app, store } = setup();
    const r = app.commands.createSeason(app.newContext("mcp-ai", "test"), { focus: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(store.revision).toBe(0);
  });
});

describe("Season", () => {
  it("create → update with correct version increments revision and logs changes", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");
    const created = app.commands.createSeason(ui, { focus: "recover" });
    if (!created.ok) throw new Error(created.error.message);
    const updated = app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "ship" });
    expect(updated).toMatchObject({ ok: true, value: { focus: "ship", version: 2 } });
    expect(store.revision).toBe(2);
    expect(store.changes).toEqual(["season.create", "season.updateFocus"]);
  });

  it("rejects creating a second season while one exists", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    app.commands.createSeason(ui, { focus: "a" });
    expect(app.commands.createSeason(ui, { focus: "b" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("stale expectedVersion returns CONFLICT_RELOAD and does not overwrite", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    app.commands.createSeason(ui, { focus: "a" });
    app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "b" });
    const stale = app.commands.updateSeasonFocus(app.newContext("system", "test"), { expectedVersion: 1, focus: "c" });
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });
    expect(app.queries.getSeason()).toMatchObject({ ok: true, value: { focus: "b", version: 2 } });
  });
});

describe("GoodLifeCondition", () => {
  it("add, edit, reorder, remove", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    const a = app.commands.addGoodLifeCondition(ui, { text: "sleep" });
    const b = app.commands.addGoodLifeCondition(ui, { text: "exercise" });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const reordered = app.commands.reorderGoodLifeConditions(ui, { orderedIds: [b.value.id, a.value.id] });
    expect(reordered).toMatchObject({
      ok: true,
      value: [
        { id: b.value.id, position: 1 },
        { id: a.value.id, position: 2 },
      ],
    });

    const edited = app.commands.editGoodLifeCondition(ui, {
      id: a.value.id,
      expectedVersion: a.value.version + 1,
      text: "sleep 8h",
    });
    expect(edited).toMatchObject({ ok: true, value: { text: "sleep 8h" } });

    const removed = app.commands.removeGoodLifeCondition(ui, { id: b.value.id, expectedVersion: b.value.version + 1 });
    expect(removed).toMatchObject({ ok: true, value: null });
    expect(app.queries.listGoodLifeConditions()).toMatchObject({ ok: true, value: [{ id: a.value.id }] });
  });

  it("reorder rejects a set that does not match the existing items", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    app.commands.addGoodLifeCondition(ui, { text: "a" });
    expect(app.commands.reorderGoodLifeConditions(ui, { orderedIds: ["not-a-real-id"] })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });
});

describe("Intention → Stage → Action", () => {
  it("full lifecycle: create intention, add stages, add actions, block/unblock, complete, reorder", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");

    const intention = app.commands.createIntention(ui, { title: "Ship v1", desiredResult: "" });
    if (!intention.ok) throw new Error(intention.error.message);
    expect(app.commands.createIntention(ui, { title: "Second", desiredResult: "" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });

    const updated = app.commands.updateIntention(ui, {
      id: intention.value.id,
      expectedVersion: 1,
      title: "Ship v1",
      desiredResult: "v1 is in users' hands",
    });
    expect(updated).toMatchObject({ ok: true, value: { desiredResult: "v1 is in users' hands" } });

    const stage1 = app.commands.addStage(ui, { intentionId: intention.value.id, title: "Design" });
    const stage2 = app.commands.addStage(ui, { intentionId: intention.value.id, title: "Build" });
    if (!stage1.ok || !stage2.ok) throw new Error("setup failed");
    expect(stage1.value.isCurrent).toBe(true);
    expect(stage2.value.isCurrent).toBe(false);

    const setCurrent = app.commands.setCurrentStage(ui, { intentionId: intention.value.id, stageId: stage2.value.id });
    expect(setCurrent).toMatchObject({
      ok: true,
      value: [
        { id: stage1.value.id, isCurrent: false },
        { id: stage2.value.id, isCurrent: true },
      ],
    });

    const action1 = app.commands.addAction(ui, {
      stageId: stage2.value.id,
      title: "Write code",
      doneWhen: "PR merged",
    });
    const action2 = app.commands.addAction(ui, {
      stageId: stage2.value.id,
      title: "Write tests",
      doneWhen: "CI green",
    });
    if (!action1.ok || !action2.ok) throw new Error("setup failed");

    const blocked = app.commands.blockAction(ui, {
      id: action1.value.id,
      expectedVersion: 1,
      reason: "waiting on API",
    });
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.value).toMatchObject({ status: "blocked", blocker: { reason: "waiting on API" } });
    expect(app.commands.completeAction(ui, { id: action1.value.id, expectedVersion: 2 })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    const unblocked = app.commands.unblockAction(ui, { id: action1.value.id, expectedVersion: 2 });
    expect(unblocked).toMatchObject({ ok: true, value: { status: "open" } });

    const completed = app.commands.completeAction(ui, { id: action1.value.id, expectedVersion: 3 });
    expect(completed).toMatchObject({ ok: true, value: { status: "done" } });

    expect(app.commands.reopenAction(ui, { id: action1.value.id, expectedVersion: 5 })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
    const reopened = app.commands.reopenAction(ui, { id: action1.value.id, expectedVersion: 4 });
    expect(reopened).toMatchObject({ ok: true, value: { status: "open", completedAt: null } });

    const recompleted = app.commands.completeAction(ui, { id: action1.value.id, expectedVersion: 5 });
    expect(recompleted).toMatchObject({ ok: true, value: { status: "done" } });

    const reordered = app.commands.reorderActions(ui, {
      stageId: stage2.value.id,
      orderedIds: [action2.value.id, action1.value.id],
    });
    expect(reordered).toMatchObject({
      ok: true,
      value: [
        { id: action2.value.id, position: 1 },
        { id: action1.value.id, position: 2 },
      ],
    });

    const view = app.queries.getCurrentView();
    if (!view.ok) throw new Error("expected ok");
    expect(view.value.intention?.desiredResult).toBe("v1 is in users' hands");
    expect(view.value.stages.map((s) => s.title)).toEqual(["Design", "Build"]);
    expect(view.value.stages[1]?.actions.map((a) => a.title)).toEqual(["Write tests", "Write code"]);

    expect(store.revision).toBeGreaterThan(0);
  });

  it("adding a stage to an unknown intention is NOT_FOUND", () => {
    const { app } = setup();
    expect(
      app.commands.addStage(app.newContext("user-ui", "test"), { intentionId: "missing", title: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("a failed Result from inside a write transaction rolls it back (never commits half a command)", () => {
    const { app, store } = setup();
    const ui = app.newContext("user-ui", "test");
    const intention = app.commands.createIntention(ui, { title: "x", desiredResult: "" });
    if (!intention.ok) throw new Error(intention.error.message);
    expect(store.rollbacks).toBe(0);
    const r = app.commands.updateIntention(ui, {
      id: intention.value.id,
      expectedVersion: 7,
      title: "y",
      desiredResult: "",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });
    expect(store.rollbacks).toBe(1);
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
    expect(app.queries.getCurrentView()).toEqual({
      ok: false,
      error: { code: "STORAGE_ERROR", message: "Storage operation failed" },
    });
  });
});

describe("change history", () => {
  it("listChangeHistory reflects recorded commands, most recent first", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    app.commands.createSeason(ui, { focus: "a" });
    app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "b" });
    const history = app.queries.listChangeHistory({ limit: 50 });
    if (!history.ok) throw new Error("expected ok");
    expect(history.value.map((h) => h.commandType)).toEqual(["season.updateFocus", "season.create"]);
  });
});
