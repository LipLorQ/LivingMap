import { z } from "zod";
import { ActionDtoSchema } from "./action";
import { CalendarSnapshotDtoSchema } from "./calendar";
import { ChangeLogEntryDtoSchema } from "./change-log";
import { GoodLifeConditionDtoSchema } from "./good-life-condition";
import { IntentionDtoSchema } from "./intention";
import { PlanningRuleDtoSchema } from "./pattern";
import { OrderedActionPlanDtoSchema } from "./plan";
import { ProposalDtoSchema } from "./proposal";
import { ReviewInboxDtoSchema } from "./review";
import { RoutineItemDtoSchema } from "./routine";
import { SeasonDtoSchema } from "./season";
import { StageDtoSchema } from "./stage";
import { StrategyDtoSchema } from "./strategy";
import { ExecutionDtoSchema } from "./work";

export const StageWithActionsDtoSchema = StageDtoSchema.extend({ actions: z.array(ActionDtoSchema) });
export type StageWithActionsDto = z.infer<typeof StageWithActionsDtoSchema>;

/** Local admissibility reason (ARCHITECTURE §28): why THIS action, not why the AI ordered it there. */
export const WhyNowReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first-in-plan") }),
  z.object({ kind: z.literal("previous-done") }),
  z.object({ kind: z.literal("previous-blocked") }),
  /** Work on it is running right now: the card never jumps away from running work. */
  z.object({ kind: z.literal("working") }),
]);
export type WhyNowReasonDto = z.infer<typeof WhyNowReasonSchema>;

/**
 * The one Action `Сейчас` points at (ARCHITECTURE §26): the first usable Action of the owner's current Stage.
 * Never present without an approved route.
 */
export const CurrentActionDtoSchema = z.object({
  actionId: z.uuid(),
  /** Where it lives, so the main screen can show «проект → этап → действие» without searching. */
  intentionId: z.uuid(),
  stageId: z.uuid(),
  reason: WhyNowReasonSchema,
  /** The plan's own rationale (ARCHITECTURE §28 strategic source) — per-action rationale is future work. */
  planRationale: z.string().nullable(),
});
export type CurrentActionDto = z.infer<typeof CurrentActionDtoSchema>;

/** Real, finite progress of one project: counts of explicit Stages and Actions — never a percentage. */
export const ProjectProgressDtoSchema = z.object({
  /** 1-based position of the current Stage; null without a current Stage. */
  stageIndex: z.int().positive().nullable(),
  stageCount: z.int().nonnegative(),
  actionsDone: z.int().nonnegative(),
  actionsTotal: z.int().nonnegative(),
});
export type ProjectProgressDto = z.infer<typeof ProjectProgressDtoSchema>;

/** One project (Intention) of the current Season with its own route, plan and honest progress. */
export const ProjectViewDtoSchema = z.object({
  intention: IntentionDtoSchema,
  stages: z.array(StageWithActionsDtoSchema),
  orderedActionPlan: OrderedActionPlanDtoSchema.nullable(),
  unplannedActionIds: z.array(z.uuid()),
  /** This project has a route or work but nothing in its order can be safely selected right now. */
  needsAiReplan: z.boolean(),
  /** The owner's current Stage holds no usable Action: the project has no «Сейчас» until she adds one. */
  emptyCurrentStageId: z.uuid().nullable(),
  progress: ProjectProgressDtoSchema,
});
export type ProjectViewDto = z.infer<typeof ProjectViewDtoSchema>;

/**
 * The complete current view the UI needs in one query. The Full Map and the main screen are two
 * renderings of this same state. `intention`, `stages`, `orderedActionPlan` and `unplannedActionIds`
 * describe the FOCUS project (the one that owns `currentAction`, else the first active one) and mirror
 * its entry in `projects`.
 */
export const CurrentViewDtoSchema = z.object({
  season: SeasonDtoSchema.nullable(),
  goodLifeConditions: z.array(GoodLifeConditionDtoSchema),
  intention: IntentionDtoSchema.nullable(),
  stages: z.array(StageWithActionsDtoSchema),
  orderedActionPlan: OrderedActionPlanDtoSchema.nullable(),
  /** Unfinished Actions the approved order does not cover (e.g. added manually afterwards). */
  unplannedActionIds: z.array(z.uuid()),
  /** Active projects in their order, then paused ones. Completed/released ones are history (strategy history query). */
  projects: z.array(ProjectViewDtoSchema),
  /** How many of the Season's project slots are taken — the limit is decided by the domain, not the UI. */
  projectSlots: z.object({ active: z.int().nonnegative(), max: z.int().positive() }),
  /** The far-to-near causal line above the projects. */
  strategy: StrategyDtoSchema,
  /** Stable daily routines (not work, not part of any order). Desktop only — not part of the AI planning context. */
  routines: z.array(RoutineItemDtoSchema),
  pendingProposals: z.array(ProposalDtoSchema),
  /**
   * The project the owner picked to work on (Stage 9, Day 1), when that choice is still usable — active and
   * with an admissible Action. null = no usable choice: `Сейчас` follows the owner's project order.
   */
  selectedProjectId: z.uuid().nullable(),
  /** null while there is no active Intention yet — a distinct state from `needsAiReplan`. */
  currentAction: CurrentActionDtoSchema.nullable(),
  /** True when active projects exist but no Action in any of them can be safely selected as `Сейчас`. */
  needsAiReplan: z.boolean(),
  /**
   * The focus project's current Stage — chosen by the owner — has no usable next Action. `Сейчас` then shows
   * that, never another Stage's work (`currentAction` is null, `needsAiReplan` false).
   */
  emptyCurrentStage: z.object({ intentionId: z.uuid(), stageId: z.uuid() }).nullable(),
  calendarSnapshot: CalendarSnapshotDtoSchema,
  execution: ExecutionDtoSchema,
  /** Compact «Анализ» nav badge (Stage 7); the full list/detail is its own query. */
  reviewInbox: ReviewInboxDtoSchema,
});
export type CurrentViewDto = z.infer<typeof CurrentViewDtoSchema>;

/** One coherent planning snapshot for an external AI (MCP `get_living_map_context`). */
export const PlanningContextDtoSchema = CurrentViewDtoSchema.omit({ routines: true }).extend({
  stateRevision: z.int().nonnegative(),
  /** Product meaning of each concept, so the AI does not have to guess from technical names. */
  meanings: z.record(z.string(), z.string()),
  recentHistory: z.array(ChangeLogEntryDtoSchema),
  /** Confirmed, still-active PlanningRules (Stage 7 §18/§24): explicit context, never a hard constraint. */
  activePlanningRules: z.array(PlanningRuleDtoSchema),
});
export type PlanningContextDto = z.infer<typeof PlanningContextDtoSchema>;
