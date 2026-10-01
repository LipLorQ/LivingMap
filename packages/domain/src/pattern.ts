import type { DomainResult, EntityId, Instant } from "./types";

export type PatternStatus = "candidate" | "confirmed" | "rejected";

/**
 * "Похоже, это повторяется" (this stage's prompt §14–16): surfaced only once at least
 * {@link MIN_PATTERN_EVIDENCE} accepted/corrected ReviewFindings from distinct review periods share
 * the same `patternKey`. A single episode can never become a candidate; the application enforces the
 * "distinct periods" part (it needs to look the findings' Reviews up), this only enforces "enough,
 * distinct ids".
 */
export type Pattern = {
  readonly id: EntityId;
  /** The AI-given theme slug this candidate was surfaced for — at most one non-rejected Pattern per key (application layer). */
  readonly patternKey: string;
  readonly text: string;
  readonly status: PatternStatus;
  readonly evidenceFindingIds: readonly EntityId[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly resolvedAt: Instant | null;
  readonly resolvedBy: string | null;
};

export const PATTERN_TEXT_MAX = 1000;
export const MIN_PATTERN_EVIDENCE = 2;

export function createPatternCandidate(input: {
  id: EntityId;
  patternKey: string;
  text: string;
  evidenceFindingIds: readonly EntityId[];
  now: Instant;
}): DomainResult<Pattern> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, reason: "Pattern text must not be empty" };
  if (text.length > PATTERN_TEXT_MAX)
    return { ok: false, reason: `Pattern text must be at most ${PATTERN_TEXT_MAX} characters` };
  const evidence = [...new Set(input.evidenceFindingIds)];
  if (evidence.length < MIN_PATTERN_EVIDENCE) {
    return { ok: false, reason: `A pattern candidate needs at least ${MIN_PATTERN_EVIDENCE} distinct evidence items` };
  }
  return {
    ok: true,
    value: {
      id: input.id,
      patternKey: input.patternKey,
      text,
      status: "candidate",
      evidenceFindingIds: evidence,
      createdAt: input.now,
      updatedAt: input.now,
      resolvedAt: null,
      resolvedBy: null,
    },
  };
}

/** A still-pending candidate grows as further qualifying evidence arrives, instead of duplicating. */
export function growPatternCandidate(
  pattern: Pattern,
  evidenceFindingIds: readonly EntityId[],
  now: Instant,
): DomainResult<Pattern> {
  if (pattern.status !== "candidate") return { ok: false, reason: `Pattern is already ${pattern.status}` };
  const evidence = [...new Set(evidenceFindingIds)];
  if (evidence.length < MIN_PATTERN_EVIDENCE) {
    return { ok: false, reason: `A pattern candidate needs at least ${MIN_PATTERN_EVIDENCE} distinct evidence items` };
  }
  return { ok: true, value: { ...pattern, evidenceFindingIds: evidence, updatedAt: now } };
}

/** «Сделать правилом»: the user turns a candidate into an active PlanningRule (application layer). */
export function confirmPattern(pattern: Pattern, actor: string, now: Instant): DomainResult<Pattern> {
  if (pattern.status !== "candidate") return { ok: false, reason: `Pattern is already ${pattern.status}` };
  return { ok: true, value: { ...pattern, status: "confirmed", resolvedAt: now, resolvedBy: actor } };
}

/** «Не считать правилом». Evidence beyond what was rejected may still justify a fresh candidate (application layer). */
export function rejectPattern(pattern: Pattern, actor: string, now: Instant): DomainResult<Pattern> {
  if (pattern.status !== "candidate") return { ok: false, reason: `Pattern is already ${pattern.status}` };
  return { ok: true, value: { ...pattern, status: "rejected", resolvedAt: now, resolvedBy: actor } };
}

// ─── PlanningRule ───────────────────────────────────────────────────────────────────────────────

export type PlanningRuleStatus = "active" | "inactive";

/**
 * Durable context for future planning (this stage's prompt §17–18), visible to the AI only as plain
 * text alongside the rest of the planning context — never interpreted by local code, never a hard
 * constraint an existing typed mechanism doesn't already cover. Becomes active ONLY through
 * {@link confirmPattern}; MCP/AI has no path to create or activate one.
 */
export type PlanningRule = {
  readonly id: EntityId;
  readonly text: string;
  readonly status: PlanningRuleStatus;
  readonly sourcePatternId: EntityId;
  readonly createdAt: Instant;
  readonly deactivatedAt: Instant | null;
};

export function createPlanningRule(input: {
  id: EntityId;
  text: string;
  sourcePatternId: EntityId;
  now: Instant;
}): PlanningRule {
  return {
    id: input.id,
    text: input.text,
    status: "active",
    sourcePatternId: input.sourcePatternId,
    createdAt: input.now,
    deactivatedAt: null,
  };
}

export function deactivatePlanningRule(rule: PlanningRule, now: Instant): DomainResult<PlanningRule> {
  if (rule.status !== "active") return { ok: false, reason: "Planning rule is already inactive" };
  return { ok: true, value: { ...rule, status: "inactive", deactivatedAt: now } };
}
