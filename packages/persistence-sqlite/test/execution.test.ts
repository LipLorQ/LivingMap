import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, createApplication } from "@living-map/application";
import type { CalendarSnapshotDto, Result } from "@living-map/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSqliteStore,
  databaseFile,
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

const at = (iso: string) => {
  nowMs = Date.parse(iso);
};
/** Time passing while the desktop app runs: it checkpoints about once a minute, like the real one. */
const advance = (minutes: number) => {
  for (let left = minutes; left > 0; left -= 1) {
    nowMs += Math.min(1, left) * MIN;
    app.commands.heartbeatWork(app.newContext("system", "test"));
  }
};
/** Time passing with the app asleep / frozen / killed: no checkpoints at all. */
const silence = (minutes: number) => {
  nowMs += minutes * MIN;
};

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ui = () => app.newContext("user-ui", "test");
const sys = () => app.newContext("system", "test");
const view = () => unwrap(app.queries.getCurrentView());
const exec = () => view().execution;
const history = () => unwrap(app.queries.listChangeHistory({ limit: 50 })).map((e) => e.commandType);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-exec-"));
  handle = openDesktopDatabase(databaseFile(home));
  at("2026-09-28T06:00:00.000Z"); // 09:00 Moscow, Monday
  zone = "Europe/Moscow";
  app = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: { now: () => new Date(nowMs).toISOString() },
    ids: uuidGenerator,
    timeZone: () => zone,
  });
});
afterEach(() => {
  if (handle.sqlite.open) handle.close();
  rmSync(home, { recursive: true, force: true });
});

/** Intention with three Actions ordered a1 → a2 → a3 through a real, user-accepted route proposal. */
function seed(): { a1: string; a2: string; a3: string } {
  const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
  const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Build" }));
  const add = (title: string) => unwrap(app.commands.addAction(ui(), { stageId: stage.id, title, doneWhen: "" })).id;
  const [a1, a2, a3] = [add("One"), add("Two"), add("Three")] as [string, string, string];
  const proposal = unwrap(
    app.commands.createRouteProposal(app.newContext("mcp-ai", "test"), {
      intentionId: intention.id,
      expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
      summary: "Order",
      rationale: "Order",
      newStages: [],
      stageEdits: [],
      newActions: [],
      actionEdits: [],
      actionOrder: [a1, a2, a3],
    }),
  );
  unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
  return { a1, a2, a3 };
}
const versionOf = (id: string) => {
  const action = view()
    .stages.flatMap((s) => s.actions)
    .find((a) => a.id === id);
  if (!action) throw new Error("no action");
  return action.version;
};
const complete = (id: string) => app.commands.completeAction(ui(), { id, expectedVersion: versionOf(id) });

describe("Stage 5 execution", () => {
  it("idle → Start → running; the timer counts only while running; Pause freezes it", () => {
    const { a1 } = seed();
    expect(exec()).toMatchObject({ state: "idle", actionId: a1, actionWorkedMs: 0, dailyWorkTargetMinutes: 360 });
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(15);
    expect(exec()).toMatchObject({ state: "running", actionWorkedMs: 15 * MIN, todayWorkedMs: 15 * MIN });
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    advance(30);
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 15 * MIN, todayWorkedMs: 15 * MIN });
  });

  it("duplicate Start, repeated Pause and Start on a non-current Action are rejected without extra rows", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    expect(app.commands.startWork(ui(), { actionId: a1 })).toMatchObject({ error: { code: "CONFLICT_RELOAD" } });
    expect(app.commands.startWork(ui(), { actionId: a2 })).toMatchObject({ error: { code: "CONFLICT_RELOAD" } });
    advance(5);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(app.commands.pauseWork(ui(), { actionId: a1 })).toMatchObject({ error: { code: "CONFLICT_RELOAD" } });
    expect(app.commands.startWork(ui(), { actionId: a2 })).toMatchObject({ error: { code: "CONFLICT_RELOAD" } });
    const rows = handle.sqlite.prepare("select count(*) n from work_intervals").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("the database itself refuses a second running interval", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    const insert = () =>
      handle.sqlite
        .prepare(
          "insert into work_intervals (id, action_id, started_at, ended_at, last_heartbeat_at, time_zone) values ('x', ?, 's', null, 's', 'UTC')",
        )
        .run(a2);
    expect(insert).toThrow(/UNIQUE/);
  });

  it("Resume keeps the total: 20 min morning + 35 min evening = 55 min, across a restart", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(20);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    at("2026-09-28T15:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(35);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(exec().actionWorkedMs).toBe(55 * MIN);
    expect(history()).toEqual(expect.arrayContaining(["work.start", "work.pause", "work.resume"]));
    // Restart: reopen the same file.
    handle.close();
    handle = openDesktopDatabase(databaseFile(home));
    app = createApplication({
      store: createSqliteStore(handle, uuidGenerator),
      clock: { now: () => new Date(nowMs).toISOString() },
      ids: uuidGenerator,
      timeZone: () => zone,
    });
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 55 * MIN });
  });

  it("an Action spanning days keeps its total; today and week only count their own days", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(60);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    at("2026-09-29T06:00:00.000Z"); // Tuesday
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(30);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(exec()).toMatchObject({ actionWorkedMs: 90 * MIN, todayWorkedMs: 30 * MIN, weekWorkedMs: 90 * MIN });
    at("2026-10-05T06:00:00.000Z"); // next Monday
    expect(exec()).toMatchObject({ actionWorkedMs: 90 * MIN, todayWorkedMs: 0, weekWorkedMs: 0 });
  });

  it("daily/weekly totals sum across Actions; the Action timer does not", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(40);
    unwrap(complete(a1));
    unwrap(app.commands.startWork(ui(), { actionId: a2 }));
    advance(20);
    expect(exec()).toMatchObject({
      actionId: a2,
      actionWorkedMs: 20 * MIN,
      todayWorkedMs: 60 * MIN,
      weekWorkedMs: 60 * MIN,
    });
  });

  it("local midnight: 00:30 Moscow work counts to the new local day, not the previous UTC day", () => {
    const { a1 } = seed();
    at("2026-09-28T20:30:00.000Z"); // 23:30 Moscow Monday
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(75); // 00:45 Moscow Tuesday (still Monday in UTC)
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(exec()).toMatchObject({ todayWorkedMs: 45 * MIN, weekWorkedMs: 75 * MIN, actionWorkedMs: 75 * MIN });
    // Travelling later does not move history to another date.
    zone = "America/New_York";
    at("2026-09-29T14:00:00.000Z"); // Tuesday in New York too
    expect(exec().todayWorkedMs).toBe(45 * MIN);
  });

  it("calendar events never count as work", () => {
    const { a1 } = seed();
    const snapshot: CalendarSnapshotDto = {
      connected: true,
      syncedAt: new Date(nowMs).toISOString(),
      source: "ical",
      timeZone: "UTC",
      events: [
        {
          id: "e",
          title: "Обед",
          start: "2026-09-28T07:00:00.000Z",
          end: "2026-09-28T08:00:00.000Z",
          timeZone: "UTC",
          allDay: false,
        },
      ],
      lastError: null,
    };
    unwrap(app.commands.saveCalendarSnapshot(sys(), snapshot));
    at("2026-09-28T12:00:00.000Z");
    expect(exec()).toMatchObject({ state: "idle", actionId: a1, todayWorkedMs: 0, weekWorkedMs: 0 });
  });

  it("daily target is a persisted, editable setting that never changes recorded time", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(10);
    const after = unwrap(app.commands.setDailyWorkTarget(ui(), { minutes: 300 }));
    expect(after).toMatchObject({ dailyWorkTargetMinutes: 300, todayWorkedMs: 10 * MIN });
    expect(exec().dailyWorkTargetMinutes).toBe(300);
    expect(app.commands.setDailyWorkTarget(app.newContext("mcp-ai", "test"), { minutes: 60 })).toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("Complete from paused keeps the work and moves Сейчас to the next Action", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(10);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    unwrap(complete(a1));
    expect(view().currentAction?.actionId).toBe(a2);
    expect(exec()).toMatchObject({ state: "idle", actionId: a2, actionWorkedMs: 0, todayWorkedMs: 10 * MIN });
  });

  it("Complete while running is ONE command: interval closed, Action done, one revision, next Сейчас", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(25);
    const before = unwrap(app.queries.getStateRevision()).stateRevision;
    unwrap(complete(a1));
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(before + 1);
    const running = handle.sqlite.prepare("select count(*) n from work_intervals where ended_at is null").get() as {
      n: number;
    };
    expect(running.n).toBe(0);
    expect(view().currentAction?.actionId).toBe(a2);
    expect(exec().todayWorkedMs).toBe(25 * MIN);
    advance(60);
    expect(exec().todayWorkedMs).toBe(25 * MIN);
  });

  it("Complete with no work at all still works; completing the last Action → NeedsAIReplan", () => {
    const { a1, a2, a3 } = seed();
    unwrap(complete(a1));
    unwrap(complete(a2));
    unwrap(app.commands.startWork(ui(), { actionId: a3 }));
    advance(5);
    unwrap(complete(a3));
    expect(view()).toMatchObject({ currentAction: null, needsAiReplan: true });
    expect(exec()).toMatchObject({ state: "idle", actionId: null, todayWorkedMs: 5 * MIN });
  });

  it("blocking the running Action stops the timer instead of recording forever", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(7);
    unwrap(app.commands.blockAction(ui(), { id: a1, expectedVersion: versionOf(a1), reason: "Жду ответ" }));
    advance(60);
    expect(exec().todayWorkedMs).toBe(7 * MIN);
  });

  it("running work pins Сейчас even if the AI reorders the plan meanwhile", () => {
    const { a1, a2, a3 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    const v = view();
    const plan = v.orderedActionPlan;
    if (!plan) throw new Error("plan");
    unwrap(
      app.commands.reorderExistingActions(app.newContext("mcp-ai", "test"), {
        intentionId: plan.intentionId,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        expectedPlanVersion: plan.version,
        orderedActionIds: [a2, a1, a3],
        rationale: "Two first",
      }),
    );
    expect(view().currentAction).toMatchObject({ actionId: a1, reason: { kind: "working" } });
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(view().currentAction?.actionId).toBe(a2);
  });

  it("MCP can read execution facts but not control them", () => {
    const { a1 } = seed();
    const ai = app.newContext("mcp-ai", "test");
    expect(app.commands.startWork(ai, { actionId: a1 })).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect(app.commands.pauseRunningWork(ai)).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect(unwrap(app.queries.getPlanningContext()).execution.state).toBe("idle");
  });

  it("quit/suspend pause: pauses whatever runs, no auto-resume, and is a no-op when idle", () => {
    const { a1 } = seed();
    const revision = unwrap(app.queries.getStateRevision()).stateRevision;
    unwrap(app.commands.pauseRunningWork(sys()));
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(revision);
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(12);
    unwrap(app.commands.pauseRunningWork(sys())); // suspend / quit
    silence(8 * 60); // asleep all night
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 12 * MIN });
  });

  it("crash recovery: open interval capped at the last heartbeat, restored as paused", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    for (let i = 0; i < 10; i++) {
      advance(1);
      expect(unwrap(app.commands.heartbeatWork(sys()))).toBe("checkpoint");
    }
    const revision = unwrap(app.queries.getStateRevision()).stateRevision;
    const historyBefore = history().length;
    // Heartbeats are technical: no revision bump, no history entries.
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(revision);
    silence(0.5);
    // Crash here; the next launch is the next morning.
    silence(10 * 60);
    unwrap(app.commands.recoverInterruptedWork(sys()));
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 10 * MIN });
    expect(history().length).toBe(historyBefore + 1);
    expect(history()[0]).toBe("work.recover");
    // Nothing to recover the next time.
    unwrap(app.commands.recoverInterruptedWork(sys()));
    expect(history().length).toBe(historyBefore + 1);
  });

  it("a heartbeat after a long silence (missed suspend) pauses at the last checkpoint", () => {
    const { a1 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(1);
    silence(120);
    expect(unwrap(app.commands.heartbeatWork(sys()))).toBe("recovered");
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 1 * MIN });
  });

  it("an unnoticed sleep never counts: reads, Пауза, Готово and Продолжить all stop at the last checkpoint", () => {
    const { a1, a2 } = seed();
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(10);
    silence(8 * 60); // no suspend event, no heartbeat
    // Before any heartbeat notices: the sleep is not shown as work, today or on the Action.
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 10 * MIN, todayWorkedMs: 10 * MIN });
    expect(unwrap(app.queries.getPlanningContext()).execution.todayWorkedMs).toBe(10 * MIN);
    // Продолжить right after waking: the silent interval ends at its checkpoint, a new one starts.
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(5);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(exec()).toMatchObject({ state: "paused", actionWorkedMs: 15 * MIN });
    // Пауза / Готово pressed right after an unnoticed sleep also stop at the checkpoint.
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(2);
    silence(60);
    unwrap(app.commands.pauseWork(ui(), { actionId: a1 }));
    expect(exec().actionWorkedMs).toBe(17 * MIN);
    unwrap(app.commands.startWork(ui(), { actionId: a1 }));
    advance(3);
    silence(60);
    unwrap(complete(a1));
    expect(exec()).toMatchObject({ actionId: a2, todayWorkedMs: 20 * MIN });
  });

  it("migrates a real Stage-4 (schema v8) database and keeps its data", () => {
    const file = join(home, "stage4.sqlite");
    const old = new Database(file);
    applyMigrations(old, MIGRATIONS.slice(0, 8));
    old.prepare("insert into intentions values ('i', 'T', 'R', 1, 'c', 'u')").run();
    old.close();
    const migrated = openDesktopDatabase(file);
    try {
      expect(migrated.sqlite.prepare("select title from intentions").get()).toEqual({ title: "T" });
      expect(migrated.sqlite.prepare("select daily_work_target_minutes m from settings").get()).toEqual({ m: 360 });
    } finally {
      migrated.close();
    }
  });
});
