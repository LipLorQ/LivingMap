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

/** A write based on a previously read state must carry the version it saw (ARCHITECTURE §13). */
export const UpdateSeasonFocusInputSchema = z.strictObject({ expectedVersion: Version, focus: Focus });
export type UpdateSeasonFocusInput = z.infer<typeof UpdateSeasonFocusInputSchema>;
