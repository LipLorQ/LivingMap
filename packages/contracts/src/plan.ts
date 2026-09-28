import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
export const RationaleSchema = z.string().trim().min(1).max(4000);

export const OrderedActionPlanDtoSchema = z.object({
  id: Id,
  intentionId: Id,
  orderedActionIds: z.array(Id),
  rationale: z.string(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: Version,
  sourceRevision: z.int().nonnegative(),
});
export type OrderedActionPlanDto = z.infer<typeof OrderedActionPlanDtoSchema>;

/** SAFE WRITE (mcp-ai): reorder already-approved Actions of an already-approved route. */
export const ReorderExistingActionsInputSchema = z.strictObject({
  intentionId: Id,
  expectedPlanVersion: Version.describe("orderedActionPlan.version you read; a mismatch returns CONFLICT_RELOAD"),
  orderedActionIds: z
    .array(Id)
    .min(1)
    .max(200)
    .describe("Exactly every unfinished (open/blocked) Action of the Intention, each once, in the new order"),
  rationale: RationaleSchema.describe("Why this order makes sense now (shown to the user)"),
});
export type ReorderExistingActionsInput = z.infer<typeof ReorderExistingActionsInputSchema>;
