import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databaseFile } from "./paths";

/** `auto` runs before a risky migration and is rotated; `manual`/`pre-restore` are kept forever. */
export type BackupKind = "auto" | "manual" | "pre-restore";

const AUTO_BACKUP_LIMIT = 10;

export const backupsDir = (dataHome: string): string => join(dataHome, "backups");

// Guarantees a unique filename even for two backups requested within the same millisecond.
let sequence = 0;

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Consistent SQLite snapshot via `VACUUM INTO` (ARCHITECTURE §17): runs in SQLite's own implicit
 * read transaction, so it never captures a torn write — unlike copying the file's bytes directly.
 * Must be called outside any open transaction (SQLite rejects VACUUM INTO inside one).
 *
 * Written to a temporary file, fsynced, then renamed into its final name: a failed VACUUM (e.g.
 * a corrupted source page) or a crash never leaves a truncated/0-byte file under a name that
 * rotation or a future restore would treat as a real backup.
 */
export function createBackup(sqlite: Database.Database, dataHome: string, kind: BackupKind): string {
  const dir = backupsDir(dataHome);
  mkdirSync(dir, { recursive: true });
  const schemaVersion = sqlite.pragma("user_version", { simple: true }) as number;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${kind}-${stamp}-${(sequence++).toString(36)}-schema-v${schemaVersion}.sqlite`);
  const staging = `${file}.tmp`;
  try {
    sqlite.prepare("VACUUM INTO ?").run(staging);
    fsyncFile(staging);
    renameSync(staging, file);
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true });
    throw error;
  }
  if (kind === "auto") rotateAutoBackups(dir);
  return file;
}

function rotateAutoBackups(dir: string, limit = AUTO_BACKUP_LIMIT): void {
  const autoBackups = readdirSync(dir)
    .filter((name) => name.startsWith("auto-") && name.endsWith(".sqlite"))
    .sort();
  for (const stale of autoBackups.slice(0, Math.max(0, autoBackups.length - limit))) {
    // Best-effort: another process (antivirus, a DB viewer) holding an old backup open must
    // never block startup over a file we were only trying to clean up.
    try {
      rmSync(join(dir, stale), { force: true });
    } catch (error) {
      console.error(
        `[living-map] could not rotate stale backup ${stale}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}

/** Structural sanity check that a file is a usable Living Map database before restoring it. */
function verifyBackup(file: string): void {
  if (!existsSync(file)) throw new Error(`Backup not found: ${file}`);
  if (statSync(file).size === 0) throw new Error(`Backup file is empty: ${file}`);
  const probe = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version = probe.pragma("user_version", { simple: true }) as number;
    if (version === 0) throw new Error(`Backup has no applied schema (user_version=0): ${file}`);
    const check = probe.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`Backup failed integrity check: ${check}`);
  } finally {
    probe.close();
  }
}

/**
 * Best-effort guard that nothing else currently holds the database (ARCHITECTURE §17 requires
 * the working connection closed before restore). A full checkpoint only succeeds when no other
 * connection has an active read snapshot; an idle-but-open connection can still slip through on
 * POSIX, but on the shipped platform (Windows, DEVELOPMENT_PLAN §2) the OS itself refuses to
 * rename over a file another process still has open, which the `restoreBackup` rename below
 * surfaces as a clear error rather than silent data loss.
 */
function assertNotInUse(probe: Database.Database): void {
  probe.pragma("busy_timeout = 0");
  const rows = probe.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if ((rows[0]?.busy ?? 0) !== 0) {
    throw new Error("Database appears to be in use by another process (desktop and/or MCP); close them and retry.");
  }
}

/**
 * Restores `backupFile` over the working database (ARCHITECTURE §17). The caller's own
 * connection must already be closed; this function additionally refuses when another connection
 * still appears to hold the file. Always takes an un-rotated safety copy of the current database
 * first, so a bad restore (wrong backup picked, or a gap this function didn't catch) stays
 * recoverable. Schema compatibility of the restored file is left to the normal open path
 * (`openDesktopDatabase`), which already refuses a DB newer than the app.
 */
export function restoreBackup(dataHome: string, backupFile: string): void {
  verifyBackup(backupFile);
  const target = databaseFile(dataHome);

  if (existsSync(target)) {
    const probe = new Database(target);
    try {
      assertNotInUse(probe);
      createBackup(probe, dataHome, "pre-restore");
    } finally {
      probe.close();
    }
  }

  const staging = `${target}.restoring`;
  try {
    copyFileSync(backupFile, staging);
    fsyncFile(staging);
    for (const suffix of ["-wal", "-shm"]) {
      const sibling = `${target}${suffix}`;
      if (existsSync(sibling)) rmSync(sibling, { force: true });
    }
    renameSync(staging, target);
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true });
    throw error;
  }
}
