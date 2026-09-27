import type Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.generated";

/** Schema version = number of applied migrations, stored in `PRAGMA user_version`. */
export const EXPECTED_SCHEMA_VERSION = MIGRATIONS.length;

export type SchemaStatus = { current: number; expected: number; compatible: boolean };

export function inspectSchema(sqlite: Database.Database): SchemaStatus {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  return { current, expected: EXPECTED_SCHEMA_VERSION, compatible: current === EXPECTED_SCHEMA_VERSION };
}

/**
 * Applies pending migrations atomically under an IMMEDIATE lock so a concurrently
 * running MCP process never observes a half-migrated schema.
 * Backup-before-risky-migration arrives with the "Local foundation" stage.
 */
export function runMigrations(sqlite: Database.Database): SchemaStatus {
  const apply = sqlite.transaction(() => {
    const current = sqlite.pragma("user_version", { simple: true }) as number;
    if (current > EXPECTED_SCHEMA_VERSION) {
      throw new Error(`Database schema v${current} is newer than this app (v${EXPECTED_SCHEMA_VERSION})`);
    }
    for (const migration of MIGRATIONS.slice(current)) {
      for (const statement of migration.statements) sqlite.exec(statement);
    }
    sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION}`);
  });
  apply.immediate();
  return inspectSchema(sqlite);
}
