import type { CalendarSnapshotDto } from "@living-map/contracts";
import { describe, expect, it } from "vitest";
import { type Clock, createApplication, isAllowed, type Store } from "../src";
import { memoryStore, sequentialIds } from "./fakes";

const fakeClock: Clock = { now: () => "2026-09-27T10:00:00.000Z" };

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
    const updated = app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "ship", startsNewSeason: false });
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
    app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "b", startsNewSeason: false });
    const stale = app.commands.updateSeasonFocus(app.newContext("system", "test"), {
      expectedVersion: 1,
      focus: "c",
      startsNewSeason: false,
    });
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
    // Stage 8: a Season can hold several projects (up to three active) — the second one is fine.
    expect(app.commands.createIntention(ui, { title: "Second", desiredResult: "" })).toMatchObject({
      ok: true,
      value: { status: "active", position: 2 },
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
      touchWorkHeartbeat: () => {},
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
    app.commands.updateSeasonFocus(ui, { expectedVersion: 1, focus: "b", startsNewSeason: false });
    const history = app.queries.listChangeHistory({ limit: 50 });
    if (!history.ok) throw new Error("expected ok");
    expect(history.value.map((h) => h.commandType)).toEqual(["season.updateFocus", "season.create"]);
  });
});

describe("Сейчас / calendar (Stage 4)", () => {
  const disconnected: CalendarSnapshotDto = {
    connected: false,
    syncedAt: null,
    source: null,
    timeZone: null,
    events: [],
    lastError: null,
  };

  it("no active Intention: currentAction is null and needsAiReplan is false (a distinct, calmer state)", () => {
    const { app } = setup();
    const view = app.queries.getCurrentView();
    if (!view.ok) throw new Error("expected ok");
    expect(view.value.currentAction).toBeNull();
    expect(view.value.needsAiReplan).toBe(false);
    expect(view.value.calendarSnapshot).toEqual(disconnected);
  });

  it("an Intention with an approved route but no plan yet: needsAiReplan (nothing to follow)", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    app.commands.createIntention(ui, { title: "x", desiredResult: "y" });
    const view = app.queries.getCurrentView();
    if (!view.ok) throw new Error("expected ok");
    expect(view.value.currentAction).toBeNull();
    expect(view.value.needsAiReplan).toBe(true);
  });

  it("selects the plan's first admissible action as currentAction and skips a done one", () => {
    const { app } = setup();
    const ui = app.newContext("user-ui", "test");
    const ai = app.newContext("mcp-ai", "test");
    const intention = app.commands.createIntention(ui, { title: "x", desiredResult: "y" });
    if (!intention.ok) throw new Error(intention.error.message);
    const proposal = app.commands.createRouteProposal(ai, {
      intentionId: intention.value.id,
      expectedRevision: 1,
      summary: "first route",
      rationale: "because",
      newStages: [{ ref: "s1", title: "Stage 1" }],
      stageEdits: [],
      newActions: [
        { ref: "a1", stage: "s1", title: "First", doneWhen: "done" },
        { ref: "a2", stage: "s1", title: "Second", doneWhen: "done" },
      ],
      actionEdits: [],
      actionOrder: ["a1", "a2"],
    });
    if (!proposal.ok) throw new Error(proposal.error.message);
    const accepted = app.commands.acceptProposal(ui, { id: proposal.value.id });
    if (!accepted.ok) throw new Error(accepted.error.message);

    const firstView = app.queries.getCurrentView();
    if (!firstView.ok) throw new Error("expected ok");
    const firstActionId = firstView.value.stages[0]?.actions[0]?.id;
    expect(firstView.value.currentAction).toEqual({
      actionId: firstActionId,
      intentionId: firstView.value.intention?.id,
      stageId: firstView.value.stages[0]?.id,
      reason: { kind: "first-in-plan" },
      planRationale: firstView.value.orderedActionPlan?.rationale,
    });
    expect(firstView.value.needsAiReplan).toBe(false);

    const completed = app.commands.completeAction(ui, { id: firstActionId as string, expectedVersion: 1 });
    if (!completed.ok) throw new Error(completed.error.message);
    const secondView = app.queries.getCurrentView();
    if (!secondView.ok) throw new Error("expected ok");
    const secondActionId = secondView.value.stages[0]?.actions[1]?.id;
    expect(secondView.value.currentAction).toMatchObject({
      actionId: secondActionId,
      reason: { kind: "previous-done" },
    });

    // Blocking/completing the last remaining Action leaves nothing admissible: NeedsAIReplan.
    const blocked = app.commands.blockAction(ui, {
      id: secondActionId as string,
      expectedVersion: 1,
      reason: "waiting",
    });
    if (!blocked.ok) throw new Error(blocked.error.message);
    const thirdView = app.queries.getCurrentView();
    if (!thirdView.ok) throw new Error("expected ok");
    expect(thirdView.value.currentAction).toBeNull();
    expect(thirdView.value.needsAiReplan).toBe(true);
  });

  it("saveCalendarSnapshot is user-ui/system only; mcp-ai is denied and nothing is persisted", () => {
    const { app } = setup();
    const synced: CalendarSnapshotDto = {
      connected: true,
      syncedAt: "2026-09-27T09:00:00.000Z",
      source: "ical",
      timeZone: "Europe/Moscow",
      events: [],
      lastError: null,
    };
    const denied = app.commands.saveCalendarSnapshot(app.newContext("mcp-ai", "test"), synced);
    expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });

    const saved = app.commands.saveCalendarSnapshot(app.newContext("user-ui", "test"), synced);
    expect(saved).toEqual({ ok: true, value: synced });
    const view = app.queries.getCurrentView();
    if (!view.ok) throw new Error("expected ok");
    expect(view.value.calendarSnapshot).toEqual(synced);
  });
});
