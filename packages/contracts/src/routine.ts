import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Text = z.string().trim().min(1).max(120);

export const RoutineKindSchema = z.enum(["morning", "evening"]);
export type RoutineKind = z.infer<typeof RoutineKindSchema>;

/** One item of a stable daily routine. Never an Action, never part of the work order, never work time. */
export const RoutineItemDtoSchema = z.object({
  id: Id,
  kind: RoutineKindSchema,
  text: z.string(),
  position: z.int().positive(),
  active: z.boolean(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoutineItemDto = z.infer<typeof RoutineItemDtoSchema>;

export const AddRoutineItemInputSchema = z.strictObject({ kind: RoutineKindSchema, text: Text });
export type AddRoutineItemInput = z.infer<typeof AddRoutineItemInputSchema>;

export const EditRoutineItemInputSchema = z
  .strictObject({ id: Id, expectedVersion: Version, text: Text.optional(), active: z.boolean().optional() })
  .refine((v) => v.text !== undefined || v.active !== undefined, "Nothing to change");
export type EditRoutineItemInput = z.infer<typeof EditRoutineItemInputSchema>;

export const RemoveRoutineItemInputSchema = z.strictObject({ id: Id, expectedVersion: Version });
export type RemoveRoutineItemInput = z.infer<typeof RemoveRoutineItemInputSchema>;

export const ReorderRoutineItemsInputSchema = z.strictObject({
  kind: RoutineKindSchema,
  orderedIds: z.array(Id).min(1),
});
export type ReorderRoutineItemsInput = z.infer<typeof ReorderRoutineItemsInputSchema>;
