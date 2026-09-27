import { z } from "zod";

/** Read-side view of the existing change_log infrastructure (ARCHITECTURE §20), reused as this
 * stage's meaningful change history rather than a second, product-facing log. */
export const ChangeLogEntryDtoSchema = z.object({
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  actor: z.string(),
  commandType: z.string(),
  entityType: z.string(),
  // Usually a real entity's UUID, but a collection-wide change (e.g. reordering an unscoped list)
  // may log against a stable marker such as "all" instead of an arbitrary item's id.
  entityId: z.string(),
  summary: z.string(),
  stateRevision: z.int().nonnegative(),
});
export type ChangeLogEntryDto = z.infer<typeof ChangeLogEntryDtoSchema>;

export const ListChangeHistoryInputSchema = z.strictObject({ limit: z.int().positive().max(200).default(50) });
export type ListChangeHistoryInput = z.infer<typeof ListChangeHistoryInputSchema>;
