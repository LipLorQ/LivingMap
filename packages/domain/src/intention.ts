import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * One real Intention. `desiredResult` describes what must become true — a concrete state, not a
 * percentage or score (DEVELOPMENT_PLAN §8 / this stage's prompt §8).
 */
export type Intention = {
  readonly id: EntityId;
  readonly title: string;
  readonly desiredResult: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const INTENTION_TITLE_MAX = 200;
export const DESIRED_RESULT_MAX = 2000;

function normalizeTitle(title: string): DomainResult<string> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Intention title must not be empty" };
  if (trimmed.length > INTENTION_TITLE_MAX) {
    return { ok: false, reason: `Intention title must be at most ${INTENTION_TITLE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

function normalizeDesiredResult(desiredResult: string): DomainResult<string> {
  const trimmed = desiredResult.trim();
  if (trimmed.length > DESIRED_RESULT_MAX) {
    return { ok: false, reason: `Desired result must be at most ${DESIRED_RESULT_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createIntention(input: {
  id: EntityId;
  title: string;
  desiredResult: string;
  now: Instant;
}): DomainResult<Intention> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const desiredResult = normalizeDesiredResult(input.desiredResult);
  if (!desiredResult.ok) return desiredResult;
  return {
    ok: true,
    value: {
      id: input.id,
      title: title.value,
      desiredResult: desiredResult.value,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function editIntention(
  intention: Intention,
  input: { title: string; desiredResult: string },
  now: Instant,
): DomainResult<Intention> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const desiredResult = normalizeDesiredResult(input.desiredResult);
  if (!desiredResult.ok) return desiredResult;
  return {
    ok: true,
    value: {
      ...intention,
      title: title.value,
      desiredResult: desiredResult.value,
      version: intention.version + 1,
      updatedAt: now,
    },
  };
}
