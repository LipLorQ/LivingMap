import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Focus = z.string().trim().min(1).max(500);

export const SeasonDtoSchema = z.object({
  id: Id,
  focus: z.string(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SeasonDto = z.infer<typeof SeasonDtoSchema>;

export const CreateSeasonInputSchema = z.strictObject({ focus: Focus });
export type CreateSeasonInput = z.infer<typeof CreateSeasonInputSchema>;

/**
 * A write based on a previously read state must carry the version it saw (ARCHITECTURE §13).
 * `startsNewSeason` (default false — a wording edit) marks this as an actual season change, i.e. a
 * boundary the seasonal Review scheduler should treat this stretch of life as having closed on (Stage
 * 7 M2 fix); the owner decides, since the system cannot reliably tell "reworded" from "actually turned".
 */
export const UpdateSeasonFocusInputSchema = z.strictObject({
  expectedVersion: Version,
  focus: Focus,
  startsNewSeason: z.boolean().default(false),
});
export type UpdateSeasonFocusInput = z.infer<typeof UpdateSeasonFocusInputSchema>;
