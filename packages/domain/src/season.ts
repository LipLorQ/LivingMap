import type { DomainResult, EntityId, Instant, Version } from "./types";

/** The user's current season: what this stretch of life is about right now. Singleton. */
export type Season = {
  readonly id: EntityId;
  readonly focus: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const SEASON_FOCUS_MAX = 500;

function normalizeFocus(focus: string): DomainResult<string> {
  const trimmed = focus.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Season focus must not be empty" };
  if (trimmed.length > SEASON_FOCUS_MAX) {
    return { ok: false, reason: `Season focus must be at most ${SEASON_FOCUS_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createSeason(input: { id: EntityId; focus: string; now: Instant }): DomainResult<Season> {
  const focus = normalizeFocus(input.focus);
  if (!focus.ok) return focus;
  return {
    ok: true,
    value: { id: input.id, focus: focus.value, version: 1, createdAt: input.now, updatedAt: input.now },
  };
}

export function updateSeasonFocus(season: Season, focus: string, now: Instant): DomainResult<Season> {
  const normalized = normalizeFocus(focus);
  if (!normalized.ok) return normalized;
  return { ok: true, value: { ...season, focus: normalized.value, version: season.version + 1, updatedAt: now } };
}
