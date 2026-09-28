import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * The canonical AI-maintained execution order (ARCHITECTURE §25), one per Intention.
 * `ordered_action_ids` is a JSON array of Action UUIDs; its invariants live in the domain.
 */
export const orderedActionPlans = sqliteTable(
  "ordered_action_plans",
  {
    id: text("id").primaryKey(),
    intentionId: text("intention_id").notNull(),
    orderedActionIds: text("ordered_action_ids", { mode: "json" }).$type<string[]>().notNull(),
    rationale: text("rationale").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull(),
    sourceRevision: integer("source_revision").notNull(),
  },
  (t) => [
    uniqueIndex("ordered_action_plans_intention_idx").on(t.intentionId),
    foreignKey({ columns: [t.intentionId], foreignColumns: [intentions.id] }).onDelete("cascade"),
  ],
);

/** One event as stored in the snapshot below; shape mirrors `CalendarEventDto` (contracts). */
export type CalendarEventRow = {
  id: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
};

/**
 * LivingMap-owned read model of the external calendar (ARCHITECTURE §32), a singleton like `meta`.
 * No `version`/optimistic concurrency: it is never edited by two actors, only wholesale-replaced by
 * the desktop main process after a refresh — MCP and the UI only ever read it.
 */
export const calendarSnapshot = sqliteTable(
  "calendar_snapshot",
  {
    id: integer("id").primaryKey(),
    connected: integer("connected", { mode: "boolean" }).notNull(),
    syncedAt: text("synced_at"),
    source: text("source"),
    timeZone: text("time_zone"),
    events: text("events", { mode: "json" }).$type<CalendarEventRow[]>().notNull(),
    lastError: text("last_error"),
  },
  (t) => [check("calendar_snapshot_single_row", sql`${t.id} = 1`)],
);

/**
 * AI proposals (ARCHITECTURE §23). `payload` is JSON validated against the typed contract schema
 * for `kind` by the application on creation and again before being applied — never trusted as is.
 */
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    /** 'pending' | 'accepted' | 'rejected' | 'stale' (ProposalStatus). */
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    baseRevision: integer("base_revision").notNull(),
    baseFingerprint: text("base_fingerprint").notNull(),
    affectedEntityIds: text("affected_entity_ids", { mode: "json" }).$type<string[]>().notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    summary: text("summary").notNull().default(""),
    rationale: text("rationale").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [index("proposals_status_idx").on(t.status)],
);
