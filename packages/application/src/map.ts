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
  effectiveActionOrder,
  evidenceForYears,
  evidenceSince,
  type ImpactItem,
  type Instant,
  type Intention,
  impactFingerprint,
  MAX_STRATEGY_YEAR,
  type OrderedActionPlan,
  orderStageActions,
  type ProjectSnapshot,
  projectProgress,
  type RoutineItem,
  type Season,
  type Stage,
  type StrategyState,
  seasonProgress,
  unplannedActionIds,
} from "@living-map/domain";
import { computeCurrentAction, type ProjectSelection, toPlanDto } from "./planning";
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
  readonly selection: ProjectSelection;
};

export type FocusState = {
  /** Active projects in their order, then paused ones. Completed/released ones are history. */
  readonly projects: ProjectState[];
  /** The project that owns `currentAction` (else the first active one). */
  readonly focus: ProjectState | undefined;
  readonly currentAction: CurrentActionDto | null;
  /** Active projects exist but nothing in any of their orders can be safely selected. */
  readonly needsAiReplan: boolean;
  /** The focus project's own current Stage holds no usable Action (the owner chose it; nothing is shown instead). */
  readonly emptyCurrentStage: { readonly intentionId: EntityId; readonly stageId: EntityId } | null;
  /** The owner's chosen work project when it is still usable (active, with an admissible Action or a chosen Stage), else null. */
  readonly selectedProjectId: EntityId | null;
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
 * here is WHICH project is asked first: running work pins its project; otherwise the project the owner chose
 * to work on (Stage 9, Day 1) when it is still usable; otherwise the owner's project order. Nothing is scored,
 * reordered or invented: a project with nothing admissible is simply skipped, and an unusable choice (paused,
 * finished, nothing admissible left) is ignored — deterministic fallback to the project order.
 */
export function loadFocusState(
  s: ProjectScope,
  now: Instant,
  runningActionId: EntityId | null,
  selectedIntentionId: EntityId | null = null,
): FocusState {
  const calendar: CalendarSnapshotDto = s.calendar.get();
  const projects = openProjects(s.intentions.list()).map((intention): ProjectState => {
    const stages = s.stages.listByIntention(intention.id);
    const actions = s.actions.listByStages(stages.map((stage) => stage.id));
    const plan = s.plans.findByIntention(intention.id);
    const selection =
      intention.status === "active"
        ? computeCurrentAction(intention, stages, actions, plan, calendar, now, runningActionId)
        : { currentAction: null, needsAiReplan: false, emptyStage: null };
    return { intention, stages, actions, plan, selection };
  });
  const active = projects.filter((p) => p.intention.status === "active");
  const pinned = runningActionId
    ? active.find((p) => p.actions.some((a) => a.id === runningActionId && a.status === "open"))
    : undefined;
  const selected = selectedIntentionId
    ? active.find(
        (p) =>
          p.intention.id === selectedIntentionId &&
          (p.selection.currentAction !== null || p.selection.emptyStage !== null),
      )
    : undefined;
  const focus = pinned ?? selected ?? active.find((p) => p.selection.currentAction !== null) ?? active[0];
  const currentAction = focus?.selection.currentAction ?? null;
  const emptyStage = focus?.selection.emptyStage ?? null;
  return {
    projects,
    focus,
    currentAction,
    needsAiReplan: active.length > 0 && currentAction === null && emptyStage === null,
    emptyCurrentStage: focus && emptyStage ? { intentionId: focus.intention.id, stageId: emptyStage.stageId } : null,
    selectedProjectId: selected && focus === selected ? selected.intention.id : null,
  };
}

export function toProjectViewDto(state: ProjectState): ProjectViewDto {
  const actionsByStage = new Map<string, ActionDto[]>();
  const byStage = new Map<string, Action[]>();
  for (const action of state.actions) byStage.set(action.stageId, [...(byStage.get(action.stageId) ?? []), action]);
  // The list the owner sees IS the order `Сейчас` follows (one order, never two): finished first, then the
  // approved order inside the Stage, then hand-added Actions by position.
  for (const [stageId, list] of byStage) {
    actionsByStage.set(stageId, orderStageActions(list, state.plan?.orderedActionIds ?? null).map(toActionDto));
  }
  // One order: the plan shown (and given to the AI) is the effective order — never a stored order that lags
  // behind what `Сейчас` follows.
  const effectivePlan = state.plan && {
    ...state.plan,
    orderedActionIds: effectiveActionOrder({
      stages: state.stages,
      actions: state.actions,
      orderedActionIds: state.plan.orderedActionIds,
    }),
  };
  // «Current» is where `Сейчас` really is: the Stage walked on to once the owner's Stage is finished counts, so the
  // badge never says one Stage while the screen works in another. No selection yet: the stored pointer.
  const workingStageId =
    state.selection.currentAction?.stageId ??
    state.selection.emptyStage?.stageId ??
    state.stages.find((stage) => stage.isCurrent)?.id;
  return {
    intention: toIntentionDto(state.intention),
    stages: state.stages.map((stage) => ({
      ...toStageDto(stage),
      isCurrent: stage.id === workingStageId,
      actions: actionsByStage.get(stage.id) ?? [],
    })),
    orderedActionPlan: effectivePlan ? toPlanDto(effectivePlan) : null,
    unplannedActionIds: effectivePlan ? unplannedActionIds(effectivePlan, state.actions) : [],
    needsAiReplan: state.selection.needsAiReplan,
    emptyCurrentStageId: state.selection.emptyStage?.stageId ?? null,
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
          // A labelled annual horizon («До следующего дня рождения») is not the calendar year: its end is the
          // owner's to name, so the calendar never declares it outdated.
          isCurrentYear: state.year.label !== null || state.year.year === state.currentYear,
          // Same for its evidence: not cut at 31 December, but everything recorded since the owner set it.
          evidence:
            state.year.label === null
              ? evidenceForYears({ startYear: state.year.year, endYear: state.year.year }, timeZone, facts)
              : evidenceForYears({ startYear: state.year.year, endYear: MAX_STRATEGY_YEAR }, timeZone, facts).filter(
                  (e) => e.at >= (state.year as NonNullable<typeof state.year>).createdAt,
                ),
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
