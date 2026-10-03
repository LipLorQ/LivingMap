import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * The user's current season: what this stretch of life is about right now. Singleton. `focus` is the
 * Season's ONE main goal (Stage 8: «Главная цель»). `startedAt` is when this stretch began — a season
 * that really turns is archived as a {@link SeasonHistoryEntry} and the same row starts again.
 */
export type Season = {
  readonly id: EntityId;
  readonly focus: string;
  /** One short sentence: why this season moves the current year. May be empty. */
  readonly whyItMatters: string;
  readonly startedAt: Instant;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/** A season that has ended: only what cannot be derived elsewhere (the focus it had). */
export type SeasonHistoryEntry = {
  readonly id: EntityId;
  readonly focus: string;
  readonly whyItMatters: string;
  readonly startedAt: Instant;
  readonly endedAt: Instant;
};

export const SEASON_FOCUS_MAX = 500;
export const SEASON_WHY_MAX = 200;

function normalizeFocus(focus: string): DomainResult<string> {
  const trimmed = focus.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Season focus must not be empty" };
  if (trimmed.length > SEASON_FOCUS_MAX) {
    return { ok: false, reason: `Season focus must be at most ${SEASON_FOCUS_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

function normalizeWhy(why: string): DomainResult<string> {
  const trimmed = why.trim();
  if (trimmed.length > SEASON_WHY_MAX) {
    return { ok: false, reason: `Why it matters must be at most ${SEASON_WHY_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createSeason(input: {
  id: EntityId;
  focus: string;
  whyItMatters?: string | undefined;
  now: Instant;
}): DomainResult<Season> {
  const focus = normalizeFocus(input.focus);
  if (!focus.ok) return focus;
  const why = normalizeWhy(input.whyItMatters ?? "");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      id: input.id,
      focus: focus.value,
      whyItMatters: why.value,
      startedAt: input.now,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** MODE A — the same season, better words. `whyItMatters` undefined keeps the current sentence. */
export function rewordSeason(
  season: Season,
  input: { focus: string; whyItMatters?: string | undefined },
  now: Instant,
): DomainResult<Season> {
  const focus = normalizeFocus(input.focus);
  if (!focus.ok) return focus;
  const why = normalizeWhy(input.whyItMatters ?? season.whyItMatters);
  if (!why.ok) return why;
  return {
    ok: true,
    value: { ...season, focus: focus.value, whyItMatters: why.value, version: season.version + 1, updatedAt: now },
  };
}

/**
 * MODE B — the season really turns (change of course): the ending season is archived and the same row
 * starts again from `now`. Nothing below it is touched.
 */
export function startNewSeason(
  season: Season,
  input: { focus: string; whyItMatters?: string | undefined; historyId: EntityId },
  now: Instant,
): DomainResult<{ season: Season; ended: SeasonHistoryEntry }> {
  const focus = normalizeFocus(input.focus);
  if (!focus.ok) return focus;
  const why = normalizeWhy(input.whyItMatters ?? "");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      season: {
        ...season,
        focus: focus.value,
        whyItMatters: why.value,
        startedAt: now,
        version: season.version + 1,
        updatedAt: now,
      },
      ended: {
        id: input.historyId,
        focus: season.focus,
        whyItMatters: season.whyItMatters,
        startedAt: season.startedAt,
        endedAt: now,
      },
    },
  };
}
