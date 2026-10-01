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
    sourceCaptureId: text("source_capture_id"),
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

/**
 * Continuous periods of real work (Stage 5). `ended_at IS NULL` = running; the partial unique index
 * makes "at most one running interval globally" a database fact, not just an application check.
 * `last_heartbeat_at` is technical crash-recovery metadata, updated outside the change log.
 */
export const workIntervals = sqliteTable(
  "work_intervals",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    lastHeartbeatAt: text("last_heartbeat_at").notNull(),
    timeZone: text("time_zone").notNull(),
  },
  (t) => [
    index("work_intervals_action_idx").on(t.actionId),
    index("work_intervals_started_idx").on(t.startedAt),
    uniqueIndex("work_intervals_one_running_idx").on(sql`(1)`).where(sql`${t.endedAt} IS NULL`),
    foreignKey({ columns: [t.actionId], foreignColumns: [actions.id] }).onDelete("cascade"),
  ],
);

/** Single-row user settings. The daily work target is a changeable setting, not a domain constant. */
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    dailyWorkTargetMinutes: integer("daily_work_target_minutes").notNull(),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
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
 * Universal `+` inputs (ARCHITECTURE §34, ADR-0007). `raw_text` is the untouched original — an
 * `UPDATE OF raw_text` trigger (custom migration) makes that a database fact. `result` is the
 * validated AI interpretation (JSON), kept apart from the original.
 */
export const captures = sqliteTable(
  "captures",
  {
    id: text("id").primaryKey(),
    rawText: text("raw_text").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    /** 'pending' | 'processing' | 'processed' | 'failed' (CaptureState). */
    state: text("state").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: text("last_error"),
    result: text("result", { mode: "json" }).$type<unknown>(),
    /** The Proposal created while processing this Capture (idempotent retry, ADR-0007). */
    proposalId: text("proposal_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("captures_state_idx").on(t.state, t.createdAt), index("captures_created_idx").on(t.createdAt)],
);

/** Memory v1 (ARCHITECTURE §35): immutable remembered items, separate from the raw Capture. */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    text: text("text").notNull(),
    sourceCaptureId: text("source_capture_id"),
    // M-A (ADR-0008): true only when `sourceCaptureId` came from the trusted Capture-job context, not
    // an AI-supplied argument from an untethered session — the signal Pattern provenance trusts.
    sourceCaptureVerified: integer("source_capture_verified", { mode: "boolean" }).notNull().default(false),
    linkedEntityIds: text("linked_entity_ids", { mode: "json" }).$type<string[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("memories_source_capture_idx").on(t.sourceCaptureId),
    foreignKey({ columns: [t.sourceCaptureId], foreignColumns: [captures.id] }),
  ],
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

/**
 * One closed period being learned from (Stage 7). The unique index makes "no duplicate Review for
 * the same period" a database fact, not just an application check (this stage's prompt §10).
 */
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    /** 'daily' | 'weekly' | 'seasonal' | 'yearly' (ReviewType). */
    type: text("type").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    timeZone: text("time_zone").notNull(),
    /** 'needs_ai' | 'processing' | 'ready' | 'no_useful_change' | 'failed' (ReviewStatus). */
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("reviews_type_period_idx").on(t.type, t.periodStart, t.periodEnd),
    index("reviews_type_status_idx").on(t.type, t.status),
  ],
);

/**
 * One thing the AI thinks should change future decisions, tied to the evidence it cited (Stage 7
 * §3/§11/§21). `text` is the AI's own draft and is never edited in place; a correction lives
 * separately in `correctedText` so the draft stays auditable.
 */
export const reviewFindings = sqliteTable(
  "review_findings",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id").notNull(),
    text: text("text").notNull(),
    evidenceRefs: text("evidence_refs", { mode: "json" }).$type<string[]>().notNull(),
    /** Canonical underlying-fact ids `evidenceRefs` resolve to (Stage 7 H2 fix) — the Pattern pipeline's join key for independence, never shown to the AI. */
    evidenceFactIds: text("evidence_fact_ids", { mode: "json" }).$type<string[]>().notNull(),
    suggestion: text("suggestion"),
    /** Short stable slug the AI gave a recurring theme, if any — the Pattern pipeline's join key. */
    patternKey: text("pattern_key"),
    /** 'proposed' | 'accepted' | 'corrected' | 'rejected' (ReviewFindingStatus). */
    status: text("status").notNull(),
    correctedText: text("corrected_text"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("review_findings_review_idx").on(t.reviewId),
    index("review_findings_pattern_key_idx").on(t.patternKey),
    foreignKey({ columns: [t.reviewId], foreignColumns: [reviews.id] }).onDelete("cascade"),
  ],
);

/**
 * «Похоже, это повторяется» (Stage 7 §14–16): surfaced once >= MIN_PATTERN_EVIDENCE accepted/corrected
 * findings from distinct review periods share a `patternKey`. `evidenceFindingIds` is a JSON array,
 * the same convention as `ordered_action_plans.ordered_action_ids` — its invariants live in the domain.
 */
export const patterns = sqliteTable(
  "patterns",
  {
    id: text("id").primaryKey(),
    /** The AI-given theme slug this candidate was surfaced for; at most one non-rejected row per key. */
    patternKey: text("pattern_key").notNull(),
    text: text("text").notNull(),
    /** 'candidate' | 'confirmed' | 'rejected' (PatternStatus). */
    status: text("status").notNull(),
    evidenceFindingIds: text("evidence_finding_ids", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [index("patterns_status_idx").on(t.status), index("patterns_key_idx").on(t.patternKey)],
);

/**
 * Durable planning context (Stage 7 §17–18): becomes active only through confirming a Pattern
 * (user-ui only — MCP/AI has no write path here at all, unlike every other write table).
 */
export const planningRules = sqliteTable(
  "planning_rules",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    /** 'active' | 'inactive' (PlanningRuleStatus). */
    status: text("status").notNull(),
    sourcePatternId: text("source_pattern_id").notNull(),
    createdAt: text("created_at").notNull(),
    deactivatedAt: text("deactivated_at"),
  },
  (t) => [
    index("planning_rules_status_idx").on(t.status),
    foreignKey({ columns: [t.sourcePatternId], foreignColumns: [patterns.id] }),
  ],
);
