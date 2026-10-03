import type { EntityId, Instant, ReviewType } from "@living-map/domain";
import { dueDailyPeriods, dueWeeklyPeriods, dueYearlyPeriods } from "@living-map/domain";
import type { ReadScope, ReviewEvidenceItem, ReviewEvidencePack } from "./ports";

export type DueReview = { type: ReviewType; periodStart: Instant; periodEnd: Instant };

// `season.updateFocus` (a wording edit) is deliberately excluded: it never closes a season boundary
// on its own (M2 fix) — only `season.create` (the first season) and `season.changeSeason` (the owner
// explicitly saying this stretch of life turned into a new one, `application.ts` `updateSeasonFocus`)
// do.
const SEASON_COMMANDS = ["season.create", "season.changeSeason"];

/**
 * SeasonalReview has no fixed calendar length: a period is the closed interval between two
 * consecutive season-defining changes (this stage's prompt §7). The still-running season is never
 * due — there is no second boundary yet to close it. Bounded per launch like the calendar types.
 */
function dueSeasonalPeriods(s: Pick<ReadScope, "changeLog" | "reviews">, maxPeriods = 10): DueReview[] {
  const changes = s.changeLog.listByCommandTypes(SEASON_COMMANDS); // oldest first
  const periods: DueReview[] = [];
  for (let i = 0; i < changes.length - 1 && periods.length < maxPeriods; i++) {
    const periodStart = changes[i]?.timestamp as Instant;
    const periodEnd = changes[i + 1]?.timestamp as Instant;
    if (!s.reviews.existsForPeriod("seasonal", periodStart, periodEnd))
      periods.push({ type: "seasonal", periodStart, periodEnd });
  }
  return periods;
}

/** Every Review period due right now, across all four types (this stage's prompt §9/§10). */
export function computeDueReviews(
  s: Pick<ReadScope, "reviews" | "changeLog">,
  now: Instant,
  timeZone: string,
): DueReview[] {
  // The previous period's own stored zone, not the caller's current one (see `duePeriods` — the
  // system timezone can change between launches; reinterpreting an old boundary in a new zone would
  // shift it and risk reopening part of an already-reviewed period).
  const last = (type: ReviewType) => {
    const r = s.reviews.findLatestByType(type);
    return r ? { periodEnd: r.periodEnd, timeZone: r.timeZone } : null;
  };
  return [
    ...dueDailyPeriods(last("daily"), now, timeZone).map((p) => ({ type: "daily" as const, ...p })),
    ...dueWeeklyPeriods(last("weekly"), now, timeZone).map((p) => ({ type: "weekly" as const, ...p })),
    ...dueSeasonalPeriods(s),
    ...dueYearlyPeriods(last("yearly"), now, timeZone).map((p) => ({ type: "yearly" as const, ...p })),
  ];
}

/**
 * Commands already surfaced as their own, better-described evidence item below, too technical to be
 * a fact worth showing (work.* is superseded by the aggregated/per-interval work items below), or
 * Stage 7's own bookkeeping — excluded so a Review never "learns from" its own or another Review's
 * processing (self-referential evidence) and never sees the same fact twice.
 */
const REDUNDANT_OR_TECHNICAL_COMMANDS = new Set([
  "calendar.save",
  "capture.claim",
  "capture.failed",
  "capture.recover",
  "capture.create",
  "capture.processed",
  "memory.save",
  "memory.verify",
  "action.complete",
  "proposal.create",
  "proposal.accept",
  "proposal.reject",
  "proposal.stale",
  "work.start",
  "work.resume",
  "work.pause",
  "work.recover",
  "review.due",
  "review.claim",
  "review.processed",
  "review.failed",
  "review.recover",
  "review.retry",
  "review.findingCreated",
  "reviewFinding.accept",
  "reviewFinding.correct",
  "reviewFinding.reject",
  "pattern.candidate",
  "pattern.confirm",
  "pattern.reject",
  "planningRule.activate",
  "planningRule.deactivate",
  // Stage 8: daily routines are the owner's infrastructure, not a lived fact to learn from; the reminder
  // closing after a change of course is bookkeeping (the change itself is evidence).
  "routine.add",
  "routine.edit",
  "routine.remove",
  "routine.reorder",
  "strategy.courseChange.resolve",
]);

const actorLabel: Record<string, string> = { "user-ui": "Пользователь", "mcp-ai": "ИИ", system: "Система" };

/** Daily/weekly/seasonal/yearly: below this many days, one item per work interval; at/above, one summed item per Action. */
const AGGREGATE_WORK_SESSIONS_TYPES = new Set<ReviewType>(["weekly", "seasonal", "yearly"]);

/** A startup-safety bound against a pathological backlog (chosen bound, mirrors Review row creation). */
const MAX_EVIDENCE_ITEMS = 200;

/**
 * The closed set of facts the AI may cite for this Review (this stage's prompt §3/§21): built once
 * from real persisted records, never from the AI's own say-so. Every `evidenceRefs` entry the AI
 * later returns must be one of these `id`s — anything else is a fabricated/nonexistent reference and
 * is rejected before persistence.
 *
 * Category order matters once the bound below is hit: strategic/structural change first (what a
 * weekly/seasonal review most needs — "что реально изменилось"), routine facts last, so a cut never
 * silently drops the most important evidence for the longer review types.
 */
export function buildReviewEvidence(
  s: ReadScope,
  review: { id: EntityId; type: ReviewType; periodStart: Instant; periodEnd: Instant; timeZone: string },
): ReviewEvidencePack {
  const { periodStart, periodEnd } = review;
  const items: ReviewEvidenceItem[] = [];
  const actionTitle = (id: EntityId) => s.actions.findById(id)?.title ?? "действие";

  for (const entry of s.changeLog.listBetween(periodStart, periodEnd)) {
    if (REDUNDANT_OR_TECHNICAL_COMMANDS.has(entry.commandType)) continue;
    const id = `changelog:${entry.id}`;
    items.push({
      id,
      text: `${actorLabel[entry.actor] ?? entry.actor}: ${entry.commandType} (${entry.entityType}) — ${entry.summary}`,
      // A SAFE WRITE (e.g. plan.reorder) recorded from a Capture's AI job carries that link
      // (H-A fix, same convention as Memory/Proposal above) — same lived episode, not a second one.
      factIds: entry.sourceCaptureId ? [id, `capture:${entry.sourceCaptureId}`] : [id],
    });
  }

  // Computed up front (not just inside the work-interval section below) so a completed Action can carry
  // its own in-period work intervals as factIds too (M-B fix): completing an Action while its timer was
  // running and that same interval being cited via `worksession:`/`worktotal:` is one lived episode, not
  // two, even though `action:<id>` and `interval:<id>` are unrelated id spellings.
  const closedIntervalsForActions = s.work
    .listEndedSince(periodStart)
    .filter((i) => i.endedAt !== null && i.startedAt < periodEnd && (i.endedAt as string) > periodStart);
  const intervalIdsByAction = new Map<EntityId, EntityId[]>();
  for (const interval of closedIntervalsForActions) {
    intervalIdsByAction.set(interval.actionId, [...(intervalIdsByAction.get(interval.actionId) ?? []), interval.id]);
  }

  for (const action of s.actions.listCompletedBetween(periodStart, periodEnd)) {
    const id = `action:${action.id}`;
    items.push({
      id,
      text: `Завершено действие «${action.title}» (готово, когда: ${action.doneWhen})`,
      factIds: [id, ...(intervalIdsByAction.get(action.id) ?? []).map((i) => `interval:${i}`)],
    });
  }

  for (const proposal of s.proposals.listResolvedBetween(periodStart, periodEnd)) {
    const id = `proposal:${proposal.id}`;
    // A Proposal created from a `+` entry (Capture.proposalId, Stage 6) is the same lived episode as
    // that Capture, not a second one — same convention as the Capture→Memory link above (H2 fix).
    const sourceCapture = s.captures.findByProposalId(proposal.id);
    items.push({
      id,
      text: `Предложение ИИ (${proposal.kind}) — ${proposal.status}: ${proposal.summary}`,
      factIds: sourceCapture ? [id, `capture:${sourceCapture.id}`] : [id],
    });
  }

  for (const capture of s.captures.listCreatedBetween(periodStart, periodEnd)) {
    const id = `capture:${capture.id}`;
    items.push({ id, text: `Запись «+»: "${capture.rawText}"`, factIds: [id] });
  }

  for (const memory of s.memories.listCreatedBetween(periodStart, periodEnd)) {
    // A Memory the AI explicitly derived from a Capture within that Capture's own trusted processing
    // job (`sourceCaptureVerified`, M-A fix) is the same lived fact as that Capture, not a second one.
    // An AI-supplied `sourceCaptureId` from any other session (e.g. interactive Desktop-chat, ADR-0004)
    // is still a real Stage-6 association, shown to the user, but unverifiable here — the AI's own
    // say-so is not proof of the same underlying fact, so it stands on its own for Pattern purposes.
    const factIds = memory.sourceCaptureVerified
      ? [`memory:${memory.id}`, `capture:${memory.sourceCaptureId}`]
      : [`memory:${memory.id}`];
    items.push({ id: `memory:${memory.id}`, text: `Запомнено (${memory.type}): ${memory.text}`, factIds });
  }

  const closedIntervals = closedIntervalsForActions;
  if (AGGREGATE_WORK_SESSIONS_TYPES.has(review.type)) {
    const minutesByAction = new Map<EntityId, number>();
    for (const interval of closedIntervals) {
      const minutes =
        (new Date(interval.endedAt as string).getTime() - new Date(interval.startedAt).getTime()) / 60_000;
      minutesByAction.set(interval.actionId, (minutesByAction.get(interval.actionId) ?? 0) + minutes);
    }
    for (const [actionId, minutes] of minutesByAction) {
      items.push({
        id: `worktotal:${actionId}:${periodStart}`,
        text: `Работа над «${actionTitle(actionId)}» за период: ${Math.round(minutes)} мин`,
        // A weekly/seasonal/yearly total is not a new fact — it is the same underlying work intervals a
        // daily review would cite individually (H2 fix, CASE 1/4): carrying their ids as factIds is
        // what lets `finishReview` see through the aggregation to the real, possibly-shared, evidence.
        factIds: (intervalIdsByAction.get(actionId) ?? []).map((id) => `interval:${id}`),
      });
    }
  } else {
    for (const interval of closedIntervals) {
      const minutes = Math.round(
        (new Date(interval.endedAt as string).getTime() - new Date(interval.startedAt).getTime()) / 60_000,
      );
      items.push({
        id: `worksession:${interval.id}`,
        text: `Работа над «${actionTitle(interval.actionId)}»: ${minutes} мин`,
        factIds: [`interval:${interval.id}`],
      });
    }
  }

  return {
    reviewId: review.id,
    type: review.type,
    periodStart,
    periodEnd,
    timeZone: review.timeZone,
    items: items.slice(0, MAX_EVIDENCE_ITEMS),
    truncated: items.length > MAX_EVIDENCE_ITEMS,
    knownPatternThemes: s.reviewFindings.listDistinctPatternThemes(30),
  };
}
