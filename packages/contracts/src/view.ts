import { z } from "zod";
import { ActionDtoSchema } from "./action";
import { ChangeLogEntryDtoSchema } from "./change-log";
import { GoodLifeConditionDtoSchema } from "./good-life-condition";
import { IntentionDtoSchema } from "./intention";
import { OrderedActionPlanDtoSchema } from "./plan";
import { ProposalDtoSchema } from "./proposal";
import { SeasonDtoSchema } from "./season";
import { StageDtoSchema } from "./stage";

export const StageWithActionsDtoSchema = StageDtoSchema.extend({ actions: z.array(ActionDtoSchema) });
export type StageWithActionsDto = z.infer<typeof StageWithActionsDtoSchema>;

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
