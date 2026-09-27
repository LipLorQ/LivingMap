import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Title = z.string().trim().min(1).max(200);

export const StageDtoSchema = z.object({
  id: Id,
  intentionId: Id,
  title: z.string(),
  position: z.int().nonnegative(),
  isCurrent: z.boolean(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StageDto = z.infer<typeof StageDtoSchema>;

export const AddStageInputSchema = z.strictObject({ intentionId: Id, title: Title });
export type AddStageInput = z.infer<typeof AddStageInputSchema>;

export const EditStageInputSchema = z.strictObject({ id: Id, expectedVersion: Version, title: Title });
export type EditStageInput = z.infer<typeof EditStageInputSchema>;

export const ReorderStagesInputSchema = z.strictObject({ intentionId: Id, orderedIds: z.array(Id).min(1) });
export type ReorderStagesInput = z.infer<typeof ReorderStagesInputSchema>;

export const SetCurrentStageInputSchema = z.strictObject({ intentionId: Id, stageId: Id });
export type SetCurrentStageInput = z.infer<typeof SetCurrentStageInputSchema>;
