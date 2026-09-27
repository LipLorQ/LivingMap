import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Title = z.string().trim().min(1).max(200);
const DoneWhen = z.string().trim().max(500);
const BlockerReason = z.string().trim().min(1).max(300);

export const ActionStatusSchema = z.enum(["open", "blocked", "done"]);

export const BlockerDtoSchema = z.object({ reason: z.string(), blockedAt: z.iso.datetime() });
export type BlockerDto = z.infer<typeof BlockerDtoSchema>;

export const ActionDtoSchema = z.object({
  id: Id,
  stageId: Id,
  title: z.string(),
  doneWhen: z.string(),
  position: z.int().nonnegative(),
  status: ActionStatusSchema,
  blocker: BlockerDtoSchema.nullable(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type ActionDto = z.infer<typeof ActionDtoSchema>;

export const AddActionInputSchema = z.strictObject({ stageId: Id, title: Title, doneWhen: DoneWhen });
export type AddActionInput = z.infer<typeof AddActionInputSchema>;

export const EditActionInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  title: Title,
  doneWhen: DoneWhen,
});
export type EditActionInput = z.infer<typeof EditActionInputSchema>;

export const CompleteActionInputSchema = z.strictObject({ id: Id, expectedVersion: Version });
export type CompleteActionInput = z.infer<typeof CompleteActionInputSchema>;

export const BlockActionInputSchema = z.strictObject({ id: Id, expectedVersion: Version, reason: BlockerReason });
export type BlockActionInput = z.infer<typeof BlockActionInputSchema>;

export const UnblockActionInputSchema = z.strictObject({ id: Id, expectedVersion: Version });
export type UnblockActionInput = z.infer<typeof UnblockActionInputSchema>;

export const ReorderActionsInputSchema = z.strictObject({ stageId: Id, orderedIds: z.array(Id).min(1) });
export type ReorderActionsInput = z.infer<typeof ReorderActionsInputSchema>;
