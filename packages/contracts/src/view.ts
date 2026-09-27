import { z } from "zod";
import { ActionDtoSchema } from "./action";
import { GoodLifeConditionDtoSchema } from "./good-life-condition";
import { IntentionDtoSchema } from "./intention";
import { SeasonDtoSchema } from "./season";
import { StageDtoSchema } from "./stage";

export const StageWithActionsDtoSchema = StageDtoSchema.extend({ actions: z.array(ActionDtoSchema) });
export type StageWithActionsDto = z.infer<typeof StageWithActionsDtoSchema>;

/** The complete current-Intention view the UI needs in one query (this stage's prompt §18). */
export const CurrentViewDtoSchema = z.object({
  season: SeasonDtoSchema.nullable(),
  goodLifeConditions: z.array(GoodLifeConditionDtoSchema),
  intention: IntentionDtoSchema.nullable(),
  stages: z.array(StageWithActionsDtoSchema),
});
export type CurrentViewDto = z.infer<typeof CurrentViewDtoSchema>;
