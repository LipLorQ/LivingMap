import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * An ordered Stage inside one Intention. `isCurrent` is the smallest reversible representation
 * that makes "the current Stage" unambiguous: a boolean, uniqueness enforced per Intention
 * (checked below and by the application layer), rather than a general Stage state machine.
 */
export type Stage = {
  readonly id: EntityId;
  readonly intentionId: EntityId;
  readonly title: string;
  readonly position: number;
  readonly isCurrent: boolean;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const STAGE_TITLE_MAX = 200;

function normalizeTitle(title: string): DomainResult<string> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Stage title must not be empty" };
  if (trimmed.length > STAGE_TITLE_MAX) {
    return { ok: false, reason: `Stage title must be at most ${STAGE_TITLE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createStage(input: {
  id: EntityId;
  intentionId: EntityId;
  title: string;
  position: number;
  isCurrent: boolean;
  now: Instant;
}): DomainResult<Stage> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  return {
    ok: true,
    value: {
      id: input.id,
      intentionId: input.intentionId,
      title: title.value,
      position: input.position,
      isCurrent: input.isCurrent,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function editStageTitle(stage: Stage, title: string, now: Instant): DomainResult<Stage> {
  const normalized = normalizeTitle(title);
  if (!normalized.ok) return normalized;
  return { ok: true, value: { ...stage, title: normalized.value, version: stage.version + 1, updatedAt: now } };
}

/** Invariant checked by tests and relied on by the application layer's setCurrentStage command. */
export function isCurrentStageUnambiguous(stages: readonly Stage[]): boolean {
  return stages.filter((s) => s.isCurrent).length <= 1;
}
