import { z } from "zod";
import { ActionDtoSchema } from "./action";
import { CalendarSnapshotDtoSchema } from "./calendar";
import { ChangeLogEntryDtoSchema } from "./change-log";
import { GoodLifeConditionDtoSchema } from "./good-life-condition";
import { IntentionDtoSchema } from "./intention";
import { OrderedActionPlanDtoSchema } from "./plan";
import { ProposalDtoSchema } from "./proposal";
import { SeasonDtoSchema } from "./season";
import { StageDtoSchema } from "./stage";
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

/** The one Action CurrentActionSelector picked (ARCHITECTURE §26). Never present without a plan. */
export const CurrentActionDtoSchema = z.object({
  actionId: z.uuid(),
  reason: WhyNowReasonSchema,
  /** The plan's own rationale (ARCHITECTURE §28 strategic source) — per-action rationale is future work. */
  planRationale: z.string().nullable(),
});
export type CurrentActionDto = z.infer<typeof CurrentActionDtoSchema>;

/** The complete current-Intention view the UI needs in one query. */
export const CurrentViewDtoSchema = z.object({
  season: SeasonDtoSchema.nullable(),
  goodLifeConditions: z.array(GoodLifeConditionDtoSchema),
  intention: IntentionDtoSchema.nullable(),
  stages: z.array(StageWithActionsDtoSchema),
  orderedActionPlan: OrderedActionPlanDtoSchema.nullable(),
  /** Unfinished Actions the approved order does not cover (e.g. added manually afterwards). */
  unplannedActionIds: z.array(z.uuid()),
  pendingProposals: z.array(ProposalDtoSchema),
  /** null while there is no active Intention yet — a distinct state from `needsAiReplan`. */
  currentAction: CurrentActionDtoSchema.nullable(),
  /** True when an Intention/plan exists but no Action in it can be safely selected as `Сейчас`. */
  needsAiReplan: z.boolean(),
  calendarSnapshot: CalendarSnapshotDtoSchema,
  execution: ExecutionDtoSchema,
});
export type CurrentViewDto = z.infer<typeof CurrentViewDtoSchema>;

/** One coherent planning snapshot for an external AI (MCP `get_living_map_context`). */
export const PlanningContextDtoSchema = CurrentViewDtoSchema.extend({
  stateRevision: z.int().nonnegative(),
  /** Product meaning of each concept, so the AI does not have to guess from technical names. */
  meanings: z.record(z.string(), z.string()),
  recentHistory: z.array(ChangeLogEntryDtoSchema),
});
export type PlanningContextDto = z.infer<typeof PlanningContextDtoSchema>;
