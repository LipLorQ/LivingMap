// Stage 9, Day 1 correctness hotfix (2026-10-06): the owner marked a Stage she had created by hand as current
// and moved it to the top, but `Сейчас` kept showing an Action an old AI order had put first. Explicit owner
// operational choice (current Stage, Stage order, Action order) now controls `Сейчас`. Real SQLite file,
// deterministic clock — the same harness as the Day 1 repairs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStore, databaseFile, openDesktopDatabase, type SqliteHandle, uuidGenerator } from "../src";

const MIN = 60_000;
let home: string;
let handle: SqliteHandle;
let nowMs: number;
let app: Application;

const makeApp = () =>
  createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: { now: () => new Date(nowMs).toISOString() },
    ids: uuidGenerator,
    timeZone: () => "Asia/Jakarta",
  });
/** Close the file and open it again — a real app restart. */
const restart = () => {
  handle.close();
  handle = openDesktopDatabase(databaseFile(home));
  app = makeApp();
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-current-stage-"));
  handle = openDesktopDatabase(databaseFile(home));
  nowMs = Date.parse("2026-10-06T02:00:00.000Z");
  app = makeApp();
});
afterEach(() => {
  if (handle.sqlite.open) handle.close();
  rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ui = () => app.newContext("user-ui", "test");
const ai = () => app.newContext("mcp-ai", "test");
const view = () => unwrap(app.queries.getCurrentView());
const revision = () => unwrap(app.queries.getStateRevision()).stateRevision;
const count = (sql: string) => (handle.sqlite.prepare(sql).get() as { n: number }).n;
const runningCount = () => count("select count(*) n from work_intervals where ended_at is null");
const advance = (minutes: number) => {
  for (let left = minutes; left > 0; left -= 1) {
    nowMs += MIN;
    app.commands.heartbeatWork(app.newContext("system", "test"));
  }
};

/** A project the AI routed and the owner accepted: one Stage OLD with the given Actions, AI order = their order. */
function oldAiProject(actionTitles: string[] = ["OLD-1"]) {
  const intention = unwrap(app.commands.createIntention(ui(), { title: "Проект P", desiredResult: "P готов" }));
  const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "OLD" }));
  const actions = actionTitles.map(
    (t) => unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: t, doneWhen: `${t} готово` })).id,
  );
  const proposal = unwrap(
    app.commands.createRouteProposal(ai(), {
      intentionId: intention.id,
      expectedRevision: revision(),
      summary: "Порядок",
      rationale: "Порядок от ИИ",
      newStages: [],
      stageEdits: [],
      newActions: [],
      actionEdits: [],
      actionOrder: actions,
    }),
  );
  unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
  return { intentionId: intention.id, oldStageId: stage.id, oldActions: actions };
}
const addStage = (intentionId: string, title: string) => unwrap(app.commands.addStage(ui(), { intentionId, title })).id;
const addAction = (stageId: string, title: string) =>
  unwrap(app.commands.addAction(ui(), { stageId, title, doneWhen: `${title} готово` })).id;
const versionOf = (actionId: string) => {
  const action = view()
    .projects.flatMap((p) => p.stages.flatMap((s) => s.actions))
    .find((a) => a.id === actionId);
  if (!action) throw new Error("action not in view");
  return action.version;
};
const complete = (actionId: string) =>
  unwrap(app.commands.completeAction(ui(), { id: actionId, expectedVersion: versionOf(actionId) }));
const stagesOf = (intentionId: string) => view().projects.find((p) => p.intention.id === intentionId)?.stages ?? [];
const currentStageId = (intentionId: string) => stagesOf(intentionId).find((s) => s.isCurrent)?.id;
const makeCurrent = (intentionId: string, stageId: string) =>
  unwrap(app.commands.setCurrentStage(ui(), { intentionId, stageId }));

describe("«Сделать текущим» controls `Сейчас`", () => {
  it("the owner's exact bug: a hand-made Stage moved to the top and made current wins over the old AI Action", () => {
    const p = oldAiProject(["OLD-1"]);
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]); // the AI order's choice, before any owner edit

    const newStage = addStage(p.intentionId, "NEW");
    const new1 = addAction(newStage, "NEW-1");
    const new2 = addAction(newStage, "NEW-2");
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]); // adding alone changes nothing: OLD is current

    unwrap(app.commands.reorderStages(ui(), { intentionId: p.intentionId, orderedIds: [newStage, p.oldStageId] }));
    makeCurrent(p.intentionId, newStage);

    expect(view()).toMatchObject({
      currentAction: { actionId: new1, stageId: newStage, intentionId: p.intentionId },
      needsAiReplan: false,
      emptyCurrentStage: null,
    });
    expect(currentStageId(p.intentionId)).toBe(newStage);

    complete(new1);
    expect(view().currentAction?.actionId).toBe(new2);

    restart(); // a fresh application instance on the same file
    expect(currentStageId(p.intentionId)).toBe(newStage);
    expect(view().currentAction?.actionId).toBe(new2);

    // The old AI Action is history, still there, still open — it just does not hold the screen.
    const old1 = stagesOf(p.intentionId)
      .flatMap((s) => s.actions)
      .find((a) => a.id === p.oldActions[0]);
    expect(old1?.status).toBe("open");

    // Only when the owner's Stage is really finished does `Сейчас` move on, in HER Stage order.
    complete(new2);
    expect(view().currentAction).toMatchObject({ actionId: p.oldActions[0], stageId: p.oldStageId });
  });

  it("a current Stage without a usable Action says so — it never falls back to another Stage's work", () => {
    const p = oldAiProject(["OLD-1"]);
    const empty = addStage(p.intentionId, "NEW");
    makeCurrent(p.intentionId, empty);

    expect(view()).toMatchObject({
      currentAction: null,
      needsAiReplan: false,
      emptyCurrentStage: { intentionId: p.intentionId, stageId: empty },
    });
    expect(view().projects[0]).toMatchObject({ emptyCurrentStageId: empty });
    restart();
    expect(view()).toMatchObject({ currentAction: null, emptyCurrentStage: { stageId: empty } });

    // Adding an Action to it is enough: no generation, no replan needed.
    const added = addAction(empty, "NEW-1");
    expect(view()).toMatchObject({ currentAction: { actionId: added }, emptyCurrentStage: null });
  });

  it("a Stage whose only Action is blocked is told apart from a finished Stage: the owner stays in it", () => {
    const p = oldAiProject(["OLD-1"]);
    const stage = addStage(p.intentionId, "NEW");
    const only = addAction(stage, "NEW-1");
    makeCurrent(p.intentionId, stage);
    unwrap(app.commands.blockAction(ui(), { id: only, expectedVersion: versionOf(only), reason: "жду" }));
    expect(view()).toMatchObject({ currentAction: null, emptyCurrentStage: { stageId: stage } });
  });

  it("running work on the old Stage is paused (time kept, nothing auto-started) when another Stage is made current", () => {
    const p = oldAiProject(["OLD-1"]);
    const newStage = addStage(p.intentionId, "NEW");
    const new1 = addAction(newStage, "NEW-1");
    unwrap(app.commands.startWork(ui(), { actionId: p.oldActions[0] as string }));
    advance(12);
    expect(runningCount()).toBe(1);

    makeCurrent(p.intentionId, newStage);

    expect(runningCount()).toBe(0);
    expect(count("select count(*) n from work_intervals")).toBe(1); // no second interval was started
    const rows = handle.sqlite.prepare("select action_id, started_at, ended_at from work_intervals").all() as {
      action_id: string;
      ended_at: string | null;
    }[];
    expect(rows[0]).toMatchObject({ action_id: p.oldActions[0], ended_at: new Date(nowMs).toISOString() });
    expect(view()).toMatchObject({ currentAction: { actionId: new1 }, execution: { state: "idle", actionId: new1 } });
    expect(view().execution.todayWorkedMs).toBe(12 * MIN); // elapsed time preserved
    expect(unwrap(app.queries.listChangeHistory({ limit: 10 })).map((e) => e.commandType)).toContain("work.pause");
  });

  it("making the Stage you are already working in current does not touch the timer", () => {
    const p = oldAiProject(["OLD-1"]);
    unwrap(app.commands.startWork(ui(), { actionId: p.oldActions[0] as string }));
    advance(3);
    makeCurrent(p.intentionId, p.oldStageId);
    expect(runningCount()).toBe(1);
  });

  it("another project is its own: its position and its running timer are untouched", () => {
    const a = oldAiProject(["A-1"]);
    const bIntention = unwrap(app.commands.createIntention(ui(), { title: "Проект B", desiredResult: "B" }));
    const bStage1 = addStage(bIntention.id, "B-1-этап");
    const b1 = addAction(bStage1, "B-1");
    const bStage2 = addStage(bIntention.id, "B-2-этап");
    const b2 = addAction(bStage2, "B-2");
    const plan = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: bIntention.id,
        expectedRevision: revision(),
        summary: "B",
        rationale: "B",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [b1, b2],
      }),
    );
    unwrap(app.commands.acceptProposal(ui(), { id: plan.id }));
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: bIntention.id }));
    unwrap(app.commands.startWork(ui(), { actionId: b1 }));
    advance(5);
    const bCurrentBefore = currentStageId(bIntention.id);

    // The owner edits project A's current Stage while B's timer runs: B is not disturbed.
    const aNew = addStage(a.intentionId, "A-NEW");
    addAction(aNew, "A-NEW-1");
    makeCurrent(a.intentionId, aNew);
    expect(runningCount()).toBe(1);
    expect(currentStageId(bIntention.id)).toBe(bCurrentBefore);
    expect(view().currentAction?.actionId).toBe(b1);

    // Back on A: its own current Stage leads.
    complete(b1);
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: a.intentionId }));
    expect(view().currentAction).toMatchObject({ intentionId: a.intentionId, stageId: aNew });
  });
});

describe("manual Stage and Action order control execution", () => {
  it("moving a Stage above the current one comes first; an explicit «текущий» then wins despite its position", () => {
    const p = oldAiProject(["A-1"]); // Stage OLD (= A) is first and current
    const b = addStage(p.intentionId, "B");
    const b1 = addAction(b, "B-1");
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]); // old AI order: A first

    unwrap(app.commands.reorderStages(ui(), { intentionId: p.intentionId, orderedIds: [b, p.oldStageId] }));
    expect(view().currentAction).toMatchObject({ actionId: b1, stageId: b });
    restart();
    expect(view().currentAction?.actionId).toBe(b1);

    makeCurrent(p.intentionId, p.oldStageId); // she says: A now, regardless of its place in the list
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]);
    restart();
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]);
  });

  it("reordering Stages BELOW the current one does not move her", () => {
    const p = oldAiProject(["A-1"]);
    const b = addStage(p.intentionId, "B");
    addAction(b, "B-1");
    const c = addStage(p.intentionId, "C");
    addAction(c, "C-1");
    unwrap(app.commands.reorderStages(ui(), { intentionId: p.intentionId, orderedIds: [p.oldStageId, c, b] }));
    expect(currentStageId(p.intentionId)).toBe(p.oldStageId);
    expect(view().currentAction?.actionId).toBe(p.oldActions[0]);
  });

  it("a finished Stage moved up is not made current", () => {
    const p = oldAiProject(["A-1"]);
    const done = addStage(p.intentionId, "DONE");
    complete(addAction(done, "D-1"));
    unwrap(app.commands.reorderStages(ui(), { intentionId: p.intentionId, orderedIds: [done, p.oldStageId] }));
    expect(currentStageId(p.intentionId)).toBe(p.oldStageId);
  });

  it("moving a Stage up while the old Stage's timer runs pauses the timer", () => {
    const p = oldAiProject(["A-1"]);
    const b = addStage(p.intentionId, "B");
    addAction(b, "B-1");
    unwrap(app.commands.startWork(ui(), { actionId: p.oldActions[0] as string }));
    advance(4);
    unwrap(app.commands.reorderStages(ui(), { intentionId: p.intentionId, orderedIds: [b, p.oldStageId] }));
    expect(runningCount()).toBe(0);
    expect(view().execution.todayWorkedMs).toBe(4 * MIN);
  });

  it("the owner's Action order inside the Stage beats an older AI order; the AI can only propose a new one", () => {
    const p = oldAiProject(["A-1", "A-2", "A-3"]);
    const [a1, a2, a3] = p.oldActions as [string, string, string];
    expect(view().currentAction?.actionId).toBe(a1);

    // She drags the last Action to the top of the Stage.
    unwrap(app.commands.reorderActions(ui(), { stageId: p.oldStageId, orderedIds: [a3, a1, a2] }));
    expect(view().currentAction?.actionId).toBe(a3);
    restart();
    expect(view().currentAction?.actionId).toBe(a3);

    // An Action she added by hand afterwards is not in the AI order — and still goes where she puts it.
    const hand = addAction(p.oldStageId, "A-hand");
    expect(view().currentAction?.actionId).toBe(a3); // appended after the approved ones
    unwrap(app.commands.reorderActions(ui(), { stageId: p.oldStageId, orderedIds: [hand, a3, a1, a2] }));
    expect(view().currentAction?.actionId).toBe(hand);
    complete(hand);
    expect(view().currentAction?.actionId).toBe(a3);

    // The AI no longer overwrites an order the owner set: a direct reorder is refused...
    const ctx = unwrap(app.queries.getPlanningContext());
    expect(
      app.commands.reorderExistingActions(ai(), {
        intentionId: p.intentionId,
        expectedRevision: ctx.stateRevision,
        expectedPlanVersion: ctx.orderedActionPlan?.version as number,
        orderedActionIds: [a2, a3, a1],
        rationale: "Сначала второе",
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    expect(view().currentAction?.actionId).toBe(a3);

    // ...it can only PROPOSE; until she confirms, her order stands; after she confirms, the proposal is the order.
    const proposal = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: p.intentionId,
        expectedRevision: revision(),
        summary: "Сначала второе",
        rationale: "Сначала второе",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [a2, a3, a1],
      }),
    );
    expect(view().currentAction?.actionId).toBe(a3);
    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
    expect(view().currentAction?.actionId).toBe(a2);
  });

  it("Action order of one Stage never reaches into another Stage's Actions", () => {
    const p = oldAiProject(["A-1", "A-2"]);
    const [a1, a2] = p.oldActions as [string, string];
    const b = addStage(p.intentionId, "B");
    const b1 = addAction(b, "B-1");
    unwrap(app.commands.reorderActions(ui(), { stageId: p.oldStageId, orderedIds: [a2, a1] }));
    expect(view().currentAction?.actionId).toBe(a2);
    makeCurrent(p.intentionId, b);
    expect(view().currentAction?.actionId).toBe(b1);
  });
});

describe("no hidden side effects", () => {
  it("history is kept: nothing is deleted, the plan keeps covering the old Actions", () => {
    const p = oldAiProject(["OLD-1", "OLD-2"]);
    const stage = addStage(p.intentionId, "NEW");
    addAction(stage, "NEW-1");
    makeCurrent(p.intentionId, stage);
    expect(count("select count(*) n from actions")).toBe(3);
    expect(count("select count(*) n from stages")).toBe(2);
    // The order covers every unfinished Action — the old ones AND the owner's new one, nothing waits outside it.
    expect(view().projects[0]?.orderedActionPlan?.orderedActionIds).toHaveLength(3);
    expect(view().projects[0]?.unplannedActionIds).toEqual([]);
  });

  it("no approved route at all stays NeedsAIReplan (nothing to follow)", () => {
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Пустой", desiredResult: "x" }));
    const s = addStage(intention.id, "Этап");
    addAction(s, "Дело");
    expect(view()).toMatchObject({ currentAction: null, needsAiReplan: true, emptyCurrentStage: null });
  });
});

// ─── Stage 9 Day 1, second hotfix: OWNER MANUAL OPERATIONAL ORDER IS AUTHORITATIVE ─────────────────────────────
// One effective order. An AI order is a proposal/baseline; the owner's explicit edits (current Stage, Stage ↑↓,
// Action ↑↓, hand-added Actions) rewrite what actually executes — and the stored plan always says the same thing
// `Сейчас` follows.

const planRow = (intentionId: string) => {
  const row = handle.sqlite
    .prepare(
      "select ordered_action_ids ids, created_by createdBy, version from ordered_action_plans where intention_id = ?",
    )
    .get(intentionId) as { ids: string; createdBy: string; version: number };
  return { ids: JSON.parse(row.ids) as string[], createdBy: row.createdBy, version: row.version };
};
const effectiveIds = (intentionId: string) =>
  view().projects.find((p) => p.intention.id === intentionId)?.orderedActionPlan?.orderedActionIds ?? [];
const move = (stageId: string, orderedIds: string[]) =>
  unwrap(app.commands.reorderActions(ui(), { stageId, orderedIds }));
const moveStages = (intentionId: string, orderedIds: string[]) =>
  unwrap(app.commands.reorderStages(ui(), { intentionId, orderedIds }));
/** A project with one Stage per entry (title → action titles), approved by the owner with the AI's flat order. */
function routedProject(title: string, stages: Record<string, string[]>) {
  const intention = unwrap(app.commands.createIntention(ui(), { title, desiredResult: `${title} готов` }));
  const ids: { stage: Record<string, string>; action: Record<string, string> } = { stage: {}, action: {} };
  for (const [stageTitle, actionTitles] of Object.entries(stages)) {
    ids.stage[stageTitle] = addStage(intention.id, stageTitle);
    for (const t of actionTitles) ids.action[t] = addAction(ids.stage[stageTitle] as string, t);
  }
  const proposal = unwrap(
    app.commands.createRouteProposal(ai(), {
      intentionId: intention.id,
      expectedRevision: revision(),
      summary: "Порядок",
      rationale: "Порядок от ИИ",
      newStages: [],
      stageEdits: [],
      newActions: [],
      actionEdits: [],
      actionOrder: Object.values(ids.action),
    }),
  );
  unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
  return { intentionId: intention.id, ...ids };
}

describe("owner manual order is authoritative (ADR-0010 §9.11)", () => {
  it("the owner's exact screenshot case: old AI plan, a hand-made Stage REAL moved up, made current, ordered with arrows", () => {
    const p = oldAiProject(["AI-1", "AI-2", "AI-3"]);
    const [ai1, ai2, ai3] = p.oldActions as [string, string, string];
    expect(view().currentAction?.actionId).toBe(ai1);

    const real = addStage(p.intentionId, "REAL");
    const r1 = addAction(real, "REAL-1");
    const r2 = addAction(real, "REAL-2");
    const r3 = addAction(real, "REAL-3");
    // Hand-made Actions are in the order at once — never parked outside it behind the old AI list.
    expect(view().projects[0]?.unplannedActionIds).toEqual([]);
    expect(effectiveIds(p.intentionId)).toEqual([ai1, ai2, ai3, r1, r2, r3]);
    expect(view().currentAction?.actionId).toBe(ai1); // adding alone changes nothing: OLD is still her current Stage

    moveStages(p.intentionId, [real, p.oldStageId]);
    makeCurrent(p.intentionId, real);
    move(real, [r3, r1, r2]);

    expect(view()).toMatchObject({ currentAction: { actionId: r3, stageId: real }, emptyCurrentStage: null });
    expect(view().currentAction?.actionId).not.toBe(ai1);
    // The ONE order: what the screen shows, what the plan DTO says, and what is stored are the same sequence.
    expect(effectiveIds(p.intentionId)).toEqual([r3, r1, r2, ai1, ai2, ai3]);
    expect(planRow(p.intentionId)).toMatchObject({ ids: [r3, r1, r2, ai1, ai2, ai3], createdBy: "user-ui" });

    restart();
    expect(view().currentAction?.actionId).toBe(r3);
    expect(effectiveIds(p.intentionId)).toEqual([r3, r1, r2, ai1, ai2, ai3]);
    expect(currentStageId(p.intentionId)).toBe(real);
    // Old AI work is history/baseline — still there, untouched.
    expect(count("select count(*) n from actions where status = 'open'")).toBe(6);
  });

  it("Action arrows change the real order: C moved up becomes `Сейчас`; then A, then B — across reloads", () => {
    const p = oldAiProject(["A", "B", "C"]);
    const [a, b, c] = p.oldActions as [string, string, string];
    expect(view().currentAction?.actionId).toBe(a);

    move(p.oldStageId, [a, c, b]); // C up once
    expect(view().currentAction?.actionId).toBe(a);
    move(p.oldStageId, [c, a, b]); // C up twice
    expect(view().currentAction?.actionId).toBe(c); // immediately, no timer, no AI
    restart();
    expect(view().currentAction?.actionId).toBe(c);

    complete(c);
    expect(view().currentAction?.actionId).toBe(a);
    restart();
    expect(view().currentAction?.actionId).toBe(a);
    complete(a);
    expect(view().currentAction?.actionId).toBe(b);
  });

  it("Stage arrows change the real path: no explicit current → C→A→B; «Сделать текущим» on B; progression is documented", () => {
    const p = routedProject("Проект S", { A: ["A1"], B: ["B1"], C: ["C1"] });
    const a1 = p.action.A1 as string;
    const b1 = p.action.B1 as string;
    const c1 = p.action.C1 as string;
    expect(view().currentAction?.actionId).toBe(a1);

    moveStages(p.intentionId, [p.stage.C as string, p.stage.A as string, p.stage.B as string]);
    expect(view().currentAction?.actionId).toBe(c1); // the first usable Stage in HER order — not the AI's A→B→C
    expect(effectiveIds(p.intentionId)).toEqual([c1, a1, b1]);
    expect(planRow(p.intentionId).ids).toEqual([c1, a1, b1]);
    restart();
    expect(view().currentAction?.actionId).toBe(c1);

    makeCurrent(p.intentionId, p.stage.B as string);
    expect(view().currentAction?.actionId).toBe(b1);

    // Progression after an explicit «текущий» Stage is finished: the next unfinished Stage BELOW it in her order,
    // else (B is last) the first unfinished Stage from the top of her order — never the old AI sequence.
    complete(b1);
    expect(view().currentAction?.actionId).toBe(c1);
    expect(currentStageId(p.intentionId)).toBe(p.stage.C); // the badge follows where she actually works
    complete(c1);
    expect(view().currentAction?.actionId).toBe(a1);
    restart();
    expect(view().currentAction?.actionId).toBe(a1);
  });

  it("an Action added by hand joins the order at once, can be moved, and is followed", () => {
    const p = oldAiProject(["A", "B"]);
    const [a, b] = p.oldActions as [string, string];
    const planBefore = planRow(p.intentionId);
    const fresh = addAction(p.oldStageId, "NEW");

    expect(view().projects[0]?.unplannedActionIds).toEqual([]);
    expect(effectiveIds(p.intentionId)).toEqual([a, b, fresh]); // appended to its Stage
    expect(planRow(p.intentionId).ids).toEqual([a, b, fresh]);
    expect(planRow(p.intentionId).version).toBeGreaterThan(planBefore.version);
    expect(view().currentAction?.actionId).toBe(a);

    move(p.oldStageId, [fresh, a, b]);
    expect(view().currentAction?.actionId).toBe(fresh);
    complete(fresh);
    expect(view().currentAction?.actionId).toBe(a);
    // The AI's rationale is kept (not lost) behind the note that the owner took the order over.
    const rationale = view().projects[0]?.orderedActionPlan?.rationale ?? "";
    expect(rationale).toContain("владельцем вручную");
    expect(rationale).toContain("Порядок от ИИ");
  });

  it("reopening a finished Action puts it back into the order at its Stage position", () => {
    const p = oldAiProject(["A", "B"]);
    const [a, b] = p.oldActions as [string, string];
    complete(a);
    expect(view().currentAction?.actionId).toBe(b);
    unwrap(app.commands.reopenAction(ui(), { id: a, expectedVersion: versionOf(a) }));
    expect(view().projects[0]?.unplannedActionIds).toEqual([]);
    expect(effectiveIds(p.intentionId)).toEqual([a, b]);
    expect(view().currentAction?.actionId).toBe(a);
  });

  it("running timer + reorder: the session pauses on its own Action, `Сейчас` moves, nothing auto-starts", () => {
    const p = oldAiProject(["A", "B", "C"]);
    const [a, b, c] = p.oldActions as [string, string, string];
    unwrap(app.commands.startWork(ui(), { actionId: a }));
    advance(7);
    expect(runningCount()).toBe(1);

    // Moving something BELOW the running Action does not disturb it.
    move(p.oldStageId, [a, c, b]);
    expect(runningCount()).toBe(1);
    expect(view().currentAction?.actionId).toBe(a);

    // B above A: A is no longer the target.
    move(p.oldStageId, [b, a, c]);
    expect(runningCount()).toBe(0);
    expect(view().currentAction?.actionId).toBe(b);
    expect(view().execution).toMatchObject({ state: "idle", actionId: b });
    const rows = handle.sqlite.prepare("select action_id, ended_at from work_intervals").all() as {
      action_id: string;
      ended_at: string | null;
    }[];
    expect(rows).toHaveLength(1); // no timer was started for B
    expect(rows[0]?.action_id).toBe(a);
    expect(view().execution.todayWorkedMs).toBe(7 * MIN); // elapsed time stays attributed to A
  });

  it("a Stage moved up under a running timer pauses it; a hand-added Action behind it does not", () => {
    const p = routedProject("Проект T", { A: ["A1"], B: ["B1"] });
    const a1 = p.action.A1 as string;
    const b1 = p.action.B1 as string;
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(3);
    addAction(p.stage.A as string, "A2"); // appended after the running Action: still the target
    expect(runningCount()).toBe(1);
    moveStages(p.intentionId, [p.stage.B as string, p.stage.A as string]);
    expect(runningCount()).toBe(0);
    expect(view().currentAction?.actionId).toBe(b1);
    expect(view().execution.todayWorkedMs).toBe(3 * MIN);
  });

  it("projects stay independent: A's order and current Stage survive switching to B and back; B is untouched", () => {
    const a = routedProject("Проект A", { A1: ["A1-1", "A1-2"], A2: ["A2-1", "A2-2"] });
    const b = routedProject("Проект B", { B1: ["B1-1", "B1-2"] });
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.intentionId }));
    const bPlanBefore = planRow(b.intentionId);

    unwrap(app.commands.selectWorkProject(ui(), { intentionId: a.intentionId }));
    makeCurrent(a.intentionId, a.stage.A2 as string);
    move(a.stage.A2 as string, [a.action["A2-2"] as string, a.action["A2-1"] as string]);
    expect(view().currentAction?.actionId).toBe(a.action["A2-2"]);

    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.intentionId }));
    expect(view().currentAction).toMatchObject({ intentionId: b.intentionId, actionId: b.action["B1-1"] });
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: a.intentionId }));
    expect(view().currentAction).toMatchObject({ intentionId: a.intentionId, actionId: a.action["A2-2"] });
    restart();
    expect(view().currentAction?.actionId).toBe(a.action["A2-2"]);
    expect(planRow(b.intentionId)).toEqual(bPlanBefore); // owner ordering in A never mutated B
  });

  it("an AI proposal made before the owner's edit goes stale; her order stands until she confirms a new one", () => {
    const p = oldAiProject(["A", "B", "C"]);
    const [a, b, c] = p.oldActions as [string, string, string];
    const proposal = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: p.intentionId,
        expectedRevision: revision(),
        summary: "Сначала B",
        rationale: "Сначала B",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [b, a, c],
      }),
    );
    move(p.oldStageId, [c, a, b]);
    expect(view().currentAction?.actionId).toBe(c);
    expect(app.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({
      ok: false,
      error: { code: "STALE_PROPOSAL" },
    });
    expect(view().currentAction?.actionId).toBe(c);
  });
});

describe("review fixes (ADR-0010 §9.11)", () => {
  it("finishing the owner's Stage moves the stored pointer on: a later add/reopen in it never jumps her back or pauses work", () => {
    const p = routedProject("Проект R", { A: ["A1"], B: ["B1", "B2"] });
    const a1 = p.action.A1 as string;
    const b1 = p.action.B1 as string;
    complete(a1);
    expect(view().currentAction?.actionId).toBe(b1);
    // the pointer itself is on B (not only the badge), and it is B she can see as current
    expect(currentStageId(p.intentionId)).toBe(p.stage.B);
    expect(
      handle.sqlite.prepare("select id from stages where intention_id = ? and is_current = 1").all(p.intentionId),
    ).toEqual([{ id: p.stage.B }]);

    unwrap(app.commands.startWork(ui(), { actionId: b1 }));
    advance(2);
    addAction(p.stage.A as string, "A-forgotten"); // an edit in the finished Stage
    unwrap(app.commands.reopenAction(ui(), { id: a1, expectedVersion: versionOf(a1) }));
    expect(view().currentAction?.actionId).toBe(b1);
    expect(runningCount()).toBe(1);
  });

  it("a route proposal's preview order is exactly what acceptance applies (Stage order is the owner's)", () => {
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Проект V", desiredResult: "V" }));
    const stageA = addStage(intention.id, "A");
    const a1 = addAction(stageA, "a1");
    const stageB = addStage(intention.id, "B");
    const b1 = addAction(stageB, "b1");
    const b2 = addAction(stageB, "b2");
    const proposal = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: intention.id,
        expectedRevision: revision(),
        summary: "Порядок",
        rationale: "Порядок",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [b1, a1, b2], // interleaves Stages
      }),
    );
    if (proposal.kind !== "route" || !proposal.preview) throw new Error("preview");
    const shown = proposal.preview.order.map((o) => o.actionId);
    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
    expect(effectiveIds(intention.id)).toEqual(shown);
    expect(planRow(intention.id).ids).toEqual(shown);
    expect(view().currentAction?.actionId).toBe(shown[0]);
  });
});

describe("review fixes, second pass (ADR-0010 §9.11)", () => {
  it("finishing a Stage moves the pointer to the next Stage in HER order even if its work is blocked — never past it", () => {
    const p = routedProject("Проект W", { S1: ["a1"], S2: ["b1"], S3: ["c1", "c2"] });
    const a1 = p.action.a1 as string;
    const b1 = p.action.b1 as string;
    unwrap(app.commands.blockAction(ui(), { id: b1, expectedVersion: versionOf(b1), reason: "жду" }));
    complete(a1);
    // She stays in S2 (blocked-only): the honest empty state, not a silent jump to S3.
    expect(currentStageId(p.intentionId)).toBe(p.stage.S2);
    expect(view()).toMatchObject({ currentAction: null, emptyCurrentStage: { stageId: p.stage.S2 } });
    unwrap(app.commands.unblockAction(ui(), { id: b1, expectedVersion: versionOf(b1) }));
    expect(view().currentAction?.actionId).toBe(b1);
  });

  it("an empty placeholder Stage is skipped when the pointer moves on", () => {
    const p = routedProject("Проект E", { S1: ["a1"], S2: [], S3: ["c1"] });
    complete(p.action.a1 as string);
    expect(currentStageId(p.intentionId)).toBe(p.stage.S3);
    expect(view().currentAction?.actionId).toBe(p.action.c1);
  });
});
