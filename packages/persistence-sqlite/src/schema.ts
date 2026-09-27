import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Single-row technical metadata. `state_revision` is the global revision (ARCHITECTURE §14). */
export const meta = sqliteTable(
  "meta",
  {
    id: integer("id").primaryKey(),
    stateRevision: integer("state_revision").notNull(),
  },
  (t) => [check("meta_single_row", sql`${t.id} = 1`)],
);

/** Lightweight change log (ARCHITECTURE §20); also read back as this stage's change history. */
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

/** Singleton: the user's current Season. */
export const season = sqliteTable("season", {
  id: text("id").primaryKey(),
  focus: text("focus").notNull(),
  version: integer("version").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Flat, user-ordered list; not scoped to a Season or Intention (this stage's prompt §6). */
export const goodLifeConditions = sqliteTable("good_life_conditions", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  position: integer("position").notNull(),
  version: integer("version").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** At most one row exists in this stage; the schema itself already supports more (ARCHITECTURE §46). */
export const intentions = sqliteTable("intentions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  desiredResult: text("desired_result").notNull(),
  version: integer("version").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const stages = sqliteTable(
  "stages",
  {
    id: text("id").primaryKey(),
    intentionId: text("intention_id").notNull(),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull(),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("stages_intention_idx").on(t.intentionId),
    foreignKey({ columns: [t.intentionId], foreignColumns: [intentions.id] }).onDelete("cascade"),
  ],
);

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    stageId: text("stage_id").notNull(),
    title: text("title").notNull(),
    doneWhen: text("done_when").notNull(),
    position: integer("position").notNull(),
    /** 'open' | 'blocked' | 'done' (ActionStatus) — validated at the domain/contracts boundary. */
    status: text("status").notNull(),
    blockerReason: text("blocker_reason"),
    blockedAt: text("blocked_at"),
    completedAt: text("completed_at"),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("actions_stage_idx").on(t.stageId),
    foreignKey({ columns: [t.stageId], foreignColumns: [stages.id] }).onDelete("cascade"),
  ],
);
