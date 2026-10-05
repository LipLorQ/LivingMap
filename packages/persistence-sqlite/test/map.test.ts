import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import { MAX_ACTIVE_INTENTIONS } from "@living-map/domain";
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

let home: string;
let file: string;
let nowMs: number;
const opened: SqliteHandle[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-map-"));
  file = databaseFile(home);
  nowMs = Date.parse("2026-10-02T10:00:00.000Z");
});
afterEach(() => {
  for (const h of opened.splice(0)) if (h.sqlite.open) h.close();
  rmSync(home, { recursive: true, force: true });
});

const track = (h: SqliteHandle): SqliteHandle => {
  opened.push(h);
  return h;
};
const appOn = (h: SqliteHandle): Application =>
  createApplication({
    store: createSqliteStore(h, uuidGenerator),
    clock: { now: () => new Date(nowMs).toISOString() },
    ids: uuidGenerator,
    timeZone: () => "UTC",
  });
function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ctx = (app: Application, actor: "user-ui" | "system" | "mcp-ai" = "user-ui") => app.newContext(actor, "test");
const count = (h: SqliteHandle, table: string) =>
  (h.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

/** The exact shape of the owner's real database before Stage 8 (schema v17), filled like a real one. */
function legacyV17(withSeasonChange: boolean): void {
  const legacy = new Database(file);
  legacy.pragma("journal_mode = WAL");
  applyMigrations(legacy, MIGRATIONS.slice(0, 17));
  const T = "2026-09-27T12:13:02.683Z";
  legacy.exec(`
    INSERT INTO season (id, focus, version, created_at, updated_at) VALUES ('s0','Запустить рабочую Живую карту!',3,'${T}','2026-09-28T10:00:00.000Z');
    INSERT INTO good_life_conditions (id, text, position, version, created_at, updated_at) VALUES ('g1','Сон',1,1,'${T}','${T}');
    INSERT INTO intentions (id, title, desired_result, version, created_at, updated_at) VALUES ('i0','Создать MVP','Пользуюсь каждый день',1,'${T}','${T}');
    INSERT INTO stages (id, intention_id, title, position, is_current, version, created_at, updated_at) VALUES ('st1','i0','Основа',1,1,1,'${T}','${T}');
    INSERT INTO stages (id, intention_id, title, position, is_current, version, created_at, updated_at) VALUES ('st2','i0','Рост',2,0,1,'${T}','${T}');
    INSERT INTO actions (id, stage_id, title, done_when, position, status, blocker_reason, blocked_at, completed_at, version, created_at, updated_at) VALUES ('a1','st1','Сделано','',1,'done',NULL,NULL,'${T}',2,'${T}','${T}');
    INSERT INTO actions (id, stage_id, title, done_when, position, status, blocker_reason, blocked_at, completed_at, version, created_at, updated_at) VALUES ('a2','st1','Следующее','проверка',2,'open',NULL,NULL,NULL,1,'${T}','${T}');
    INSERT INTO actions (id, stage_id, title, done_when, position, status, blocker_reason, blocked_at, completed_at, version, created_at, updated_at) VALUES ('a3','st2','Позже','',1,'open',NULL,NULL,NULL,1,'${T}','${T}');
    INSERT INTO ordered_action_plans (id, intention_id, ordered_action_ids, rationale, created_by, created_at, updated_at, version, source_revision) VALUES ('p0','i0','["a2","a3"]','Так логичнее','mcp-ai','${T}','${T}',1,5);
    INSERT INTO change_log (id, timestamp, actor, command_type, entity_type, entity_id, correlation_id, summary, state_revision) VALUES ('c1','${T}','user-ui','season.create','season','s0','k','created',1);
    ${
      withSeasonChange
        ? `INSERT INTO change_log (id, timestamp, actor, command_type, entity_type, entity_id, correlation_id, summary, state_revision) VALUES ('c2','2026-09-29T08:00:00.000Z','user-ui','season.changeSeason','season','s0','k','v1→v2',2);`
        : ""
    }
    UPDATE meta SET state_revision = 139;
  `);
  legacy.close();
}

describe("migration 0017 from the real schema v17", () => {
  it("backs up first, keeps every row, invents nothing, and the old world keeps working exactly as before", () => {
    legacyV17(false);
    const h = track(openDesktopDatabase(file));
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(EXPECTED_SCHEMA_VERSION).toBe(20); // 0017 (Stage 8), 0018 (Stage 9 period labels), 0019 (Stage 9 Day 1)
    expect(readdirSync(backupsDir(home)).some((f) => f.includes("schema-v17"))).toBe(true);
    expect(h.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);

    // every pre-existing row survived
    expect([count(h, "season"), count(h, "intentions"), count(h, "stages"), count(h, "actions")]).toEqual([1, 1, 2, 3]);
    expect([count(h, "ordered_action_plans"), count(h, "good_life_conditions"), count(h, "change_log")]).toEqual([
      1, 1, 1,
    ]);
    // new layers are genuinely empty — nothing was made up for the owner
    for (const table of [
      "decade_plan_items",
      "three_year_horizon",
      "year_direction",
      "season_history",
      "routine_items",
      "course_changes",
    ]) {
      expect(count(h, table), table).toBe(0);
    }

    const app = appOn(h);
    const v = unwrap(app.queries.getCurrentView());
    // the Season keeps its real start: when it was created (no owner-declared season change existed)
    expect(v.season).toMatchObject({
      focus: "Запустить рабочую Живую карту!",
      whyItMatters: "",
      startedAt: "2026-09-27T12:13:02.683Z",
      version: 3,
    });
    // the lone Intention of Stages 2-7 is active, first in order, with the same route and the same Сейчас
    expect(v.intention).toMatchObject({ id: "i0", status: "active", position: 1, whyItMatters: "", closedAt: null });
    expect(v.projects).toHaveLength(1);
    expect(v.projectSlots).toEqual({ active: 1, max: 3 });
    expect(v.currentAction).toMatchObject({ actionId: "a2", intentionId: "i0", stageId: "st1" });
    expect(v.needsAiReplan).toBe(false);
    expect(v.projects[0]?.progress).toEqual({ stageIndex: 1, stageCount: 2, actionsDone: 1, actionsTotal: 3 });
    // empty strategic layers are a valid state, not an error
    expect(v.strategy).toMatchObject({ decadePlan: [], horizon: null, year: null, openCourseChanges: [] });
    expect(v.strategy.seasonProgress).toEqual({ completed: 0, total: 1 });
    expect(v.routines).toEqual([]);
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(139);
    expect(unwrap(app.queries.getStrategyHistory())).toEqual({ pastSeasons: [], currentSeasonClosedProjects: [] });
  });

  it("backfills the Season start from the last owner-declared season change when one exists", () => {
    legacyV17(true);
    const h = track(openDesktopDatabase(file));
    expect(unwrap(appOn(h).queries.getCurrentView()).season?.startedAt).toBe("2026-09-29T08:00:00.000Z");
  });

  it("is additive: a fresh database and a migrated one end up with the same Stage 8 schema", () => {
    const fresh = track(openDesktopDatabase(file));
    const names = (h: SqliteHandle) =>
      (
        h.sqlite.prepare("select name from sqlite_master where name not like 'sqlite_%' order by name").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    const freshNames = names(fresh);
    fresh.close();
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "living-map-map-"));
    file = databaseFile(home);
    legacyV17(false);
    expect(names(track(openDesktopDatabase(file)))).toEqual(freshNames);
  });
});

describe("the active-project limit is a database fact", () => {
  const insert = (h: SqliteHandle, id: string, status: string) =>
    h.sqlite
      .prepare(
        "INSERT INTO intentions (id, title, desired_result, why_it_matters, status, position, closed_at, version, created_at, updated_at) VALUES (?, ?, '', '', ?, 1, NULL, 1, 'T', 'T')",
      )
      .run(id, id, status);

  it(`no writer can put a ${MAX_ACTIVE_INTENTIONS + 1}th Intention into the active state, however it tries`, () => {
    const h = track(openDesktopDatabase(file));
    for (let i = 0; i < MAX_ACTIVE_INTENTIONS; i++) insert(h, `a${i}`, "active");
    expect(() => insert(h, "extra", "active")).toThrow(/at most 3 active/);
    // closed and paused ones are not active, and may be inserted freely
    insert(h, "done", "completed");
    insert(h, "paused", "deferred");
    expect(() => h.sqlite.prepare("UPDATE intentions SET status = 'active' WHERE id = 'paused'").run()).toThrow(
      /at most 3 active/,
    );
    expect(() => h.sqlite.prepare("UPDATE intentions SET status = 'active' WHERE id = 'done'").run()).toThrow(
      /at most 3 active/,
    );
    // freeing a slot makes room again
    h.sqlite.prepare("UPDATE intentions SET status = 'released' WHERE id = 'a0'").run();
    h.sqlite.prepare("UPDATE intentions SET status = 'active' WHERE id = 'paused'").run();
    // editing an already-active row never trips the limit
    h.sqlite.prepare("UPDATE intentions SET title = 'renamed', status = 'active' WHERE id = 'a1'").run();
    expect(count(h, "intentions")).toBe(5);
  });

  it("two processes racing for the last slot: exactly one wins, the other gets the typed result", () => {
    const desktop = track(openDesktopDatabase(file));
    const a = appOn(desktop);
    // A second real connection on the same file, like another process.
    const other = track(openDesktopDatabase(file));
    const b = appOn(other);
    unwrap(a.commands.createIntention(ctx(a), { title: "A1", desiredResult: "" }));
    unwrap(a.commands.createIntention(ctx(a), { title: "A2", desiredResult: "" }));
    const first = a.commands.createIntention(ctx(a), { title: "from-desktop", desiredResult: "" });
    const late = b.commands.createIntention(ctx(b, "system"), { title: "from-other", desiredResult: "" });
    expect([first.ok, late.ok]).toEqual([true, false]);
    expect(late).toMatchObject({ ok: false, error: { code: "ACTIVE_PROJECT_LIMIT" } });
    expect(
      (desktop.sqlite.prepare("select count(*) n from intentions where status = 'active'").get() as { n: number }).n,
    ).toBe(3);
  });
});

describe("one current layer is a database fact", () => {
  it("cannot hold two horizons or two year directions, nor a 4-year 'horizon', nor an inverted decade", () => {
    const h = track(openDesktopDatabase(file));
    const horizon = (id: string, end: number) =>
      h.sqlite
        .prepare(
          "INSERT INTO three_year_horizon (id, start_year, end_year, direction, why_it_matters, version, created_at, updated_at) VALUES (?, 2026, ?, 'd', '', 1, 'T', 'T')",
        )
        .run(id, end);
    expect(() => horizon("h-bad", 2030)).toThrow(/CHECK|horizon_span/i);
    horizon("h1", 2028);
    expect(() => horizon("h2", 2028)).toThrow(/UNIQUE/i);
    const year = (id: string) =>
      h.sqlite
        .prepare(
          "INSERT INTO year_direction (id, year, direction, why_it_matters, version, created_at, updated_at) VALUES (?, 2026, 'd', '', 1, 'T', 'T')",
        )
        .run(id);
    year("y1");
    expect(() => year("y2")).toThrow(/UNIQUE/i);
    expect(() =>
      h.sqlite
        .prepare(
          "INSERT INTO decade_plan_items (id, start_year, end_year, statement, version, created_at, updated_at) VALUES ('d1', 2035, 2026, 's', 1, 'T', 'T')",
        )
        .run(),
    ).toThrow(/CHECK|decade_range/i);
  });
});

describe("persistence and reload of the whole map", () => {
  it("decades, horizon, year, season history, course reminders, routines and project order survive a restart", () => {
    let h = track(openDesktopDatabase(file));
    let app = appOn(h);
    unwrap(app.commands.createSeason(ctx(app), { focus: "Рабочая карта", whyItMatters: "Двигает год" }));
    unwrap(
      app.commands.saveStrategy(ctx(app), { level: "decade", startYear: 2026, endYear: 2035, statement: "Строить" }),
    );
    unwrap(
      app.commands.saveStrategy(ctx(app), {
        level: "horizon",
        startYear: 2026,
        direction: "Запуск",
        whyItMatters: "Первый шаг",
      }),
    );
    unwrap(
      app.commands.saveStrategy(ctx(app), { level: "year", year: 2026, direction: "MVP", whyItMatters: "Основа" }),
    );
    const p1 = unwrap(
      app.commands.createIntention(ctx(app), { title: "P1", desiredResult: "r1", whyItMatters: "Служит сезону" }),
    );
    const p2 = unwrap(app.commands.createIntention(ctx(app), { title: "P2", desiredResult: "r2" }));
    unwrap(app.commands.reorderProjects(ctx(app), { orderedIds: [p2.id, p1.id] }));
    unwrap(app.commands.addRoutineItem(ctx(app), { kind: "morning", text: "Вода" }));
    unwrap(app.commands.addRoutineItem(ctx(app), { kind: "evening", text: "Читать" }));
    const year = unwrap(app.queries.getCurrentView()).strategy.year;
    const impact = unwrap(app.queries.previewCourseImpact({ level: "year" }));
    unwrap(
      app.commands.saveStrategy(ctx(app), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "Новый курс",
        whyItMatters: "",
        mode: "course",
        impactFingerprint: impact.fingerprint,
      }),
    );
    nowMs += 60_000;
    const season = unwrap(app.queries.getCurrentView()).season;
    const seasonImpact = unwrap(app.queries.previewCourseImpact({ level: "season" }));
    unwrap(
      app.commands.updateSeasonFocus(ctx(app), {
        expectedVersion: season?.version as number,
        focus: "Новый сезон",
        startsNewSeason: true,
        impactFingerprint: seasonImpact.fingerprint,
      }),
    );
    const before = unwrap(app.queries.getCurrentView());
    const historyBefore = unwrap(app.queries.getStrategyHistory());
    h.close();

    h = track(openDesktopDatabase(file));
    app = appOn(h);
    const after = unwrap(app.queries.getCurrentView());
    expect(after.strategy).toEqual(before.strategy);
    expect(after.routines).toEqual(before.routines);
    expect(after.projects.map((p) => p.intention.title)).toEqual(["P2", "P1"]); // the owner's order
    expect(after.projects[1]?.intention.whyItMatters).toBe("Служит сезону");
    expect(after.season).toEqual(before.season);
    expect(unwrap(app.queries.getStrategyHistory())).toEqual(historyBefore);
    expect(historyBefore.pastSeasons.map((s) => s.focus)).toEqual(["Рабочая карта"]);
    expect(after.strategy.openCourseChanges.map((c) => c.level).sort()).toEqual(["season", "year"]);
    expect(h.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("closed projects become real evidence and history; a season window collects the ones closed during it", () => {
    const h = track(openDesktopDatabase(file));
    const app = appOn(h);
    const season = unwrap(app.commands.createSeason(ctx(app), { focus: "Сезон 1" }));
    const p1 = unwrap(app.commands.createIntention(ctx(app), { title: "Первый", desiredResult: "" }));
    nowMs += 3_600_000;
    unwrap(app.commands.changeIntentionStatus(ctx(app), { id: p1.id, expectedVersion: p1.version, to: "completed" }));
    const p2 = unwrap(app.commands.createIntention(ctx(app), { title: "Второй", desiredResult: "" }));
    nowMs += 3_600_000;
    unwrap(app.commands.changeIntentionStatus(ctx(app), { id: p2.id, expectedVersion: p2.version, to: "released" }));
    nowMs += 3_600_000;
    const impact = unwrap(app.queries.previewCourseImpact({ level: "season" }));
    expect(impact.items).toEqual([]); // nothing open left to affect
    unwrap(
      app.commands.updateSeasonFocus(ctx(app), {
        expectedVersion: season.version,
        focus: "Сезон 2",
        startsNewSeason: true,
      }),
    );
    nowMs += 3_600_000;
    const p3 = unwrap(app.commands.createIntention(ctx(app), { title: "Третий", desiredResult: "" }));
    nowMs += 3_600_000;
    unwrap(app.commands.changeIntentionStatus(ctx(app), { id: p3.id, expectedVersion: p3.version, to: "completed" }));

    const history = unwrap(app.queries.getStrategyHistory());
    expect(history.pastSeasons).toHaveLength(1);
    expect(history.pastSeasons[0]?.closedProjects.map((p) => [p.title, p.status])).toEqual([
      ["Второй", "released"],
      ["Первый", "completed"],
    ]);
    expect(history.currentSeasonClosedProjects.map((p) => p.title)).toEqual(["Третий"]);
    const strategy = unwrap(app.queries.getCurrentView()).strategy;
    expect(strategy.seasonEvidence.map((e) => e.text)).toEqual(["Третий"]);
    expect(strategy.seasonProgress).toEqual({ completed: 1, total: 1 });
  });
});

describe("project work across the map", () => {
  function twoRouted(app: Application) {
    const mk = (title: string, action: string) => {
      const i = unwrap(app.commands.createIntention(ctx(app), { title, desiredResult: "" }));
      const proposal = unwrap(
        app.commands.createRouteProposal(ctx(app, "mcp-ai"), {
          intentionId: i.id,
          expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
          summary: "route",
          rationale: "because",
          newStages: [{ ref: "s", title: "Этап" }],
          stageEdits: [],
          newActions: [{ ref: "a", stage: "s", title: action, doneWhen: "" }],
          actionEdits: [],
          actionOrder: ["a"],
        }),
      );
      unwrap(app.commands.acceptProposal(ctx(app), { id: proposal.id }));
      const project = unwrap(app.queries.getCurrentView()).projects.find((p) => p.intention.id === i.id);
      return {
        intention: project?.intention as NonNullable<typeof project>["intention"],
        actionId: project?.stages[0]?.actions[0]?.id as string,
      };
    };
    return { p1: mk("P1", "p1-work"), p2: mk("P2", "p2-work") };
  }

  it("running work pins its project: reordering projects never yanks the card away mid-work", () => {
    const app = appOn(track(openDesktopDatabase(file)));
    const { p1, p2 } = twoRouted(app);
    unwrap(app.commands.reorderProjects(ctx(app), { orderedIds: [p2.intention.id, p1.intention.id] }));
    unwrap(app.commands.startWork(ctx(app), { actionId: p2.actionId }));
    unwrap(app.commands.reorderProjects(ctx(app), { orderedIds: [p1.intention.id, p2.intention.id] }));
    const pinned = unwrap(app.queries.getCurrentView());
    expect(pinned.currentAction).toMatchObject({ actionId: p2.actionId, reason: { kind: "working" } });
    expect(pinned.intention?.id).toBe(p2.intention.id);
    nowMs += 600_000;
    unwrap(app.commands.pauseWork(ctx(app), { actionId: p2.actionId }));
    expect(unwrap(app.queries.getCurrentView()).currentAction?.actionId).toBe(p1.actionId);
  });

  it("reordering projects changes only the order, never a project's version (so pending AI proposals stay fresh)", () => {
    const h = track(openDesktopDatabase(file));
    const app = appOn(h);
    const { p1, p2 } = twoRouted(app);
    const versions = () =>
      h.sqlite.prepare("select id, version, position from intentions order by id").all() as {
        id: string;
        version: number;
        position: number;
      }[];
    const before = versions();
    unwrap(app.commands.reorderProjects(ctx(app), { orderedIds: [p2.intention.id, p1.intention.id] }));
    const after = versions();
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
    expect(after.find((r) => r.id === p2.intention.id)?.position).toBe(1);
    expect(after.find((r) => r.id === p1.intention.id)?.position).toBe(2);
  });

  it("work can only start on the current Action of the leading project", () => {
    const app = appOn(track(openDesktopDatabase(file)));
    const { p1, p2 } = twoRouted(app);
    expect(app.commands.startWork(ctx(app), { actionId: p2.actionId })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
    expect(app.commands.startWork(ctx(app), { actionId: p1.actionId })).toMatchObject({ ok: true });
  });

  it("pausing/closing a project stops its running work in the same command, keeping the time", () => {
    const h = track(openDesktopDatabase(file));
    const app = appOn(h);
    const { p1 } = twoRouted(app);
    unwrap(app.commands.startWork(ctx(app), { actionId: p1.actionId }));
    for (let minute = 0; minute < 20; minute++) {
      nowMs += 60_000; // the real app checkpoints about once a minute
      app.commands.heartbeatWork(ctx(app, "system"));
    }
    const before = unwrap(app.queries.getStateRevision()).stateRevision;
    unwrap(
      app.commands.changeIntentionStatus(ctx(app), {
        id: p1.intention.id,
        expectedVersion: p1.intention.version,
        to: "deferred",
      }),
    );
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(before + 1); // one command, one revision
    expect(
      (h.sqlite.prepare("select count(*) n from work_intervals where ended_at is null").get() as { n: number }).n,
    ).toBe(0);
    expect((h.sqlite.prepare("select count(*) n from work_intervals").get() as { n: number }).n).toBe(1);
    const v = unwrap(app.queries.getCurrentView());
    expect(v.execution.todayWorkedMs).toBe(20 * 60_000);
    expect(v.execution.state).not.toBe("running");
  });

  it("routines are never work: a day with routines but no Start has zero worked time, and no interval can reference one", () => {
    const h = track(openDesktopDatabase(file));
    const app = appOn(h);
    const item = unwrap(app.commands.addRoutineItem(ctx(app), { kind: "morning", text: "Зарядка" }));
    expect(app.commands.startWork(ctx(app), { actionId: item.id })).toMatchObject({ ok: false });
    expect(count(h, "work_intervals")).toBe(0);
    expect(unwrap(app.queries.getCurrentView()).execution.todayWorkedMs).toBe(0);
    // the FK from work_intervals to actions makes a routine id structurally impossible as an interval target
    expect(() =>
      h.sqlite
        .prepare(
          "INSERT INTO work_intervals (id, action_id, started_at, ended_at, last_heartbeat_at, time_zone) VALUES ('w', ?, 'T', NULL, 'T', 'UTC')",
        )
        .run(item.id),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("history is readable and complete", () => {
  it("every Stage 8 command leaves a change-log line the user can read back", () => {
    const h = track(openDesktopDatabase(file));
    const app = appOn(h);
    unwrap(
      app.commands.saveStrategy(ctx(app), { level: "decade", startYear: 2026, endYear: 2035, statement: "Строить" }),
    );
    const p = unwrap(app.commands.createIntention(ctx(app), { title: "P", desiredResult: "" }));
    unwrap(app.commands.addRoutineItem(ctx(app), { kind: "morning", text: "Вода" }));
    unwrap(app.commands.changeIntentionStatus(ctx(app), { id: p.id, expectedVersion: p.version, to: "deferred" }));
    const types = unwrap(app.queries.listChangeHistory({ limit: 50 })).map((e) => e.commandType);
    expect(types).toEqual(["intention.defer", "routine.add", "intention.create", "strategy.decade.add"]);
  });
});

describe("migration 0018 from the real schema v18 (Stage 9 period labels)", () => {
  it("backs up first, adds empty labels only, keeps every strategy row, and a label then survives a restart", () => {
    const legacy = new Database(file);
    legacy.pragma("journal_mode = WAL");
    applyMigrations(legacy, MIGRATIONS.slice(0, 18));
    const T = "2026-10-03T06:16:16.227Z";
    legacy.exec(`
      INSERT INTO decade_plan_items (id, start_year, end_year, statement, version, created_at, updated_at) VALUES ('d1',2026,2035,'Строить',1,'${T}','${T}');
      INSERT INTO three_year_horizon (id, start_year, end_year, direction, why_it_matters, version, created_at, updated_at) VALUES ('h1',2026,2028,'Расти','',1,'${T}','${T}');
      INSERT INTO year_direction (id, year, direction, why_it_matters, version, created_at, updated_at) VALUES ('y1',2026,'MVP','',2,'${T}','${T}');
      UPDATE meta SET state_revision = 187;
    `);
    const strategyRows = (db: Database.Database) =>
      ["decade_plan_items", "three_year_horizon", "year_direction"].map((t) =>
        db.prepare(`select id, version, created_at, updated_at from ${t} order by id`).all(),
      );
    const before = strategyRows(legacy);
    legacy.close();

    const h = track(openDesktopDatabase(file));
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(readdirSync(backupsDir(home)).some((f) => f.includes("schema-v18"))).toBe(true);
    expect(h.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(strategyRows(h.sqlite)).toEqual(before);
    expect(h.sqlite.prepare("select label from decade_plan_items").all()).toEqual([{ label: null }]);
    expect(h.sqlite.prepare("select label from year_direction").all()).toEqual([{ label: null }]);

    const app = appOn(h);
    const v = unwrap(app.queries.getCurrentView());
    expect(v.strategy.year).toMatchObject({ year: 2026, label: null, direction: "MVP", isCurrentYear: true });
    expect(v.strategy.decadePlan[0]).toMatchObject({ label: null, statement: "Строить" });
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(187);

    unwrap(
      app.commands.saveStrategy(ctx(app), {
        level: "year",
        expectedVersion: 2,
        year: 2026,
        label: "До следующего дня рождения",
        direction: "MVP",
        whyItMatters: "",
        mode: "course",
      }),
    );
    h.close();
    const reopened = track(openDesktopDatabase(file));
    expect(unwrap(appOn(reopened).queries.getCurrentView()).strategy.year).toMatchObject({
      label: "До следующего дня рождения",
      version: 3,
    });
  });
});
