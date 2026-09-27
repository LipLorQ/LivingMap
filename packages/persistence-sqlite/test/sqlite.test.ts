import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@living-map/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUSY_TIMEOUT_MS,
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
});
