import type {
  ActionDto,
  CalendarSnapshotDto,
  CourseChangeDto,
  CourseImpactDto,
  CurrentActionDto,
  ImpactItemDto,
  IntentionDto,
  ProjectViewDto,
  RoutineItemDto,
  SeasonDto,
  StageDto,
  StrategyDto,
  StrategyHistoryDto,
} from "@living-map/contracts";
import {
  type Action,
  activeIntentions,
  type Blocker,
  type CourseChange,
  type CourseLevel,
  computeCourseImpact,
  currentYearOf,
  decadesServedBy,
  type EntityId,
  evidenceForYears,
  evidenceSince,
  type ImpactItem,
  type Instant,
  type Intention,
  impactFingerprint,
  type OrderedActionPlan,
  type ProjectSnapshot,
  projectProgress,
  type RoutineItem,
  type Season,
  type Stage,
  type StrategyState,
  seasonProgress,
  unplannedActionIds,
} from "@living-map/domain";
import { computeCurrentAction, toPlanDto } from "./planning";
import type { ReadScope } from "./ports";

export const toSeasonDto = (season: Season): SeasonDto => ({ ...season });
export const toIntentionDto = (intention: Intention): IntentionDto => ({ ...intention });
export const toStageDto = (stage: Stage): StageDto => ({ ...stage });
const toBlockerDto = (blocker: Blocker | null) => (blocker ? { ...blocker } : null);
export const toActionDto = (action: Action): ActionDto => ({ ...action, blocker: toBlockerDto(action.blocker) });
export const toRoutineItemDto = (item: RoutineItem): RoutineItemDto => ({ ...item });

/** What the project state needs: everything a Stage 8 project, its order and the day's `Сейчас` are made of. */
export type ProjectScope = Pick<ReadScope, "intentions" | "stages" | "actions" | "plans" | "calendar" | "work">;

export type ProjectState = {
  readonly intention: Intention;
  readonly stages: Stage[];
  readonly actions: Action[];
  readonly plan: OrderedActionPlan | undefined;
  readonly selection: { currentAction: CurrentActionDto | null; needsAiReplan: boolean };
};

export type FocusState = {
  /** Active projects in their order, then paused ones. Completed/released ones are history. */
  readonly projects: ProjectState[];
  /** The project that owns `currentAction` (else the first active one). */
  readonly focus: ProjectState | undefined;
  readonly currentAction: CurrentActionDto | null;
  /** Active projects exist but nothing in any of their orders can be safely selected. */
  readonly needsAiReplan: boolean;
};

const OPEN = new Set(["active", "deferred"]);

/** Active projects by their order, then the paused ones by age. */
export function openProjects(intentions: readonly Intention[]): Intention[] {
  const paused = intentions
    .filter((i) => i.status === "deferred")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...activeIntentions(intentions), ...paused];
}

/**
 * The single place that decides `Сейчас` across projects (ARCHITECTURE §26/§27). Each project's own
 * AI-maintained order is walked by the unchanged deterministic CurrentActionSelector; the only thing added
 * here is WHICH project is asked first — the owner's project order, with running work pinning its project.
 * Nothing is scored, reordered or invented: a project with nothing admissible is simply skipped.
 */
export function loadFocusState(s: ProjectScope, now: Instant, runningActionId: EntityId | null): FocusState {
  const calendar: CalendarSnapshotDto = s.calendar.get();
  const projects = openProjects(s.intentions.list()).map((intention): ProjectState => {
    const stages = s.stages.listByIntention(intention.id);
    const actions = s.actions.listByStages(stages.map((stage) => stage.id));
    const plan = s.plans.findByIntention(intention.id);
    const selection =
      intention.status === "active"
        ? computeCurrentAction(intention, actions, plan, calendar, now, runningActionId)
        : { currentAction: null, needsAiReplan: false };
    return { intention, stages, actions, plan, selection };
  });
  const active = projects.filter((p) => p.intention.status === "active");
  const pinned = runningActionId
    ? active.find((p) => p.actions.some((a) => a.id === runningActionId && a.status === "open"))
    : undefined;
  const focus = pinned ?? active.find((p) => p.selection.currentAction !== null) ?? active[0];
  const currentAction = focus?.selection.currentAction ?? null;
  return { projects, focus, currentAction, needsAiReplan: active.length > 0 && currentAction === null };
}

export function toProjectViewDto(state: ProjectState): ProjectViewDto {
  const actionsByStage = new Map<string, ActionDto[]>();
  for (const action of state.actions) {
    const list = actionsByStage.get(action.stageId) ?? [];
    list.push(toActionDto(action));
    actionsByStage.set(action.stageId, list);
  }
  return {
    intention: toIntentionDto(state.intention),
    stages: state.stages.map((stage) => ({ ...toStageDto(stage), actions: actionsByStage.get(stage.id) ?? [] })),
    orderedActionPlan: state.plan ? toPlanDto(state.plan) : null,
    unplannedActionIds: state.plan ? unplannedActionIds(state.plan, state.actions) : [],
    needsAiReplan: state.selection.needsAiReplan,
    progress: projectProgress(state.stages, state.actions),
  };
}

// ─── Strategy: the far-to-near causal line ───────────────────────────────────────────────────────

export type StrategyScope = Pick<
  ReadScope,
  "decades" | "horizon" | "year" | "season" | "seasonHistory" | "courseChanges" | "intentions" | "stages" | "actions"
>;

export function snapshotOf(
  intention: Intention,
  stages: readonly Stage[],
  actions: readonly Action[],
): ProjectSnapshot {
  return {
    intention,
    stageCount: stages.length,
    unfinishedActionCount: actions.filter((a) => a.status !== "done").length,
  };
}

/** Active and paused projects with their stage/action counts — what a change of course could still touch. */
export function openProjectSnapshots(s: Pick<ReadScope, "intentions" | "stages" | "actions">): ProjectSnapshot[] {
  return s.intentions
    .list()
    .filter((i) => OPEN.has(i.status))
    .map((intention) => {
      const stages = s.stages.listByIntention(intention.id);
      return snapshotOf(intention, stages, s.actions.listByStages(stages.map((st) => st.id)));
    });
}

export function strategyState(
  s: Pick<ReadScope, "decades" | "horizon" | "year" | "season">,
  projects: readonly ProjectSnapshot[],
  now: Instant,
  timeZone: string,
): StrategyState {
  return {
    decadePlan: s.decades.list(),
    horizon: s.horizon.get() ?? null,
    year: s.year.get() ?? null,
    season: s.season.get() ?? null,
    projects,
    currentYear: currentYearOf(now, timeZone),
  };
}

const toImpactItemDto = (i: ImpactItem): ImpactItemDto => ({
  kind: i.kind,
  id: i.id,
  label: i.label,
  stageCount: i.stageCount,
  unfinishedActionCount: i.unfinishedActionCount,
});

export function toCourseImpactDto(level: CourseLevel, targetId: EntityId | null, items: ImpactItem[]): CourseImpactDto {
  return { level, targetId, items: items.map(toImpactItemDto), fingerprint: impactFingerprint(items) };
}

/**
 * A course change is only ever recorded when it affected something at that moment. For a decade the old
 * years are gone (moved or removed), so the reminder asks about the decade layer as a whole: everything
 * below the chain is still what the owner has to look at.
 */
function impactOfCourseChange(state: StrategyState, change: CourseChange): ImpactItem[] {
  return computeCourseImpact(state, change.level, change.level === "decade" ? null : change.targetId);
}

export function toStrategyDto(
  s: StrategyScope,
  state: StrategyState,
  intentions: readonly Intention[],
  timeZone: string,
): StrategyDto {
  const pastSeasons = s.seasonHistory.list();
  const facts = { intentions, pastSeasons };
  const season = state.season;
  const progress = season ? seasonProgress(season, intentions) : null;
  const openCourseChanges = s.courseChanges.listOpen().map(
    (c): CourseChangeDto => ({
      id: c.id,
      level: c.level,
      targetId: c.targetId,
      summary: c.summary,
      changedAt: c.changedAt,
      impact: impactOfCourseChange(state, c).map(toImpactItemDto),
    }),
  );
  return {
    currentYear: state.currentYear,
    decadePlan: state.decadePlan.map((d) => ({ ...d, evidence: evidenceForYears(d, timeZone, facts) })),
    horizon: state.horizon
      ? {
          ...state.horizon,
          decadeItemIds: decadesServedBy(state.horizon, state.decadePlan).map((d) => d.id),
          evidence: evidenceForYears(state.horizon, timeZone, facts),
        }
      : null,
    year: state.year
      ? {
          ...state.year,
          isCurrentYear: state.year.year === state.currentYear,
          evidence: evidenceForYears({ startYear: state.year.year, endYear: state.year.year }, timeZone, facts),
        }
      : null,
    seasonProgress: progress,
    seasonEvidence: season ? evidenceSince(season.startedAt, intentions) : [],
    openCourseChanges,
  };
}

export function toStrategyHistoryDto(
  s: Pick<ReadScope, "season" | "seasonHistory" | "intentions">,
): StrategyHistoryDto {
  const closed = s.intentions
    .list()
    .flatMap((i) =>
      (i.status === "completed" || i.status === "released") && i.closedAt !== null
        ? [
            {
              id: i.id,
              title: i.title,
              desiredResult: i.desiredResult,
              status: i.status,
              closedAt: i.closedAt,
            },
          ]
        : [],
    )
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const season = s.season.get();
  return {
    pastSeasons: s.seasonHistory.list().map((past) => ({
      ...past,
      closedProjects: closed.filter((c) => c.closedAt >= past.startedAt && c.closedAt < past.endedAt),
    })),
    currentSeasonClosedProjects: season ? closed.filter((c) => c.closedAt >= season.startedAt) : [],
  };
}
