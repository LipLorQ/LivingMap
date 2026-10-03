import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * Lifecycle of an Intention (a "project" of the current Season, Stage 8). Only `active` projects take
 * part in the Season and are limited to {@link MAX_ACTIVE_INTENTIONS}; `deferred` is a pause, and
 * `completed` / `released` are history.
 */
export type IntentionStatus = "active" | "deferred" | "completed" | "released";

/**
 * One real Intention. `desiredResult` describes what must become true — a concrete state, not a
 * percentage or score (DEVELOPMENT_PLAN §8 / this stage's prompt §8).
 */
export type Intention = {
  readonly id: EntityId;
  readonly title: string;
  readonly desiredResult: string;
  /** One short sentence: why this project serves the current Season goal. May be empty. */
  readonly whyItMatters: string;
  readonly status: IntentionStatus;
  /** Order among the active projects (lower = leads `Сейчас`). Only meaningful while `active`. */
  readonly position: number;
  /** When it was completed or released; null while open. */
  readonly closedAt: Instant | null;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const INTENTION_TITLE_MAX = 200;
export const DESIRED_RESULT_MAX = 2000;
export const INTENTION_WHY_MAX = 200;
/** A hard upper limit of simultaneously active Season projects. The healthy state is 1–2. */
export const MAX_ACTIVE_INTENTIONS = 3;

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

function normalizeWhy(why: string): DomainResult<string> {
  const trimmed = why.trim();
  if (trimmed.length > INTENTION_WHY_MAX) {
    return { ok: false, reason: `Why it matters must be at most ${INTENTION_WHY_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

/** Creates an `active` Intention; the caller has already checked the active-project limit. */
export function createIntention(input: {
  id: EntityId;
  title: string;
  desiredResult: string;
  whyItMatters?: string | undefined;
  position: number;
  now: Instant;
}): DomainResult<Intention> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const desiredResult = normalizeDesiredResult(input.desiredResult);
  if (!desiredResult.ok) return desiredResult;
  const why = normalizeWhy(input.whyItMatters ?? "");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      id: input.id,
      title: title.value,
      desiredResult: desiredResult.value,
      whyItMatters: why.value,
      status: "active",
      position: input.position,
      closedAt: null,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** `whyItMatters` left undefined keeps the current sentence (title/desiredResult edits never wipe it). */
export function editIntention(
  intention: Intention,
  input: { title: string; desiredResult: string; whyItMatters?: string | undefined },
  now: Instant,
): DomainResult<Intention> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const desiredResult = normalizeDesiredResult(input.desiredResult);
  if (!desiredResult.ok) return desiredResult;
  const why = normalizeWhy(input.whyItMatters ?? intention.whyItMatters);
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      ...intention,
      title: title.value,
      desiredResult: desiredResult.value,
      whyItMatters: why.value,
      version: intention.version + 1,
      updatedAt: now,
    },
  };
}

export type IntentionStatusChange =
  | { ok: true; value: Intention }
  | {
      ok: false;
      reason: string /** True when refused only because three projects are already active. */;
      limit: boolean;
    };

const ALLOWED_TRANSITIONS: Readonly<Record<IntentionStatus, readonly IntentionStatus[]>> = {
  active: ["deferred", "completed", "released"],
  deferred: ["active", "completed", "released"],
  // A mistaken «Завершить» / «Отпустить» is undone by bringing the project back as paused — never straight
  // to active, so reopening can never bypass the limit.
  completed: ["deferred"],
  released: ["deferred"],
};

export function activeIntentions(intentions: readonly Intention[]): Intention[] {
  return intentions
    .filter((i) => i.status === "active")
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

/** Position for a project joining the active ones: last in the order. */
export function nextActivePosition(intentions: readonly Intention[]): number {
  return intentions.filter((i) => i.status === "active").reduce((max, i) => Math.max(max, i.position), 0) + 1;
}

/** True while one more project may become active (completed/released/deferred ones never count). */
export function hasRoomForActive(intentions: readonly Intention[], excludingId?: EntityId): boolean {
  return intentions.filter((i) => i.status === "active" && i.id !== excludingId).length < MAX_ACTIVE_INTENTIONS;
}

/**
 * The only way an Intention changes lifecycle state. `intentions` is every Intention (the limit and the
 * next position are computed from it) so a caller cannot forget to check the limit.
 */
export function changeIntentionStatus(
  intentions: readonly Intention[],
  id: EntityId,
  to: IntentionStatus,
  now: Instant,
): IntentionStatusChange {
  const intention = intentions.find((i) => i.id === id);
  if (!intention) return { ok: false, reason: "Intention not found", limit: false };
  if (!ALLOWED_TRANSITIONS[intention.status].includes(to)) {
    return { ok: false, reason: `Cannot change a ${intention.status} Intention to ${to}`, limit: false };
  }
  if (to === "active" && !hasRoomForActive(intentions, id)) {
    return {
      ok: false,
      reason: `At most ${MAX_ACTIVE_INTENTIONS} Intentions may be active; complete, release or defer one first`,
      limit: true,
    };
  }
  const closed = to === "completed" || to === "released";
  return {
    ok: true,
    value: {
      ...intention,
      status: to,
      position: to === "active" ? nextActivePosition(intentions) : intention.position,
      closedAt: closed ? now : null,
      version: intention.version + 1,
      updatedAt: now,
    },
  };
}
