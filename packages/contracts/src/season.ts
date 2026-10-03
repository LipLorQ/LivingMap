import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Focus = z.string().trim().min(1).max(500);
const Why = z.string().trim().max(200);

export const SeasonDtoSchema = z.object({
  id: Id,
  /** The Season's one main goal («Главная цель»). */
  focus: z.string(),
  /** One short sentence: why this season moves the current year. */
  whyItMatters: z.string(),
  startedAt: z.iso.datetime(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SeasonDto = z.infer<typeof SeasonDtoSchema>;

export const CreateSeasonInputSchema = z.strictObject({ focus: Focus, whyItMatters: Why.optional() });
export type CreateSeasonInput = z.infer<typeof CreateSeasonInputSchema>;

/**
 * A write based on a previously read state must carry the version it saw (ARCHITECTURE §13).
 * `startsNewSeason` (default false — a wording edit) is Stage 8's MODE B for the Season: the owner says
 * the season actually turned. It closes this stretch of life (a seasonal-Review boundary, the old goal is
 * archived) and must carry the `impactFingerprint` of the impact the owner was shown (`previewCourseImpact`).
 * `whyItMatters` omitted = keep the current sentence.
 */
export const UpdateSeasonFocusInputSchema = z.strictObject({
  expectedVersion: Version,
  focus: Focus,
  whyItMatters: Why.optional(),
  startsNewSeason: z.boolean().default(false),
  impactFingerprint: z.string().max(4000).optional(),
});
export type UpdateSeasonFocusInput = z.infer<typeof UpdateSeasonFocusInputSchema>;
