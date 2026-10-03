import type { CourseLevel } from "./course-change";
import type { Intention } from "./intention";
import type { Season, SeasonHistoryEntry } from "./season";
import type { DecadePlanItem, ThreeYearHorizon, YearDirection } from "./strategy";
import { yearRangesOverlap } from "./strategy";
import type { EntityId, Instant } from "./types";
import { localDate } from "./work";

/**
 * Pure read-model logic of the Full Map (Stage 8): the impact of a change of course, honest finite
 * progress, and real evidence. Nothing here invents a number: every figure is a count of explicit
 * entities, every evidence item is a recorded fact.
 */

export type ProjectSnapshot = {
  readonly intention: Intention;
  readonly stageCount: number;
  readonly unfinishedActionCount: number;
};

/** One layer or project that may need a second look after a change of course above it. */
export type ImpactItem = {
  readonly kind: "horizon" | "year" | "season" | "project";
  readonly id: EntityId;
  readonly version: number;
  readonly label: string;
  /** Projects only (0 otherwise). */
  readonly stageCount: number;
  readonly unfinishedActionCount: number;
};

export type StrategyState = {
  readonly decadePlan: readonly DecadePlanItem[];
  readonly horizon: ThreeYearHorizon | null;
  readonly year: YearDirection | null;
  readonly season: Season | null;
  /** Active and deferred projects — the ones that can still be affected. */
  readonly projects: readonly ProjectSnapshot[];
  readonly currentYear: number;
};

const OPEN_STATUSES = new Set(["active", "deferred"]);

/** The years the current strategic chain actually lives in: the horizon if set, else the year, else today. */
function chainYears(state: StrategyState): { startYear: number; endYear: number } {
  if (state.horizon) return { startYear: state.horizon.startYear, endYear: state.horizon.endYear };
  if (state.year) return { startYear: state.year.year, endYear: state.year.year };
  return { startYear: state.currentYear, endYear: state.currentYear };
}

/**
 * What a change of course at `level` may affect: every existing layer strictly below it, plus the
 * projects. A decade statement outside the current chain's years touches nothing below. Layers are
 * never rewritten by this — it only tells the owner what to look at.
 */
export function computeCourseImpact(
  state: StrategyState,
  level: CourseLevel,
  targetId: EntityId | null,
  /** Decade only: the years the statement is being moved to — a decade moving INTO the chain matters as much as one leaving it. */
  proposed?: { startYear: number; endYear: number },
): ImpactItem[] {
  // `targetId === null` means "the decade layer as a whole" (used for a statement that was since removed).
  if (level === "decade" && targetId !== null) {
    const target = state.decadePlan.find((d) => d.id === targetId);
    const chain = chainYears(state);
    if (!target) return [];
    if (!yearRangesOverlap(target, chain) && !(proposed && yearRangesOverlap(proposed, chain))) return [];
  }
  const items: ImpactItem[] = [];
  if (level === "decade" && state.horizon) {
    items.push({
      kind: "horizon",
      id: state.horizon.id,
      version: state.horizon.version,
      label: state.horizon.direction,
      stageCount: 0,
      unfinishedActionCount: 0,
    });
  }
  if ((level === "decade" || level === "horizon") && state.year) {
    items.push({
      kind: "year",
      id: state.year.id,
      version: state.year.version,
      label: state.year.direction,
      stageCount: 0,
      unfinishedActionCount: 0,
    });
  }
  if (level !== "season" && state.season) {
    items.push({
      kind: "season",
      id: state.season.id,
      version: state.season.version,
      label: state.season.focus,
      stageCount: 0,
      unfinishedActionCount: 0,
    });
  }
  for (const p of state.projects) {
    if (!OPEN_STATUSES.has(p.intention.status)) continue;
    items.push({
      kind: "project",
      id: p.intention.id,
      version: p.intention.version,
      label: p.intention.title,
      stageCount: p.stageCount,
      unfinishedActionCount: p.unfinishedActionCount,
    });
  }
  return items;
}

/**
 * Identity of the impact the owner was shown. A change of course is only applied against the very
 * impact it was previewed with — if anything below moved in between, the owner looks again.
 */
export function impactFingerprint(items: readonly ImpactItem[]): string {
  return items
    .map((i) => `${i.kind}:${i.id}@${i.version}:${i.stageCount}:${i.unfinishedActionCount}`)
    .sort()
    .join(",");
}

export type ProjectProgress = {
  /** 1-based position of the current Stage among the project's Stages; null without a current Stage. */
  readonly stageIndex: number | null;
  readonly stageCount: number;
  readonly actionsDone: number;
  readonly actionsTotal: number;
};

/** "Этап 3 из 7", "4 из 6 действий": counts of explicit Stages/Actions, never a percentage. */
export function projectProgress(
  stages: readonly { readonly position: number; readonly isCurrent: boolean }[],
  actions: readonly { readonly status: "open" | "blocked" | "done" }[],
): ProjectProgress {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const current = ordered.findIndex((s) => s.isCurrent);
  return {
    stageIndex: current === -1 ? null : current + 1,
    stageCount: ordered.length,
    actionsDone: actions.filter((a) => a.status === "done").length,
    actionsTotal: actions.length,
  };
}

/** "Завершено 2 из 3 проектов сезона". Released projects were dropped, not finished: they are not counted. */
export function seasonProgress(
  season: Pick<Season, "startedAt">,
  intentions: readonly Intention[],
): { completed: number; total: number } | null {
  const completed = intentions.filter(
    (i) => i.status === "completed" && i.closedAt !== null && i.closedAt >= season.startedAt,
  ).length;
  const open = intentions.filter((i) => OPEN_STATUSES.has(i.status)).length;
  return completed + open === 0 ? null : { completed, total: completed + open };
}

/** A recorded fact that something real was reached. Never an estimate. */
export type EvidenceItem = {
  readonly kind: "project_completed" | "season_closed";
  readonly text: string;
  readonly at: Instant;
};

const byTime = (a: EvidenceItem, b: EvidenceItem) => a.at.localeCompare(b.at);

/** Completed projects (and closed seasons) since an instant — the evidence of the current Season. */
export function evidenceSince(startedAt: Instant, intentions: readonly Intention[]): EvidenceItem[] {
  return intentions
    .filter((i) => i.status === "completed" && i.closedAt !== null && i.closedAt >= startedAt)
    .map((i): EvidenceItem => ({ kind: "project_completed", text: i.title, at: i.closedAt as Instant }))
    .sort(byTime);
}

/** Completed projects and closed seasons whose local date falls into the inclusive year range. */
export function evidenceForYears(
  range: { startYear: number; endYear: number },
  timeZone: string,
  facts: { intentions: readonly Intention[]; pastSeasons: readonly SeasonHistoryEntry[] },
): EvidenceItem[] {
  const inRange = (at: Instant) => {
    const year = Number(localDate(at, timeZone).slice(0, 4));
    return year >= range.startYear && year <= range.endYear;
  };
  const projects = facts.intentions
    .filter((i) => i.status === "completed" && i.closedAt !== null && inRange(i.closedAt))
    .map((i): EvidenceItem => ({ kind: "project_completed", text: i.title, at: i.closedAt as Instant }));
  const seasons = facts.pastSeasons
    .filter((s) => inRange(s.endedAt))
    .map((s): EvidenceItem => ({ kind: "season_closed", text: s.focus, at: s.endedAt }));
  return [...projects, ...seasons].sort(byTime);
}

export function currentYearOf(now: Instant, timeZone: string): number {
  return Number(localDate(now, timeZone).slice(0, 4));
}
