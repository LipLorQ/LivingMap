import { z } from "zod";

const Id = z.uuid();

/** «Быт» (Stage 9, Day 1): a small one-off errand of everyday life. Never project work. */
export const HouseholdItemDtoSchema = z.object({
  id: Id,
  text: z.string(),
  status: z.enum(["active", "done"]),
  /** The «+» record the owner accepted it from, if any. */
  sourceCaptureId: Id.nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type HouseholdItemDto = z.infer<typeof HouseholdItemDtoSchema>;

export const HouseholdListDtoSchema = z.object({
  active: z.array(HouseholdItemDtoSchema),
  /** The most recently done ones — minimal history, newest first. */
  recentlyDone: z.array(HouseholdItemDtoSchema),
});
export type HouseholdListDto = z.infer<typeof HouseholdListDtoSchema>;

/** Owner only: «+ Добавить» in «Быт», or «Добавить в Быт» on an AI suggestion of a «+» record. */
export const AddHouseholdItemInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(300),
  /** Set when the owner accepts the AI's suggestion for this «+» record. */
  sourceCaptureId: Id.optional(),
});
export type AddHouseholdItemInput = z.infer<typeof AddHouseholdItemInputSchema>;

export const CompleteHouseholdItemInputSchema = z.strictObject({ id: Id });
export type CompleteHouseholdItemInput = z.infer<typeof CompleteHouseholdItemInputSchema>;
