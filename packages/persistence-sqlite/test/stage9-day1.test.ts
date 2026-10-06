// Stage 9, Day 1 (2026-10-05): the owner's first real day surfaced concrete friction. Each block below is
// the regression net for one repair, on a real SQLite file with a deterministic clock and time zone.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  backupsDir,
  createSqliteStore,
  databaseFile,
  EXPECTED_SCHEMA_VERSION,
  openDesktopDatabase,
  type SqliteHandle,
  uuidGenerator,
} from "../src";
import { MIGRATIONS } from "../src/migrations.generated";

const MIN = 60_000;
let home: string;
let handle: SqliteHandle;
let nowMs: number;
let zone: string;
let app: Application;

const makeApp = () =>
  createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: { now: () => new Date(nowMs).toISOString() },
    ids: uuidGenerator,
    timeZone: () => zone,
  });
/** Close the file and open it again — a real app restart (nothing runs in between). */
const restart = () => {
  handle.close();
  handle = openDesktopDatabase(databaseFile(home));
  app = makeApp();
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-day1-"));
  handle = openDesktopDatabase(databaseFile(home));
  zone = "Asia/Jakarta"; // the owner's zone, UTC+7
  nowMs = Date.parse("2026-10-05T02:00:00.000Z"); // Monday 09:00 local
  app = makeApp();
});
afterEach(() => {
  if (handle.sqlite.open) handle.close();
  rmSync(home, { recursive: true, force: true });
});

const at = (iso: string) => {
  nowMs = Date.parse(iso);
};
/** Time passing while the app runs: it checkpoints about once a minute, like the real one. */
const advance = (minutes: number) => {
  for (let left = minutes; left > 0; left -= 1) {
    nowMs += Math.min(1, left) * MIN;
    app.commands.heartbeatWork(app.newContext("system", "test"));
  }
};
function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ui = () => app.newContext("user-ui", "test");
const ai = () => app.newContext("mcp-ai", "test");
const sys = () => app.newContext("system", "test");
const view = () => unwrap(app.queries.getCurrentView());
const count = (sql: string, ...args: unknown[]) => (handle.sqlite.prepare(sql).get(...args) as { n: number }).n;
const runningCount = () => count("select count(*) n from work_intervals where ended_at is null");
const revision = () => unwrap(app.queries.getStateRevision()).stateRevision;

/** A project whose route and order the owner accepted from an AI proposal: actions in the given order. */
function project(title: string, actionTitles: string[]): { id: string; actions: string[] } {
  const intention = unwrap(app.commands.createIntention(ui(), { title, desiredResult: `${title} готов` }));
  const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: `${title}: этап` }));
  const actions = actionTitles.map(
    (t) => unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: t, doneWhen: `${t} готово` })).id,
  );
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
      actionOrder: actions,
    }),
  );
  unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
  return { id: intention.id, actions };
}
const versionOf = (actionId: string) => {
  const action = view()
    .projects.flatMap((p) => p.stages.flatMap((s) => s.actions))
    .find((a) => a.id === actionId);
  if (!action) throw new Error("action not in view");
  return action.version;
};
const complete = (actionId: string) =>
  unwrap(app.commands.completeAction(ui(), { id: actionId, expectedVersion: versionOf(actionId) }));
const strategicOrder = () => ({
  positions: handle.sqlite.prepare("select id, position, version from intentions order by id").all(),
  plans: handle.sqlite
    .prepare("select intention_id, version, ordered_action_ids from ordered_action_plans order by intention_id")
    .all(),
});

// ─── 2. Manual project switching ─────────────────────────────────────────────────────────────────

describe("Day 1 · the owner switches between active projects", () => {
  it("A → B: `Сейчас` follows B's own order, survives reload and restart, and keeps advancing inside B", () => {
    const a = project("Контент", ["Тема", "Сценарий"]);
    const b = project("Продукт", ["Идеи", "Оффер", "Цена"]);
    expect(view().currentAction?.actionId).toBe(a.actions[0]); // the owner's project order: A first
    const before = strategicOrder();

    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.id }));
    expect(view()).toMatchObject({
      selectedProjectId: b.id,
      currentAction: { actionId: b.actions[0], intentionId: b.id },
    });
    expect(view().intention?.id).toBe(b.id);

    app = makeApp(); // a normal renderer reload re-reads the same state
    expect(view().currentAction?.actionId).toBe(b.actions[0]);
    restart(); // and an app restart
    expect(view().currentAction?.actionId).toBe(b.actions[0]);

    complete(b.actions[0] as string);
    expect(view().currentAction?.actionId).toBe(b.actions[1]); // no jump back to A after a completion
    complete(b.actions[1] as string);
    expect(view().currentAction?.actionId).toBe(b.actions[2]);

    // Not a strategic reorder: project positions untouched, B's plan only lost its finished actions.
    const after = strategicOrder();
    expect(after.positions).toEqual(before.positions);
    expect(after.plans).toEqual(before.plans);
  });

  it("switching while A's timer runs pauses A, starts nothing on B, and never merges time across projects", () => {
    const a = project("Контент", ["Тема", "Сценарий"]);
    const b = project("Продукт", ["Идеи"]);
    unwrap(app.commands.startWork(ui(), { actionId: a.actions[0] as string }));
    advance(20);
    expect(runningCount()).toBe(1);

    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.id }));
    expect(runningCount()).toBe(0); // A paused, B NOT started
    expect(view().execution).toMatchObject({ state: "idle", actionId: b.actions[0], actionWorkedMs: 0 });
    expect(view().execution.todayWorkedMs).toBe(20 * MIN);
    const aRows = handle.sqlite.prepare("select action_id, started_at, ended_at from work_intervals").all() as {
      action_id: string;
      ended_at: string | null;
    }[];
    expect(aRows).toHaveLength(1);
    expect(aRows[0]).toMatchObject({ action_id: a.actions[0], ended_at: new Date(nowMs).toISOString() });

    advance(3); // the owner reads the card; nothing is counted
    unwrap(app.commands.startWork(ui(), { actionId: b.actions[0] as string })); // she presses «Начать» herself
    advance(10);
    // Back to A: B pauses, A continues from its own correct Action with its own time.
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: a.id }));
    expect(runningCount()).toBe(0);
    expect(view().execution).toMatchObject({ state: "paused", actionId: a.actions[0], actionWorkedMs: 20 * MIN });
    expect(view().execution.weekWorkedMs).toBe(30 * MIN);
    const byAction = handle.sqlite
      .prepare("select action_id, count(*) n from work_intervals group by action_id order by action_id")
      .all() as { action_id: string; n: number }[];
    expect(Object.fromEntries(byAction.map((r) => [r.action_id, r.n]))).toEqual({
      [a.actions[0] as string]: 1,
      [b.actions[0] as string]: 1,
    });
    expect(unwrap(app.queries.listChangeHistory({ limit: 10 })).map((e) => e.commandType)).toContain("work.pause");
  });

  it("a paused/stopped timer is left alone: switching only switches", () => {
    const a = project("Контент", ["Тема"]);
    const b = project("Продукт", ["Идеи"]);
    unwrap(app.commands.startWork(ui(), { actionId: a.actions[0] as string }));
    advance(5);
    unwrap(app.commands.pauseWork(ui(), { actionId: a.actions[0] as string }));
    const pausesBefore = count("select count(*) n from change_log where command_type = 'work.pause'");
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.id }));
    expect(count("select count(*) n from change_log where command_type = 'work.pause'")).toBe(pausesBefore);
    expect(view().currentAction?.actionId).toBe(b.actions[0]);
  });

  it("an AI proposal waiting for the owner does not go stale because she switched projects", () => {
    const a = project("Контент", ["Тема"]);
    const b = project("Продукт", ["Идеи", "Оффер"]);
    const pending = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: b.id,
        expectedRevision: revision(),
        summary: "Сначала оффер",
        rationale: "Сначала оффер",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [b.actions[1] as string, b.actions[0] as string],
      }),
    );
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.id }));
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: a.id }));
    expect(unwrap(app.queries.getProposal({ id: pending.id })).status).toBe("pending");
  });

  it("deterministic fallback when the chosen project is no longer usable", () => {
    const a = project("Контент", ["Тема"]);
    const b = project("Продукт", ["Идеи"]);
    unwrap(app.commands.selectWorkProject(ui(), { intentionId: b.id }));

    // Nothing usable in B's current Stage right now (its only action blocked): the owner stays in B and is told
    // so — A's work is not silently put in front of her (Stage 9 current-Stage hotfix).
    unwrap(
      app.commands.blockAction(ui(), {
        id: b.actions[0] as string,
        expectedVersion: versionOf(b.actions[0] as string),
        reason: "ждёт ответа",
      }),
    );
    expect(view()).toMatchObject({
      selectedProjectId: b.id,
      currentAction: null,
      needsAiReplan: false,
      emptyCurrentStage: { intentionId: b.id },
    });
    unwrap(
      app.commands.unblockAction(ui(), {
        id: b.actions[0] as string,
        expectedVersion: versionOf(b.actions[0] as string),
      }),
    );
    expect(view().currentAction?.actionId).toBe(b.actions[0]); // the owner's choice still stands

    // B leaves the active state: the choice is cleared, A leads.
    const bIntention = view().projects.find((p) => p.intention.id === b.id)?.intention;
    unwrap(
      app.commands.changeIntentionStatus(ui(), { id: b.id, expectedVersion: bIntention?.version ?? 0, to: "deferred" }),
    );
    expect(handle.sqlite.prepare("select selected_intention_id s from settings").get()).toEqual({ s: null });
    expect(view()).toMatchObject({ selectedProjectId: null, currentAction: { actionId: a.actions[0] } });

    // A paused project cannot be chosen; nor one with nothing admissible.
    expect(app.commands.selectWorkProject(ui(), { intentionId: b.id })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    const c = project("Пусто", ["Одно"]);
    complete(c.actions[0] as string);
    expect(app.commands.selectWorkProject(ui(), { intentionId: c.id })).toMatchObject({
      ok: false,
      error: { code: "NEEDS_AI_REPLAN" },
    });

    // No active project at all: the normal empty state, nothing invented.
    for (const id of [a.id, c.id]) {
      const v = view().projects.find((p) => p.intention.id === id)?.intention;
      unwrap(app.commands.changeIntentionStatus(ui(), { id, expectedVersion: v?.version ?? 0, to: "deferred" }));
    }
    expect(view()).toMatchObject({ selectedProjectId: null, currentAction: null, needsAiReplan: false });
  });

  it("the AI cannot choose the owner's work project", () => {
    const b = project("Продукт", ["Идеи"]);
    expect(app.commands.selectWorkProject(ai(), { intentionId: b.id })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
});

// ─── 4. «За неделю» = the current LOCAL calendar week, Monday 00:00 → now ─────────────────────────

describe("Day 1 · «За неделю» resets at local Monday 00:00 without any background job", () => {
  /** A finished work session [from, from+minutes) on the current Action, recorded like the real app does. */
  function session(actionId: string, fromIso: string, minutes: number) {
    at(fromIso);
    unwrap(app.commands.startWork(ui(), { actionId }));
    advance(minutes);
    unwrap(app.commands.pauseWork(ui(), { actionId }));
  }

  it("A/D: a Sunday session is not counted just after Monday 00:00 local — while UTC is still Sunday", () => {
    const p = project("Контент", ["Тема"]);
    session(p.actions[0] as string, "2026-10-04T13:00:00.000Z", 60); // Sunday 20:00–21:00 Jakarta
    at("2026-10-04T16:59:00.000Z"); // Sunday 23:59 local
    expect(view().execution).toMatchObject({ todayWorkedMs: 60 * MIN, weekWorkedMs: 60 * MIN });
    at("2026-10-04T17:00:00.000Z"); // Monday 00:00 local (UTC date: still Sunday)
    expect(view().execution).toMatchObject({ todayWorkedMs: 0, weekWorkedMs: 0 });
    at("2026-10-04T17:01:00.000Z"); // Monday 00:01 local
    expect(view().execution).toMatchObject({ todayWorkedMs: 0, weekWorkedMs: 0, actionWorkedMs: 60 * MIN });
  });

  it("B/E: Monday sessions count, and the week total is exactly the sum of this week's sessions", () => {
    const p = project("Контент", ["Тема"]);
    const id = p.actions[0] as string;
    session(id, "2026-10-04T13:00:00.000Z", 60); // Sunday — last week
    session(id, "2026-10-04T17:10:00.000Z", 25); // Monday 00:10 local
    session(id, "2026-10-05T03:00:00.000Z", 35); // Monday 10:00 local
    at("2026-10-05T10:00:00.000Z");
    expect(view().execution).toMatchObject({
      todayWorkedMs: 60 * MIN,
      weekWorkedMs: 60 * MIN,
      actionWorkedMs: 120 * MIN,
    });
  });

  it("C: the app was closed across the boundary — reopened on Monday afternoon it shows only this week", () => {
    const p = project("Контент", ["Тема"]);
    session(p.actions[0] as string, "2026-10-04T13:00:00.000Z", 60);
    const rev = revision();
    restart(); // closed Sunday night…
    at("2026-10-05T08:00:00.000Z"); // …reopened Monday 15:00 local
    expect(view().execution).toMatchObject({ todayWorkedMs: 0, weekWorkedMs: 0 });
    expect(revision()).toBe(rev); // nothing was "reset": no write at all
    expect(count("select count(*) n from work_intervals")).toBe(1); // history untouched
  });

  it("a session spanning Sunday → Monday counts only its Monday part this week", () => {
    const p = project("Контент", ["Тема"]);
    session(p.actions[0] as string, "2026-10-04T16:30:00.000Z", 60); // Sunday 23:30 → Monday 00:30 local
    at("2026-10-04T18:00:00.000Z"); // Monday 01:00 local
    expect(view().execution).toMatchObject({
      todayWorkedMs: 30 * MIN,
      weekWorkedMs: 30 * MIN,
      actionWorkedMs: 60 * MIN,
    });
  });

  it("D: a negative UTC offset — a Sunday-evening session already on Monday in UTC is still last week", () => {
    zone = "America/Los_Angeles"; // UTC−7 in October
    app = makeApp();
    const p = project("Контент", ["Тема"]);
    session(p.actions[0] as string, "2026-10-05T05:00:00.000Z", 60); // Sunday 22:00–23:00 local (Monday in UTC)
    at("2026-10-05T07:01:00.000Z"); // Monday 00:01 local
    expect(view().execution).toMatchObject({ todayWorkedMs: 0, weekWorkedMs: 0 });
  });
});

// ─── 6. Owner-approved plan replacement ──────────────────────────────────────────────────────────

describe("Day 1 · an owner-approved plan replaces a generated one without losing history", () => {
  function generated() {
    const p = project("Контент", ["A1", "A2", "A3"]);
    const [a1, a2, a3] = p.actions as [string, string, string];
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(15);
    complete(a1); // completed WITH a WorkSession
    return { id: p.id, a1, a2, a3 };
  }
  const approved = (intentionId: string) => ({
    intentionId,
    rationale: "План утверждён владельцем вместе с продуктовым партнёром",
    stages: [
      {
        title: "X",
        actions: [
          { title: "X1", doneWhen: "x1" },
          { title: "X2", doneWhen: "x2" },
        ],
      },
      { title: "Y", actions: [{ title: "Y1", doneWhen: "y1" }] },
    ],
  });

  /** The owner's path: dry run, then apply exactly that dry run. */
  const applyApproved = (plan: ReturnType<typeof approved>) =>
    app.commands.replaceProjectPlan(ui(), {
      ...plan,
      expectedFingerprint: unwrap(app.queries.previewProjectPlanReplacement(plan)).fingerprint,
    });

  it("keeps the project, its Season link and all evidence; only the approved unfinished path drives `Сейчас`", () => {
    const { id, a1, a2, a3 } = generated();
    const seasonBefore = handle.sqlite.prepare("select * from season").all();
    const intentionBefore = handle.sqlite.prepare("select * from intentions where id = ?").get(id);
    const pending = unwrap(
      app.commands.createRouteProposal(ai(), {
        intentionId: id,
        expectedRevision: revision(),
        summary: "Сначала A3",
        rationale: "Сначала A3",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [a3, a2],
      }),
    );

    // Dry run first: nothing written.
    const rev = revision();
    const preview = unwrap(app.queries.previewProjectPlanReplacement(approved(id)));
    expect(preview).toMatchObject({
      projectTitle: "Контент",
      archivedStages: [{ title: "Контент: этап" }],
      keptDoneActions: 1,
      firstAction: { title: "X1" },
    });
    expect(preview.leftBehindActions.map((x) => x.title)).toEqual(["A2", "A3"]);
    expect(revision()).toBe(rev);

    const applied = unwrap(
      app.commands.replaceProjectPlan(ui(), { ...approved(id), expectedFingerprint: preview.fingerprint }),
    );
    expect(applied.stages.map((s) => [s.title, s.actions.map((a) => a.title)])).toEqual([
      ["X", ["X1", "X2"]],
      ["Y", ["Y1"]],
    ]);

    // Same project, same Season, same strategic fields.
    expect(handle.sqlite.prepare("select * from intentions where id = ?").get(id)).toEqual(intentionBefore);
    expect(handle.sqlite.prepare("select * from season").all()).toEqual(seasonBefore);
    // History: A1 still done with its WorkSession; A2/A3 rows kept, inactive; old Stage archived, not deleted.
    expect(
      handle.sqlite.prepare("select status, completed_at is not null c from actions where id = ?").get(a1),
    ).toEqual({
      status: "done",
      c: 1,
    });
    expect(count("select count(*) n from work_intervals where action_id = ?", a1)).toBe(1);
    expect(count("select count(*) n from actions where id in (?, ?) and status = 'open'", a2, a3)).toBe(2);
    expect(count("select count(*) n from stages where intention_id = ? and archived_at is not null", id)).toBe(1);
    expect(view().execution.todayWorkedMs).toBe(15 * MIN);

    // The new plan is canonical: one plan row, exactly the approved order, `Сейчас` = X1.
    const project_ = view().projects.find((p) => p.intention.id === id);
    const titleOf = (actionId: string) =>
      project_?.stages.flatMap((s) => s.actions).find((a) => a.id === actionId)?.title;
    expect(count("select count(*) n from ordered_action_plans where intention_id = ?", id)).toBe(1);
    expect(project_?.orderedActionPlan?.orderedActionIds.map(titleOf)).toEqual(["X1", "X2", "Y1"]);
    expect(project_?.stages.map((s) => s.title)).toEqual(["X", "Y"]);
    expect(project_?.unplannedActionIds).toEqual([]);
    expect(project_?.progress).toEqual({ stageIndex: 1, stageCount: 2, actionsDone: 0, actionsTotal: 3 });
    expect(titleOf(view().currentAction?.actionId ?? "")).toBe("X1");

    // The old path is out of reach of every command and of the AI.
    expect(unwrap(app.queries.getProposal({ id: pending.id })).status).toBe("stale");
    expect(app.commands.completeAction(ui(), { id: a2, expectedVersion: 1 })).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      app.commands.createRouteProposal(ai(), {
        intentionId: id,
        expectedRevision: revision(),
        summary: "Вернуть A2",
        rationale: "Вернуть A2",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [a2],
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(unwrap(app.queries.listChangeHistory({ limit: 5 })).map((e) => e.commandType)).toContain("plan.replace");
  });

  it("an existing action can be carried into the approved plan with its history; running work on the project pauses", () => {
    const { id, a1, a2 } = generated();
    unwrap(app.commands.startWork(ui(), { actionId: a2 }));
    advance(5);
    const plan = approved(id);
    plan.stages[0]?.actions.unshift({
      title: "игнорируется для завершённого",
      doneWhen: "",
      existingActionId: a1,
    } as never);
    plan.stages[1]?.actions.push({ title: "A2 по-новому", doneWhen: "a2", existingActionId: a2 } as never);
    unwrap(applyApproved(plan));

    expect(runningCount()).toBe(0); // paused, not deleted
    expect(count("select count(*) n from work_intervals where action_id = ?", a2)).toBe(1);
    const p = view().projects.find((x) => x.intention.id === id);
    const actions = p?.stages.flatMap((s) => s.actions.map((a) => [s.title, a.title, a.status]));
    expect(actions).toEqual([
      ["X", "A1", "done"], // finished work keeps its words
      ["X", "X1", "open"],
      ["X", "X2", "open"],
      ["Y", "Y1", "open"],
      ["Y", "A2 по-новому", "open"],
    ]);
    expect(p?.progress).toMatchObject({ actionsDone: 1, actionsTotal: 5 });
    expect(view().execution.todayWorkedMs).toBe(20 * MIN);
  });

  it("only the owner (or the system) may apply it — never the AI, and an invalid plan changes nothing", () => {
    const { id } = generated();
    const rev = revision();
    const fingerprint = unwrap(app.queries.previewProjectPlanReplacement(approved(id))).fingerprint;
    expect(app.commands.replaceProjectPlan(ai(), { ...approved(id), expectedFingerprint: fingerprint })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(
      app.commands.replaceProjectPlan(ui(), {
        ...approved(id),
        stages: [{ title: "Пусто", actions: [] }],
        expectedFingerprint: fingerprint,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(revision()).toBe(rev);
    expect(count("select count(*) n from stages where archived_at is not null")).toBe(0);
  });

  it("is applied only against the dry run the owner saw: a change in between (or another file) applies nothing", () => {
    const { id, a2 } = generated();
    const seen = unwrap(app.queries.previewProjectPlanReplacement(approved(id)));
    expect(seen.leftBehindActions.map((a) => a.title)).toEqual(["A2", "A3"]);
    // In between, the owner adds an action in the app — it would silently leave the route.
    const stageId = view().projects.find((p) => p.intention.id === id)?.stages[0]?.id as string;
    unwrap(app.commands.addAction(ui(), { stageId, title: "Новое важное", doneWhen: "" }));
    const rev = revision();
    expect(
      app.commands.replaceProjectPlan(ui(), { ...approved(id), expectedFingerprint: seen.fingerprint }),
    ).toMatchObject({
      ok: false,
      error: { code: "REQUIRES_CONFIRMATION" },
    });
    // A different file than the one previewed is refused too.
    const fresh = unwrap(app.queries.previewProjectPlanReplacement(approved(id))).fingerprint;
    const other = { ...approved(id), rationale: "другой файл" };
    expect(app.commands.replaceProjectPlan(ui(), { ...other, expectedFingerprint: fresh })).toMatchObject({
      error: { code: "REQUIRES_CONFIRMATION" },
    });
    expect(revision()).toBe(rev);
    expect(count("select count(*) n from stages where archived_at is not null")).toBe(0);
    expect(
      unwrap(app.queries.previewProjectPlanReplacement(approved(id))).leftBehindActions.map((a) => a.title),
    ).toEqual(["A2", "A3", "Новое важное"]);
    expect(a2).toBeTruthy();
  });
});

// ─── 8. «Быт» ────────────────────────────────────────────────────────────────────────────────────

describe("Day 1 · «Быт» is a side pocket, isolated from project work", () => {
  it("direct add → active; done → leaves the active list and stays as minimal history", () => {
    const item = unwrap(app.commands.addHouseholdItem(ui(), { text: "  отвезти байк в ремонт " }));
    expect(unwrap(app.queries.listHouseholdItems())).toMatchObject({
      active: [{ id: item.id, text: "отвезти байк в ремонт", status: "active", sourceCaptureId: null }],
      recentlyDone: [],
    });
    at("2026-10-05T05:00:00.000Z");
    unwrap(app.commands.completeHouseholdItem(ui(), { id: item.id }));
    expect(unwrap(app.queries.listHouseholdItems())).toMatchObject({
      active: [],
      recentlyDone: [{ id: item.id, status: "done", completedAt: "2026-10-05T05:00:00.000Z" }],
    });
    expect(app.commands.completeHouseholdItem(ui(), { id: item.id })).toMatchObject({
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("never becomes an Action, never touches `Сейчас`, order, timer, totals or the three project slots", () => {
    const p = project("Контент", ["Тема"]);
    unwrap(app.commands.startWork(ui(), { actionId: p.actions[0] as string }));
    advance(10);
    const before = view();
    const actionsBefore = count("select count(*) n from actions");
    for (const text of ["записаться к врачу", "позвонить маме", "проверить визу", "забрать посылку"]) {
      unwrap(app.commands.addHouseholdItem(ui(), { text }));
    }
    const id = unwrap(app.queries.listHouseholdItems()).active[0]?.id as string;
    unwrap(app.commands.completeHouseholdItem(ui(), { id }));
    const after = view();
    expect(count("select count(*) n from actions")).toBe(actionsBefore);
    expect(after.currentAction).toEqual(before.currentAction);
    expect(after.projects).toEqual(before.projects);
    expect(after.projectSlots).toEqual(before.projectSlots);
    expect(after.execution).toEqual(before.execution);
    expect(count("select count(*) n from work_intervals")).toBe(1);
    // …and never reaches the AI's planning context.
    expect(JSON.stringify(unwrap(app.queries.getPlanningContext()))).not.toContain("позвонить маме");
  });

  it("from «+»: the AI only suggests, the owner adds it once, and the original record stays as typed", () => {
    const capture = unwrap(app.commands.createCapture(ui(), { rawText: "надо бы записаться к стоматологу" }));
    unwrap(app.commands.claimNextCapture(sys()));
    unwrap(
      app.commands.finishCapture(sys(), {
        id: capture.id,
        outcome: {
          ok: true,
          result: {
            kind: "household",
            reply: "Похоже на дело для «Быта».",
            proposalId: null,
            householdText: "Записаться к стоматологу",
          },
        },
      }),
    );
    expect(count("select count(*) n from household_items")).toBe(0); // a suggestion, not a write
    const [processed] = unwrap(app.queries.listCaptures({ limit: 1 }));
    expect(processed).toMatchObject({
      result: { kind: "household", householdText: "Записаться к стоматологу" },
      householdItemId: null,
    });

    expect(
      app.commands.addHouseholdItem(ai(), { text: "Записаться к стоматологу", sourceCaptureId: capture.id }),
    ).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    const item = unwrap(
      app.commands.addHouseholdItem(ui(), { text: "Записаться к стоматологу", sourceCaptureId: capture.id }),
    );
    expect(unwrap(app.queries.listCaptures({ limit: 1 }))[0]).toMatchObject({
      rawText: "надо бы записаться к стоматологу",
      householdItemId: item.id,
    });
    expect(
      app.commands.addHouseholdItem(ui(), { text: "Записаться к стоматологу", sourceCaptureId: capture.id }),
    ).toMatchObject({ error: { code: "CONFLICT_RELOAD" } });
    expect(count("select count(*) n from household_items")).toBe(1);
  });

  it("a stray householdText on another kind is dropped, never turns a good answer into a failure", () => {
    const capture = unwrap(app.commands.createCapture(ui(), { rawText: "позвонить маме; запомни: утром не звоню" }));
    unwrap(app.commands.claimNextCapture(sys()));
    unwrap(
      app.commands.finishCapture(sys(), {
        id: capture.id,
        outcome: {
          ok: true,
          result: { kind: "answer", reply: "Хорошо.", proposalId: null, householdText: "Позвонить маме" },
        },
      }),
    );
    expect(unwrap(app.queries.listCaptures({ limit: 1 }))[0]).toMatchObject({
      state: "processed",
      result: { kind: "answer", reply: "Хорошо." },
    });
    expect(unwrap(app.queries.listCaptures({ limit: 1 }))[0]?.result).not.toHaveProperty("householdText");
  });

  it("an AI «household» answer without the errand text is malformed — the Capture waits, nothing is created", () => {
    const capture = unwrap(app.commands.createCapture(ui(), { rawText: "что-то" }));
    unwrap(app.commands.claimNextCapture(sys()));
    unwrap(
      app.commands.finishCapture(sys(), {
        id: capture.id,
        outcome: { ok: true, result: { kind: "household", reply: "Да", proposalId: null } as never },
      }),
    );
    expect(unwrap(app.queries.listCaptures({ limit: 1 }))[0]).toMatchObject({
      state: "failed",
      lastError: "malformed",
    });
  });
});

// ─── Migration 0019 on the owner's real schema ───────────────────────────────────────────────────

describe("migration 0019 from the real schema v19 (Stage 9 Day 1)", () => {
  it("is additive: backs up first, keeps every row, adds an empty choice, no archived stages and an empty «Быт»", () => {
    handle.close();
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "living-map-day1-mig-"));
    const file = databaseFile(home);
    const legacy = new Database(file);
    legacy.pragma("journal_mode = WAL");
    applyMigrations(legacy, MIGRATIONS.slice(0, 19));
    const T = "2026-10-05T11:58:41.407Z";
    legacy.exec(`
      INSERT INTO intentions (id, title, desired_result, why_it_matters, status, position, closed_at, version, created_at, updated_at) VALUES ('i1','Контент','12 недель','', 'active', 1, NULL, 1,'${T}','${T}');
      INSERT INTO stages (id, intention_id, title, position, is_current, version, created_at, updated_at) VALUES ('s1','i1','Неделя 1',1,1,1,'${T}','${T}');
      INSERT INTO actions (id, stage_id, title, done_when, position, status, version, created_at, updated_at) VALUES ('a1','s1','Тема','',1,'open',1,'${T}','${T}');
      INSERT INTO work_intervals (id, action_id, started_at, ended_at, last_heartbeat_at, time_zone) VALUES ('w1','a1','${T}','2026-10-05T12:00:00.000Z','${T}','Asia/Jakarta');
      UPDATE meta SET state_revision = 205;
    `);
    const snapshot = (db: Database.Database) =>
      ["intentions", "actions", "work_intervals", "meta"].map((t) => db.prepare(`select * from ${t}`).all());
    const before = snapshot(legacy);
    const stagesBefore = legacy.prepare("select * from stages").all();
    legacy.close();

    handle = openDesktopDatabase(file);
    expect(handle.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(EXPECTED_SCHEMA_VERSION).toBe(20);
    expect(readdirSync(backupsDir(home)).some((f) => f.includes("schema-v19"))).toBe(true);
    expect(handle.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(snapshot(handle.sqlite)).toEqual(before);
    expect(handle.sqlite.prepare("select * from stages").all()).toEqual(
      (stagesBefore as object[]).map((s) => ({ ...s, archived_at: null })),
    );
    expect(
      handle.sqlite.prepare("select selected_intention_id s, daily_work_target_minutes m from settings").get(),
    ).toEqual({
      s: null,
      m: 360,
    });
    expect(count("select count(*) n from household_items")).toBe(0);

    app = makeApp();
    expect(view()).toMatchObject({ selectedProjectId: null, intention: { id: "i1" } });
  });
});
