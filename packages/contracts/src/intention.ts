import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Title = z.string().trim().min(1).max(200);
const DesiredResult = z.string().trim().max(2000);

export const IntentionDtoSchema = z.object({
  id: Id,
  title: z.string(),
  desiredResult: z.string(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type IntentionDto = z.infer<typeof IntentionDtoSchema>;

export const CreateIntentionInputSchema = z.strictObject({ title: Title, desiredResult: DesiredResult });
export type CreateIntentionInput = z.infer<typeof CreateIntentionInputSchema>;

export const UpdateIntentionInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  title: Title,
  desiredResult: DesiredResult,
});
export type UpdateIntentionInput = z.infer<typeof UpdateIntentionInputSchema>;
