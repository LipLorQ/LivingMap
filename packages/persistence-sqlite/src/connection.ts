import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { inspectSchema, runMigrations, type SchemaStatus } from "./migrate";
import * as schema from "./schema";

/** How long a connection waits for the other process's write lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

export type Db = BetterSQLite3Database<typeof schema>;

export type SqliteHandle = {
  readonly sqlite: Database.Database;
  readonly db: Db;
  close(): void;
};

/** Runs `step` on a fresh connection; closes it if anything throws (an open handle locks the file on Windows). */
function closingOnError<T>(sqlite: Database.Database, step: () => T): T {
  try {
    return step();
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function configure(sqlite: Database.Database): SqliteHandle {
  return closingOnError(sqlite, () => {
    // busy_timeout first so that even the WAL switch waits instead of failing under contention.
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = sqlite.pragma("journal_mode = WAL", { simple: true });
    if (mode !== "wal") throw new Error(`SQLite refused WAL mode (got "${String(mode)}")`);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("synchronous = NORMAL"); // durable across app crashes in WAL mode
    return { sqlite, db: drizzle({ client: sqlite, schema }), close: () => sqlite.close() };
  });
}

/**
 * Desktop composition root only: creates the database if needed and runs migrations.
 * The desktop app is the single migration owner (ARCHITECTURE §16, ADR-010).
 */
export function openDesktopDatabase(file: string): SqliteHandle {
  const dataHome = dirname(file);
  mkdirSync(dataHome, { recursive: true });
  // A 0-byte file is a legitimate empty SQLite database as far as `new Database()` is concerned,
  // so a genuinely missing file and a truncated/interrupted one look identical unless checked
  // here — silently treating the latter as "first launch" would erase whatever produced it.
  if (existsSync(file) && statSync(file).size === 0) {
    throw new Error(
      "Database file exists but is empty (interrupted write or restore). Refusing to silently start fresh.",
    );
  }
  const handle = configure(new Database(file));
  closingOnError(handle.sqlite, () => runMigrations(handle.sqlite, dataHome));
  return handle;
}

export type McpOpenResult =
  | { status: "ready"; handle: SqliteHandle; schema: SchemaStatus }
  | { status: "incompatible"; handle: SqliteHandle; schema: SchemaStatus }
  | { status: "missing" };

/**
 * MCP composition root: never creates the file and never migrates.
 * Caller must refuse to serve when the result is not `ready`.
 */
export function openMcpDatabase(file: string): McpOpenResult {
  if (!existsSync(file)) return { status: "missing" };
  const handle = configure(new Database(file, { fileMustExist: true }));
  const schemaStatus = closingOnError(handle.sqlite, () => inspectSchema(handle.sqlite));
  return { status: schemaStatus.compatible ? "ready" : "incompatible", handle, schema: schemaStatus };
}
