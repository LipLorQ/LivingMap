import type Database from "better-sqlite3";
import { createBackup } from "./backup";
import { MIGRATIONS as GENERATED_MIGRATIONS } from "./migrations.generated";

export type Migration = { readonly statements: readonly string[] };

/** Schema version = number of applied migrations, stored in `PRAGMA user_version`. */
export const EXPECTED_SCHEMA_VERSION = GENERATED_MIGRATIONS.length;

export type SchemaStatus = { current: number; expected: number; compatible: boolean };

function currentVersion(sqlite: Database.Database): number {
  return sqlite.pragma("user_version", { simple: true }) as number;
}

export function inspectSchema(sqlite: Database.Database): SchemaStatus {
  const current = currentVersion(sqlite);
  return { current, expected: EXPECTED_SCHEMA_VERSION, compatible: current === EXPECTED_SCHEMA_VERSION };
}

/**
 * Applies `migrations[current..migrations.length)` atomically under an IMMEDIATE lock, so a
 * concurrently running MCP process never observes a half-migrated schema. The target version is
 * always `migrations.length` — the caller passes the *complete* migration list from v0, not a
 * partial slice, so there is no separate "target" that could disagree with it.
 *
 * FK-safe lifecycle (ADR-0003 risk): toggling `foreign_keys` is a documented SQLite no-op while
 * a transaction is open, so it is disabled on the *connection* before BEGIN — a per-migration
 * `PRAGMA foreign_keys=OFF` inside generated SQL would otherwise silently do nothing. Any foreign
 * key violation left by a table-recreation migration is caught by `foreign_key_check` before
 * commit rather than surfacing later as silent data corruption.
 */
export function applyMigrations(sqlite: Database.Database, migrations: readonly Migration[]): number {
  const targetVersion = migrations.length;
  sqlite.pragma("foreign_keys = OFF");
  try {
    const apply = sqlite.transaction(() => {
      const current = currentVersion(sqlite);
      if (current > targetVersion) {
        throw new Error(`Database schema v${current} is newer than this app (v${targetVersion})`);
      }
      for (const migration of migrations.slice(current)) {
        for (const statement of migration.statements) sqlite.exec(statement);
      }
      const violations = sqlite.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Migration left ${violations.length} foreign key violation(s); rolled back`);
      }
      sqlite.pragma(`user_version = ${targetVersion}`);
    });
    apply.immediate();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  return currentVersion(sqlite);
}

/**
 * Desktop composition root only (ARCHITECTURE §16, ADR-010): backs up before a risky migration,
 * then applies pending migrations. No backup on a brand-new (schema v0) database — there is
 * nothing to lose yet — nor when the schema is already newer than this app (that attempt is
 * going to fail outright below; backing up first would only feed automatic rotation with
 * identical copies of a database this app never touched).
 */
export function runMigrations(sqlite: Database.Database, dataHome: string): SchemaStatus {
  const before = inspectSchema(sqlite);
  if (before.current === before.expected) return before;
  if (before.current > 0 && before.current < before.expected) createBackup(sqlite, dataHome, "auto");
  applyMigrations(sqlite, GENERATED_MIGRATIONS);
  return inspectSchema(sqlite);
}
