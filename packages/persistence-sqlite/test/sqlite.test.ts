import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@living-map/application";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  BUSY_TIMEOUT_MS,
  backupsDir,
  createSqliteStore,
  databaseFile,
  EXPECTED_SCHEMA_VERSION,
  openDesktopDatabase,
  openMcpDatabase,
  resolveDataHome,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "../src";

let home: string;
let file: string;
const opened: SqliteHandle[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-test-"));
  file = databaseFile(home);
});

afterEach(() => {
  for (const h of opened.splice(0)) if (h.sqlite.open) h.close();
  rmSync(home, { recursive: true, force: true });
});

function desktop(): SqliteHandle {
  const h = openDesktopDatabase(file);
  opened.push(h);
  return h;
}

function mcp(): SqliteHandle {
  const r = openMcpDatabase(file);
  if (r.status !== "ready") throw new Error(`mcp open: ${r.status}`);
  opened.push(r.handle);
  return r.handle;
}

const appOn = (h: SqliteHandle) =>
  createApplication({ store: createSqliteStore(h, uuidGenerator), clock: systemClock, ids: uuidGenerator });

describe("data home", () => {
  it("LIVING_MAP_HOME fully overrides the platform directory", () => {
    expect(resolveDataHome({ LIVING_MAP_HOME: home }, "win32")).toBe(home);
    expect(resolveDataHome({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\x\\AppData\\Roaming", "LivingMap"),
    );
  });
});

describe("connection pragmas (ARCHITECTURE §12)", () => {
  it("desktop and MCP connections both run WAL + foreign_keys + busy_timeout", () => {
    for (const h of [desktop(), mcp()]) {
      expect(h.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(h.sqlite.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
    }
  });
});

describe("migrations ownership (ARCHITECTURE §16)", () => {
  it("desktop migrates to the expected schema and seeds state_revision = 0; reopening is idempotent", () => {
    const h = desktop();
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(appOn(h).queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
    h.close();
    expect(appOn(desktop()).queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
  });

  it("MCP never creates the database file", () => {
    expect(openMcpDatabase(file)).toEqual({ status: "missing" });
    expect(existsSync(file)).toBe(false);
  });

  it("MCP reports an incompatible schema instead of migrating it", () => {
    desktop().sqlite.pragma("user_version = 99");
    const r = openMcpDatabase(file);
    expect(r).toMatchObject({ status: "incompatible", schema: { current: 99, expected: EXPECTED_SCHEMA_VERSION } });
    if (r.status !== "missing") r.handle.close();
  });

  it("desktop refuses to open a database newer than itself", () => {
    const h = desktop();
    h.sqlite.pragma("user_version = 99");
    h.close();
    expect(() => openDesktopDatabase(file)).toThrow(/newer than this app/);
  });

  it("migrates cleanly from the previous real (Stage 1 / probes) schema, dropping probes and adding the domain tables", () => {
    // Reproduce a Stage-1 database: apply only the first two migrations (schema v2, with `probes`).
    const h = desktop();
    h.close();
    opened.pop();
    const reset = new Database(file);
    reset.pragma("foreign_keys = OFF");
    reset.exec(
      "DROP TABLE actions; DROP TABLE stages; DROP TABLE intentions; DROP TABLE good_life_conditions; DROP TABLE season;",
    );
    reset.exec(
      "CREATE TABLE probes (id text PRIMARY KEY NOT NULL, title text NOT NULL, version integer NOT NULL, created_at text NOT NULL, updated_at text NOT NULL);",
    );
    reset.exec("INSERT INTO probes (id, title, version, created_at, updated_at) VALUES ('p1', 'legacy', 1, 'T', 'T');");
    reset.pragma("user_version = 2");
    reset.pragma("foreign_keys = ON");
    reset.close();

    const migrated = desktop();
    expect(migrated.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(
      migrated.sqlite.prepare("select name from sqlite_master where type='table' and name='probes'").get(),
    ).toBeUndefined();
    const app = appOn(migrated);
    expect(app.queries.getCurrentView()).toMatchObject({
      ok: true,
      value: { season: null, goodLifeConditions: [], intention: null, stages: [] },
    });
  });
});

describe("two connections share one database", () => {
  it("a write on one connection is readable on the other, with state_revision and change log", () => {
    const d = appOn(desktop());
    const m = appOn(mcp());
    const created = d.commands.createSeason(d.newContext("user-ui", "test"), { focus: "shared" });
    if (!created.ok) throw new Error(created.error.message);

    expect(m.queries.getSeason()).toMatchObject({ ok: true, value: { focus: "shared" } });
    expect(m.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 1 } });

    const log = mcp().sqlite.prepare("select actor, command_type, entity_id, state_revision from change_log").all();
    expect(log).toEqual([
      { actor: "user-ui", command_type: "season.create", entity_id: created.value.id, state_revision: 1 },
    ]);
  });

  it("optimistic concurrency: first write wins, stale write gets CONFLICT_RELOAD and overwrites nothing", () => {
    const d = appOn(desktop());
    const m = appOn(mcp());
    const created = d.commands.createSeason(d.newContext("user-ui", "test"), { focus: "v1" });
    if (!created.ok) throw new Error(created.error.message);

    // Both sides read version 1.
    const seenByDesktop = d.queries.getSeason();
    const seenByMcp = m.queries.getSeason();
    if (!seenByDesktop.ok || !seenByMcp.ok || !seenByDesktop.value || !seenByMcp.value) throw new Error("read failed");

    const first = m.commands.updateSeasonFocus(m.newContext("system", "test"), {
      expectedVersion: seenByMcp.value.version,
      focus: "from MCP",
    });
    expect(first).toMatchObject({ ok: true, value: { version: 2, focus: "from MCP" } });

    const stale = d.commands.updateSeasonFocus(d.newContext("user-ui", "test"), {
      expectedVersion: seenByDesktop.value.version,
      focus: "stale from UI",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });

    expect(d.queries.getSeason()).toMatchObject({ ok: true, value: { focus: "from MCP", version: 2 } });
    expect(d.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 2 } });
  });

  it("storage-level guard: updateIfVersion never overwrites a newer version", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    const created = app.commands.createSeason(app.newContext("system", "test"), { focus: "a" });
    if (!created.ok) throw new Error(created.error.message);
    const ctx = app.newContext("system", "test");
    const applied = store.write(ctx, (s) =>
      s.season.updateIfVersion({ ...created.value, focus: "ghost", version: 5 }, 4),
    );
    expect(applied).toBe(false);
    expect(app.queries.getSeason()).toMatchObject({ value: { focus: "a", version: 1 } });
  });

  it("a failing write transaction rolls back entirely (no half state, no revision bump)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(() =>
      store.write(app.newContext("system", "test"), (s) => {
        s.season.insert({
          id: uuidGenerator.next(),
          focus: "half",
          version: 1,
          createdAt: systemClock.now(),
          updatedAt: systemClock.now(),
        });
        s.recordChange({ commandType: "season.create", entityType: "season", entityId: "x", summary: "" });
        throw new Error("crash mid-command");
      }),
    ).toThrow("crash mid-command");
    expect(app.queries.getSeason()).toEqual({ ok: true, value: null });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
  });

  it("recordChange invariant: a command that mutates rows but forgets recordChange rolls back entirely (ADR-0003)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(() =>
      store.write(app.newContext("system", "test"), (s) => {
        s.season.insert({
          id: uuidGenerator.next(),
          focus: "forgot recordChange",
          version: 1,
          createdAt: systemClock.now(),
          updatedAt: systemClock.now(),
        });
        // No s.recordChange(...) call here — must not silently commit.
      }),
    ).toThrow(/recordChange/);
    expect(app.queries.getSeason()).toEqual({ ok: true, value: null });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
  });

  it("does not require recordChange when a write makes no row changes (e.g. a no-op check)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(store.write(app.newContext("system", "test"), (s) => s.goodLifeConditions.list())).toEqual([]);
  });

  it("stress: desktop + MCP hammer one Action — no stale overwrite, no lost update, no SQLITE_BUSY leak", async () => {
    const WRITES_PER_WRITER = 40;
    const d = appOn(desktop());
    const m = appOn(mcp());
    const ui = d.newContext("user-ui", "test");
    const intention = d.commands.createIntention(ui, { title: "x", desiredResult: "" });
    if (!intention.ok) throw new Error(intention.error.message);
    const stage = d.commands.addStage(ui, { intentionId: intention.value.id, title: "s" });
    if (!stage.ok) throw new Error(stage.error.message);
    const action = d.commands.addAction(ui, { stageId: stage.value.id, title: "counter", doneWhen: "" });
    if (!action.ok) throw new Error(action.error.message);
    const id = action.value.id;

    const stats = { conflicts: 0, otherErrors: [] as string[], overwrites: [] as string[] };
    async function writer(app: ReturnType<typeof appOn>, actor: "user-ui" | "system") {
      for (let done = 0; done < WRITES_PER_WRITER; ) {
        const seen = app.queries.getCurrentView();
        if (!seen.ok) throw new Error(seen.error.code);
        const current = seen.value.stages[0]?.actions[0];
        if (!current) throw new Error("action missing");
        // Force interleaving between the two writers: without a yield point here, each async
        // function's fully-synchronous loop body would run to completion before the other ever
        // gets a turn, and the race this test exists to exercise would never happen.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
        const r = app.commands.editAction(app.newContext(actor, "test"), {
          id,
          expectedVersion: current.version,
          title: `${actor}-${done}`,
          doneWhen: "",
        });
        if (r.ok && r.value.version !== current.version + 1)
          stats.overwrites.push(`v${current.version}→v${r.value.version}`);
        if (r.ok) done++;
        else if (r.error.code === "CONFLICT_RELOAD") stats.conflicts++;
        else stats.otherErrors.push(r.error.code);
      }
    }

    await Promise.all([writer(d, "user-ui"), writer(m, "system")]);

    const total = 2 * WRITES_PER_WRITER;
    expect(stats.otherErrors).toEqual([]);
    expect(stats.overwrites).toEqual([]);
    expect(stats.conflicts).toBeGreaterThan(0);
    const finalView = d.queries.getCurrentView();
    if (!finalView.ok) throw new Error("expected ok");
    expect(finalView.value.stages[0]?.actions[0]?.version).toBe(1 + total);
  });
});

describe("per-write schema check (ADR-0003)", () => {
  it("a write started after the schema changed under this process fails with SchemaConflictError, not a silent write", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = createApplication({ store, clock: systemClock, ids: uuidGenerator });
    const created = app.commands.createSeason(app.newContext("system", "test"), { focus: "x" });
    if (!created.ok) throw new Error(created.error.message);

    // Simulate desktop migrating the schema further while this connection is still open.
    h.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION + 1}`);

    const result = app.commands.updateSeasonFocus(app.newContext("system", "test"), { expectedVersion: 1, focus: "y" });
    expect(result).toMatchObject({ ok: false, error: { code: "SCHEMA_INCOMPATIBLE" } });
  });

  it("also protects desktop itself — e.g. a second, older desktop instance left running", () => {
    // Two desktop connections on the same file: the first migrates, the second (still holding
    // its original connection open) must not keep writing as if nothing changed.
    const first = desktop();
    const second = appOn(mcp()); // a second connection on the same file; MCP's open is convenient here
    first.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION + 1}`); // simulate a newer schema landing

    const result = second.commands.createSeason(second.newContext("user-ui", "test"), { focus: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "SCHEMA_INCOMPATIBLE" } });
  });
});

describe("FK-safe migration lifecycle (ADR-0003)", () => {
  it("leaves foreign_keys back ON after a successful migration", () => {
    const h = desktop(); // migrations already ran during open
    expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("a failing migration rolls back atomically, restores foreign_keys, and does not bump user_version", () => {
    const h = desktop();
    h.sqlite.pragma("user_version = 0"); // pretend nothing is applied yet, to re-run migrations
    const badMigrations = [{ statements: ["this is not valid sql;"] }];

    expect(() => applyMigrations(h.sqlite, badMigrations)).toThrow();
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(0);
    expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("a migration that leaves a foreign key violation is rejected and rolled back", () => {
    const h = desktop();
    h.sqlite.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    h.sqlite.pragma("user_version = 0");
    const migrations = [
      {
        statements: [
          "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
          "INSERT INTO child (id, parent_id) VALUES (1, 999)", // 999 does not exist in parent
        ],
      },
    ];

    expect(() => applyMigrations(h.sqlite, migrations)).toThrow(/foreign key violation/i);
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(0);
    // The whole migration transaction rolled back, including the CREATE TABLE — no half-applied schema.
    expect(() => h.sqlite.prepare("select count(*) from child").get()).toThrow(/no such table/i);
    expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("takes an automatic backup before attempting a pending migration, even if that migration then fails", () => {
    const h = desktop();
    expect(existsSync(backupsDir(home))).toBe(false); // fresh DB: nothing backed up yet

    // Pretend one migration is still pending. Re-running the (non-idempotent) seed migration
    // fails — the point of this test is that the backup happens up front regardless.
    h.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION - 1}`);
    h.close();

    expect(() => openDesktopDatabase(file)).toThrow();
    expect(existsSync(backupsDir(home))).toBe(true);
    expect(readdirSync(backupsDir(home)).some((f) => f.startsWith("auto-"))).toBe(true);
  });
});
