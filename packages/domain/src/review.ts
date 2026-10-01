import type { DomainResult, EntityId, Instant } from "./types";
import { addDays, localDate, startOfLocalDay, weekStart } from "./work";

export type ReviewType = "daily" | "weekly" | "seasonal" | "yearly";

/** needs_ai → processing → ready | no_useful_change | failed; failed → needs_ai (retry). */
export type ReviewStatus = "needs_ai" | "processing" | "ready" | "no_useful_change" | "failed";

/**
 * One closed period of lived experience LivingMap is learning from (Stage 7). Never the still-running
 * current period (this stage's prompt §5/§10). `timeZone` is the zone the period boundaries were
 * computed in, so history never shifts if the user later changes zones.
 */
export type Review = {
  readonly id: EntityId;
  readonly type: ReviewType;
  readonly periodStart: Instant;
  readonly periodEnd: Instant;
  readonly timeZone: string;
  readonly status: ReviewStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/** Mirrors CAPTURE_AUTO_RETRY_ATTEMPTS: bounded automatic retry at launch; "Повторить" always works. */
export const REVIEW_AUTO_RETRY_ATTEMPTS = 5;

export function createReview(input: {
  id: EntityId;
  type: ReviewType;
  periodStart: Instant;
  periodEnd: Instant;
  timeZone: string;
  now: Instant;
}): DomainResult<Review> {
  const startMs = new Date(input.periodStart).getTime();
  const endMs = new Date(input.periodEnd).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    return { ok: false, reason: "Review period must be non-empty" };
  }
  return {
    ok: true,
    value: {
      id: input.id,
      type: input.type,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      timeZone: input.timeZone,
      status: "needs_ai",
      attempts: 0,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export type DueReviewPeriod = { readonly periodStart: Instant; readonly periodEnd: Instant };

const toInstant = (date: string, timeZone: string): Instant => new Date(startOfLocalDay(date, timeZone)).toISOString();

export function yearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

export function addYears(date: string, years: number): string {
  const [y, rest] = [date.slice(0, 4), date.slice(4)];
  return `${String(Number(y) + years).padStart(4, "0")}${rest}`;
}

/** Just enough of the previous Review of this type to resume the cursor correctly. */
export type LastReviewPeriod = { readonly periodEnd: Instant; readonly timeZone: string };

/**
 * Successive closed periods of one calendar unit, oldest first, starting right after `last.periodEnd`
 * (or exactly the one most-recently-completed unit when this type has never been reviewed before —
 * so shipping Stage 7 does not suddenly fabricate years of backlog) and stopping before the unit
 * `now` falls in: the current, still-running period is never due (this stage's prompt §5/§10).
 *
 * `last.periodEnd` is interpreted in `last.timeZone` — the zone that period was actually computed
 * in — never the caller's current `timeZone`. The system timezone can change between launches (moved
 * laptop, changed OS setting); reinterpreting an old boundary in a new zone would shift it and could
 * make the next period start before, or reopen part of, one already reviewed.
 *
 * `maxPeriods` is a startup-safety bound (chosen bound, §10): normal use produces 0–1 periods; only a
 * long absence — or a corrupted clock — could approach it, and any remainder is simply picked up
 * again next launch, since `last.periodEnd` only advances as each period's Review row is created.
 */
function duePeriods(
  last: LastReviewPeriod | null,
  now: Instant,
  timeZone: string,
  maxPeriods: number,
  unitStart: (date: string) => string,
  advance: (date: string) => string,
  stepBack: (date: string) => string,
): DueReviewPeriod[] {
  const currentUnit = unitStart(localDate(now, timeZone));
  // `last.periodEnd` is itself the local-midnight instant the next unit starts at (in `last.timeZone`),
  // so formatting it in that same zone already yields the next unit's own civil date.
  const start = last ? unitStart(localDate(last.periodEnd, last.timeZone)) : stepBack(currentUnit);
  const periods: DueReviewPeriod[] = [];
  let cursor = start;
  // The very first resumed periodStart is `last.periodEnd` itself, verbatim — never recomputed via
  // `toInstant(cursor, timeZone)`. That would re-anchor the same civil date at local midnight in the
  // CURRENT zone, which — unlike `last.timeZone` — can be ahead of it, producing a periodStart BEFORE
  // `last.periodEnd` and reopening part of an already-reviewed period. Every following boundary chains
  // off the previous one's own computed end, so a catch-up run is also gap/overlap-free internally.
  let periodStart = last ? last.periodEnd : toInstant(cursor, timeZone);
  while (cursor < currentUnit && periods.length < maxPeriods) {
    const next = advance(cursor);
    const periodEnd = toInstant(next, timeZone);
    periods.push({ periodStart, periodEnd });
    cursor = next;
    periodStart = periodEnd;
  }
  return periods;
}

export function dueDailyPeriods(
  last: LastReviewPeriod | null,
  now: Instant,
  timeZone: string,
  maxPeriods = 60,
): DueReviewPeriod[] {
  return duePeriods(
    last,
    now,
    timeZone,
    maxPeriods,
    (d) => d,
    (d) => addDays(d, 1),
    (d) => addDays(d, -1),
  );
}

export function dueWeeklyPeriods(
  last: LastReviewPeriod | null,
  now: Instant,
  timeZone: string,
  maxPeriods = 26,
): DueReviewPeriod[] {
  return duePeriods(
    last,
    now,
    timeZone,
    maxPeriods,
    weekStart,
    (d) => addDays(d, 7),
    (d) => addDays(d, -7),
  );
}

export function dueYearlyPeriods(
  last: LastReviewPeriod | null,
  now: Instant,
  timeZone: string,
  maxPeriods = 5,
): DueReviewPeriod[] {
  return duePeriods(
    last,
    now,
    timeZone,
    maxPeriods,
    yearStart,
    (d) => addYears(d, 1),
    (d) => addYears(d, -1),
  );
}

// ─── ReviewFinding ──────────────────────────────────────────────────────────────────────────────

export type ReviewFindingStatus = "proposed" | "accepted" | "corrected" | "rejected";

/**
 * One thing the AI thinks should change future decisions (this stage's prompt §3/§11). `text` is the
 * AI's draft and is never edited in place — a correction is a separate field, so the draft stays
 * auditable. `evidenceRefs` are ids from the evidence pack this review was given; `rejected` findings
 * (and a `proposed` one nobody decided on) never become Pattern evidence.
 */
export type ReviewFinding = {
  readonly id: EntityId;
  readonly reviewId: EntityId;
  readonly text: string;
  readonly evidenceRefs: readonly string[];
  /**
   * Canonical underlying-fact ids the cited `evidenceRefs` actually trace back to (e.g. a work interval,
   * or a Capture a cited Memory was explicitly derived from) — application-computed from the evidence
   * pack's `factIds` at creation time, never invented here. Two findings sharing a factId are the same
   * lived fact wearing a different evidence-ref costume, not independent repetition (this stage's §14,
   * H2 fix).
   */
  readonly evidenceFactIds: readonly string[];
  /** A strategic change this implies, for the user to raise themselves via `+`; never applied automatically. */
  readonly suggestion: string | null;
  /** A short stable slug the AI gave this theme, if it looks likely to recur; null otherwise. */
  readonly patternKey: string | null;
  readonly status: ReviewFindingStatus;
  readonly correctedText: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const REVIEW_FINDING_TEXT_MAX = 1000;

export function createReviewFinding(input: {
  id: EntityId;
  reviewId: EntityId;
  text: string;
  evidenceRefs: readonly string[];
  evidenceFactIds: readonly string[];
  suggestion: string | null;
  patternKey: string | null;
  now: Instant;
}): DomainResult<ReviewFinding> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, reason: "Finding text must not be empty" };
  if (text.length > REVIEW_FINDING_TEXT_MAX) {
    return { ok: false, reason: `Finding text must be at most ${REVIEW_FINDING_TEXT_MAX} characters` };
  }
  if (input.evidenceRefs.length === 0) return { ok: false, reason: "Finding must cite at least one evidence item" };
  return {
    ok: true,
    value: {
      id: input.id,
      reviewId: input.reviewId,
      text,
      evidenceRefs: [...new Set(input.evidenceRefs)],
      evidenceFactIds: [...new Set(input.evidenceFactIds)],
      suggestion: input.suggestion?.trim() || null,
      patternKey: input.patternKey,
      status: "proposed",
      correctedText: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** «Всё верно»: the AI's draft is the accepted learning as is. */
export function acceptFinding(finding: ReviewFinding, now: Instant): DomainResult<ReviewFinding> {
  if (finding.status !== "proposed") return { ok: false, reason: `Finding is already ${finding.status}` };
  return { ok: true, value: { ...finding, status: "accepted", updatedAt: now } };
}

/**
 * The user's correction becomes the accepted learning; the AI's original draft stays in `text`.
 * `keepPattern` is an explicit user signal, never inferred: a wording-only correction (`keepPattern:
 * true`) leaves the AI's theme association intact, since the underlying fact is unchanged; the default
 * (`false`) treats the correction as substantive and drops `patternKey`, so a finding the user actually
 * disagreed with never keeps counting as evidence for a theme attached to the (now superseded) draft.
 * The system cannot reliably tell wording from substance on its own, so this stays a UI choice, not an
 * AI guess (M5).
 */
export function correctFinding(
  finding: ReviewFinding,
  text: string,
  keepPattern: boolean,
  now: Instant,
): DomainResult<ReviewFinding> {
  if (finding.status !== "proposed") return { ok: false, reason: `Finding is already ${finding.status}` };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Corrected text must not be empty" };
  if (trimmed.length > REVIEW_FINDING_TEXT_MAX) {
    return { ok: false, reason: `Corrected text must be at most ${REVIEW_FINDING_TEXT_MAX} characters` };
  }
  return {
    ok: true,
    value: {
      ...finding,
      status: "corrected",
      correctedText: trimmed,
      patternKey: keepPattern ? finding.patternKey : null,
      updatedAt: now,
    },
  };
}

/** Ignore: never becomes Pattern evidence. */
export function rejectFinding(finding: ReviewFinding, now: Instant): DomainResult<ReviewFinding> {
  if (finding.status !== "proposed") return { ok: false, reason: `Finding is already ${finding.status}` };
  return { ok: true, value: { ...finding, status: "rejected", updatedAt: now } };
}

/** The text that counts as this finding's accepted learning, once it has one; null while still `proposed`/`rejected`. */
export function acceptedFindingText(finding: ReviewFinding): string | null {
  if (finding.status === "accepted") return finding.text;
  if (finding.status === "corrected") return finding.correctedText;
  return null;
}
