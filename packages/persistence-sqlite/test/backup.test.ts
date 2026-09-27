import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@living-map/application";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupsDir,
  createBackup,
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  restoreBackup,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "../src";

let home: string;
let file: string;
let handle: SqliteHandle | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-backup-test-"));
  file = databaseFile(home);
});

afterEach(() => {
  if (handle?.sqlite.open) handle.close();
  handle = undefined;
  rmSync(home, { recursive: true, force: true });
});

function desktop(): SqliteHandle {
  handle = openDesktopDatabase(file);
  return handle;
}

const appOn = (h: SqliteHandle) =>
  createApplication({ store: createSqliteStore(h, uuidGenerator), clock: systemClock, ids: uuidGenerator });

describe("automatic backup before migration", () => {
  it("skips a brand-new (schema v0) database — nothing to lose yet", () => {
    desktop();
    expect(existsSync(backupsDir(home))).toBe(false);
  });
});

describe("manual backup + restore (mandatory Stage 1 integration test)", () => {
  it("create DB, write A, backup, write B, close, restore, reopen: state A comes back", () => {
    const h = desktop();
    const app = appOn(h);

    const probe = app.commands.createProbe(app.newContext("user-ui", "test"), { title: "state A" });
    if (!probe.ok) throw new Error(probe.error.message);

    const backupFile = createBackup(h.sqlite, home, "manual");
    expect(existsSync(backupFile)).toBe(true);

    const renamed = app.commands.renameProbe(app.newContext("user-ui", "test"), {
      id: probe.value.id,
      expectedVersion: 1,
      title: "state B",
    });
    expect(renamed.ok).toBe(true);
    expect(app.queries.getProbe({ id: probe.value.id })).toMatchObject({ value: { title: "state B" } });

    h.close();
    handle = undefined;

    restoreBackup(home, backupFile);

    const reopened = desktop();
    const reopenedApp = appOn(reopened);
    expect(reopenedApp.queries.getProbe({ id: probe.value.id })).toMatchObject({
      ok: true,
      value: { title: "state A", version: 1 },
    });
  });

  it("is a consistent snapshot: VACUUM INTO output opens and reads correctly under WAL", () => {
    const h = desktop();
    const app = appOn(h);
    for (let i = 0; i < 5; i++) {
      const r = app.commands.createProbe(app.newContext("user-ui", "test"), { title: `probe-${i}` });
      if (!r.ok) throw new Error(r.error.message);
    }
    const backupFile = createBackup(h.sqlite, home, "manual");
    h.close();
    handle = undefined;

    restoreBackup(home, backupFile);
    const list = appOn(desktop()).queries.listProbes();
    if (!list.ok) throw new Error("expected ok");
    expect(list.value).toHaveLength(5);
  });

  it("takes an un-rotated safety copy of what it replaces, so a bad restore stays recoverable", () => {
    const h = desktop();
    const app = appOn(h);
    const probe = app.commands.createProbe(app.newContext("user-ui", "test"), { title: "state A" });
    if (!probe.ok) throw new Error(probe.error.message);
    const backupFile = createBackup(h.sqlite, home, "manual");
    const renamed = app.commands.renameProbe(app.newContext("user-ui", "test"), {
      id: probe.value.id,
      expectedVersion: 1,
      title: "state B",
    });
    if (!renamed.ok) throw new Error(renamed.error.message);
    h.close();
    handle = undefined;

    restoreBackup(home, backupFile);

    const preRestoreBackups = readdirSync(backupsDir(home)).filter((f) => f.startsWith("pre-restore-"));
    expect(preRestoreBackups).toHaveLength(1);
    // Inspect the safety copy directly (read-only, no migrations) — it must hold state B, the
    // database restoreBackup replaced, independent of whatever the live restored DB now shows.
    const safetyCopy = new Database(join(backupsDir(home), preRestoreBackups[0] as string), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = safetyCopy.prepare("select title from probes where id = ?").get(probe.value.id) as
        | { title: string }
        | undefined;
      expect(row?.title).toBe("state B");
    } finally {
      safetyCopy.close();
    }
  });

  it("refuses to restore over a database another connection is actively writing to", () => {
    const h = desktop();
    const app = appOn(h);
    const probe = app.commands.createProbe(app.newContext("user-ui", "test"), { title: "x" });
    if (!probe.ok) throw new Error(probe.error.message);
    const backupFile = createBackup(h.sqlite, home, "manual");

    // Hold an active write transaction open on this same connection — restoreBackup must refuse
    // rather than silently corrupt a database mid-write (ARCHITECTURE §17).
    h.sqlite.exec("BEGIN IMMEDIATE");
    try {
      expect(() => restoreBackup(home, backupFile)).toThrow(/in use/i);
    } finally {
      h.sqlite.exec("ROLLBACK");
    }
  });

  it("refuses to restore a backup file that fails structural verification", () => {
    desktop();
    const dir = backupsDir(home);
    mkdirSync(dir, { recursive: true });
    const empty = join(dir, "manual-empty.sqlite");
    writeFileSync(empty, "");
    expect(() => restoreBackup(home, empty)).toThrow(/empty/i);

    const garbage = join(dir, "manual-garbage.sqlite");
    writeFileSync(garbage, "not a sqlite file");
    expect(() => restoreBackup(home, garbage)).toThrow();
  });

  it("throws rather than restoring from a backup file that does not exist", () => {
    desktop();
    expect(() => restoreBackup(home, join(backupsDir(home), "does-not-exist.sqlite"))).toThrow(/not found/i);
  });
});

describe("automatic backup rotation", () => {
  it("keeps only the most recent 10 automatic backups", () => {
    const h = desktop();
    for (let i = 0; i < 13; i++) createBackup(h.sqlite, home, "auto");
    const autoBackups = readdirSync(backupsDir(home)).filter((f) => f.startsWith("auto-"));
    expect(autoBackups).toHaveLength(10);
  });

  it("never rotates manual backups", () => {
    const h = desktop();
    for (let i = 0; i < 3; i++) createBackup(h.sqlite, home, "manual");
    for (let i = 0; i < 13; i++) createBackup(h.sqlite, home, "auto");
    const manualBackups = readdirSync(backupsDir(home)).filter((f) => f.startsWith("manual-"));
    expect(manualBackups).toHaveLength(3);
  });
});
