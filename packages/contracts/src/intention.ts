import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Title = z.string().trim().min(1).max(200);
const DesiredResult = z.string().trim().max(2000);
/** One short sentence: why this project serves the current Season goal. */
const Why = z.string().trim().max(200);

export const IntentionStatusSchema = z.enum(["active", "deferred", "completed", "released"]);
export type IntentionStatus = z.infer<typeof IntentionStatusSchema>;

export const IntentionDtoSchema = z.object({
  id: Id,
  title: z.string(),
  desiredResult: z.string(),
  whyItMatters: z.string(),
  status: IntentionStatusSchema,
  position: z.int().nonnegative(),
  closedAt: z.iso.datetime().nullable(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type IntentionDto = z.infer<typeof IntentionDtoSchema>;

export const CreateIntentionInputSchema = z.strictObject({
  title: Title,
  desiredResult: DesiredResult,
  whyItMatters: Why.optional(),
});
export type CreateIntentionInput = z.infer<typeof CreateIntentionInputSchema>;

export const UpdateIntentionInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  title: Title,
  desiredResult: DesiredResult,
  /** Omitted = keep the current sentence. */
  whyItMatters: Why.optional(),
});
export type UpdateIntentionInput = z.infer<typeof UpdateIntentionInputSchema>;

/** Complete / release / pause / resume / bring back a project. Owner only; resuming is limited to three active. */
export const ChangeIntentionStatusInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  to: IntentionStatusSchema,
});
export type ChangeIntentionStatusInput = z.infer<typeof ChangeIntentionStatusInputSchema>;

/** The order of the active projects: the first one leads `Сейчас`. Must list exactly the active ones. */
export const ReorderProjectsInputSchema = z.strictObject({ orderedIds: z.array(Id).min(1) });
export type ReorderProjectsInput = z.infer<typeof ReorderProjectsInputSchema>;
