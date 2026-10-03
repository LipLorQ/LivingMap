import type { DomainResult, EntityId, Instant } from "./types";

export type CourseLevel = "decade" | "horizon" | "year" | "season";

/**
 * The persisted fact "the owner changed course at this level, and the layers below have not been
 * reviewed yet" (Stage 8 §12). Nothing below is rewritten by it: it only keeps the offer
 * «Посмотреть, что нужно пересобрать» alive across restarts until the owner marks it done.
 */
export type CourseChange = {
  readonly id: EntityId;
  readonly level: CourseLevel;
  /** The strategic entity that changed (decade item / horizon / year / season id). */
  readonly targetId: EntityId;
  /** The short new statement, for display. */
  readonly summary: string;
  readonly changedAt: Instant;
  readonly resolvedAt: Instant | null;
};

export const COURSE_SUMMARY_MAX = 200;

export function createCourseChange(input: {
  id: EntityId;
  level: CourseLevel;
  targetId: EntityId;
  summary: string;
  now: Instant;
}): DomainResult<CourseChange> {
  const summary = input.summary.trim().slice(0, COURSE_SUMMARY_MAX);
  if (summary.length === 0) return { ok: false, reason: "Course change summary must not be empty" };
  return {
    ok: true,
    value: {
      id: input.id,
      level: input.level,
      targetId: input.targetId,
      summary,
      changedAt: input.now,
      resolvedAt: null,
    },
  };
}

export function resolveCourseChange(change: CourseChange, now: Instant): DomainResult<CourseChange> {
  if (change.resolvedAt !== null) return { ok: false, reason: "Course change is already resolved" };
  return { ok: true, value: { ...change, resolvedAt: now } };
}
