import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Single-row technical metadata. `state_revision` is the global revision (ARCHITECTURE §14). */
export const meta = sqliteTable(
  "meta",
  {
    id: integer("id").primaryKey(),
    stateRevision: integer("state_revision").notNull(),
  },
  (t) => [check("meta_single_row", sql`${t.id} = 1`)],
);

/** Lightweight change log (ARCHITECTURE §20). Not event sourcing. */
export const changeLog = sqliteTable(
  "change_log",
  {
    id: text("id").primaryKey(),
    timestamp: text("timestamp").notNull(),
    actor: text("actor").notNull(),
    commandType: text("command_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    summary: text("summary").notNull(),
    stateRevision: integer("state_revision").notNull(),
  },
  (t) => [index("change_log_entity_idx").on(t.entityType, t.entityId)],
);

/** Spike-only aggregate table. */
export const probes = sqliteTable("probes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  version: integer("version").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
