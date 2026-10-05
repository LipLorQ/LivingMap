import { z } from "zod";

const Id = z.uuid();

/**
 * An owner-approved operational plan for ONE existing project (Stage 9, Day 1): designed outside the app
 * with the owner and applied deterministically. Owner/system only — no MCP tool exists for it.
 * The order is exactly the given one: Stage by Stage, Action by Action.
 */
export const ApprovedProjectPlanSchema = z.strictObject({
  intentionId: Id,
  /** Why/where this plan comes from, kept as the plan's rationale («План утверждён владельцем …»). */
  rationale: z.string().trim().min(1).max(4000),
  stages: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        actions: z
          .array(
            z.strictObject({
              title: z.string().trim().min(1).max(200),
              doneWhen: z.string().trim().max(500).default(""),
              /** Carry an existing Action of this project over (its history and work time stay with it). */
              existingActionId: Id.optional(),
            }),
          )
          .max(300),
      }),
    )
    .min(1)
    .max(50),
});
export type ApprovedProjectPlan = z.infer<typeof ApprovedProjectPlanSchema>;

/**
 * Applying needs the fingerprint of the dry run the owner actually looked at: if the project changed in
 * between (an action added, a proposal accepted…) or the plan file differs, nothing is applied.
 */
export const ReplaceProjectPlanInputSchema = ApprovedProjectPlanSchema.extend({
  expectedFingerprint: z.string().trim().min(1).max(64),
});
export type ReplaceProjectPlanInput = z.infer<typeof ReplaceProjectPlanInputSchema>;

/** What applying an approved plan does — shown before it is applied (dry run) and returned after. */
export const ProjectPlanReplacementDtoSchema = z.object({
  intentionId: Id,
  projectTitle: z.string(),
  stages: z.array(
    z.object({
      title: z.string(),
      isCurrent: z.boolean(),
      actions: z.array(z.object({ id: Id, title: z.string(), status: z.string(), carried: z.boolean() })),
    }),
  ),
  /** Previous Stages kept as history (no longer part of the route). */
  archivedStages: z.array(z.object({ id: Id, title: z.string() })),
  /** Previous unfinished Actions the approved plan does not carry: they stay as history, inactive. */
  leftBehindActions: z.array(z.object({ id: Id, title: z.string() })),
  /** Finished Actions of the previous structure that stay as history where they were. */
  keptDoneActions: z.number().int().nonnegative(),
  firstAction: z.object({ id: Id, title: z.string() }),
  /** Identity of exactly this plan against exactly this state of the project — pass it back to apply. */
  fingerprint: z.string(),
});
export type ProjectPlanReplacementDto = z.infer<typeof ProjectPlanReplacementDtoSchema>;
