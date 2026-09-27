import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@living-map/application";
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
});

describe("two connections share one database", () => {
  it("a write on one connection is readable on the other, with state_revision and change log", () => {
    const d = appOn(desktop());
    const m = appOn(mcp());
    const created = d.commands.createProbe(d.newContext("user-ui", "test"), { title: "shared" });
    if (!created.ok) throw new Error(created.error.message);

    expect(m.queries.getProbe({ id: created.value.id })).toMatchObject({ ok: true, value: { title: "shared" } });
    expect(m.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 1 } });

    const log = mcp().sqlite.prepare("select actor, command_type, entity_id, state_revision from change_log").all();
    expect(log).toEqual([
      { actor: "user-ui", command_type: "probe.create", entity_id: created.value.id, state_revision: 1 },
    ]);
  });

  it("optimistic concurrency: first write wins, stale write gets CONFLICT_RELOAD and overwrites nothing", () => {
    const d = appOn(desktop());
    const m = appOn(mcp());
    const created = d.commands.createProbe(d.newContext("user-ui", "test"), { title: "v1" });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.id;

    // Both sides read version 1.
    const seenByDesktop = d.queries.getProbe({ id });
    const seenByMcp = m.queries.getProbe({ id });
    if (!seenByDesktop.ok || !seenByMcp.ok) throw new Error("read failed");

    const first = m.commands.renameProbe(m.newContext("mcp-ai", "test"), {
      id,
      expectedVersion: seenByMcp.value.version,
      title: "from MCP",
    });
    expect(first).toMatchObject({ ok: true, value: { version: 2, title: "from MCP" } });

    const stale = d.commands.renameProbe(d.newContext("user-ui", "test"), {
      id,
      expectedVersion: seenByDesktop.value.version,
      title: "stale from UI",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });

    expect(d.queries.getProbe({ id })).toMatchObject({ ok: true, value: { title: "from MCP", version: 2 } });
    expect(d.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 2 } });
  });

  it("storage-level guard: updateIfVersion never overwrites a newer version", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    const created = app.commands.createProbe(app.newContext("system", "test"), { title: "a" });
    if (!created.ok) throw new Error(created.error.message);
    const ctx = app.newContext("system", "test");
    const applied = store.write(ctx, (s) =>
      s.probes.updateIfVersion({ ...created.value, title: "ghost", version: 5 }, 4),
    );
    expect(applied).toBe(false);
    expect(app.queries.getProbe({ id: created.value.id })).toMatchObject({ value: { title: "a", version: 1 } });
  });

  it("a failing write transaction rolls back entirely (no half state, no revision bump)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(() =>
      store.write(app.newContext("system", "test"), (s) => {
        s.probes.insert({
          id: uuidGenerator.next(),
          title: "half",
          version: 1,
          createdAt: systemClock.now(),
          updatedAt: systemClock.now(),
        });
        s.recordChange({ commandType: "probe.create", entityType: "probe", entityId: "x", summary: "" });
        throw new Error("crash mid-command");
      }),
    ).toThrow("crash mid-command");
    expect(app.queries.listProbes()).toEqual({ ok: true, value: [] });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
  });

  it("recordChange invariant: a command that mutates rows but forgets recordChange rolls back entirely (ADR-0003)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(() =>
      store.write(app.newContext("system", "test"), (s) => {
        s.probes.insert({
          id: uuidGenerator.next(),
          title: "forgot recordChange",
          version: 1,
          createdAt: systemClock.now(),
          updatedAt: systemClock.now(),
        });
        // No s.recordChange(...) call here — must not silently commit.
      }),
    ).toThrow(/recordChange/);
    expect(app.queries.listProbes()).toEqual({ ok: true, value: [] });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 0 } });
  });

  it("does not require recordChange when a write makes no row changes (e.g. a no-op check)", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = appOn(h);
    expect(store.write(app.newContext("system", "test"), (s) => s.probes.list())).toEqual([]);
  });
});

describe("per-write schema check (ADR-0003)", () => {
  it("a write started after the schema changed under this process fails with SchemaConflictError, not a silent write", () => {
    const h = desktop();
    const store = createSqliteStore(h, uuidGenerator);
    const app = createApplication({ store, clock: systemClock, ids: uuidGenerator });
    const created = app.commands.createProbe(app.newContext("system", "test"), { title: "x" });
    if (!created.ok) throw new Error(created.error.message);

    // Simulate desktop migrating the schema further while this connection is still open.
    h.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION + 1}`);

    const result = app.commands.renameProbe(app.newContext("mcp-ai", "test"), {
      id: created.value.id,
      expectedVersion: 1,
      title: "y",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "SCHEMA_INCOMPATIBLE" } });
  });

  it("also protects desktop itself — e.g. a second, older desktop instance left running", () => {
    // Two desktop connections on the same file: the first migrates, the second (still holding
    // its original connection open) must not keep writing as if nothing changed.
    const first = desktop();
    const second = appOn(mcp()); // a second connection on the same file; MCP's open is convenient here
    first.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION + 1}`); // simulate a newer schema landing

    const result = second.commands.createProbe(second.newContext("user-ui", "test"), { title: "x" });
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
