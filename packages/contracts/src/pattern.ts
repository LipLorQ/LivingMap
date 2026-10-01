import { z } from "zod";
import { ReviewEvidenceItemDtoSchema, ReviewTypeSchema } from "./review";

const Id = z.uuid();

export const PatternStatusSchema = z.enum(["candidate", "confirmed", "rejected"]);
export type PatternStatus = z.infer<typeof PatternStatusSchema>;

/**
 * One independent episode backing a Pattern — its finding's accepted text plus the concrete facts
 * cited, so the owner can see why the system thinks this repeats before confirming a rule (M4 fix).
 */
export const PatternSupportingFindingDtoSchema = z.object({
  id: Id,
  reviewId: Id,
  reviewType: ReviewTypeSchema,
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  text: z.string(),
  evidenceItems: z.array(ReviewEvidenceItemDtoSchema),
});
export type PatternSupportingFindingDto = z.infer<typeof PatternSupportingFindingDtoSchema>;

export const PatternDtoSchema = z.object({
  id: Id,
  patternKey: z.string(),
  text: z.string(),
  status: PatternStatusSchema,
  evidenceFindingIds: z.array(Id),
  supportingFindings: z.array(PatternSupportingFindingDtoSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.string().nullable(),
});
export type PatternDto = z.infer<typeof PatternDtoSchema>;

export const PlanningRuleStatusSchema = z.enum(["active", "inactive"]);
export type PlanningRuleStatus = z.infer<typeof PlanningRuleStatusSchema>;

export const PlanningRuleDtoSchema = z.object({
  id: Id,
  text: z.string(),
  status: PlanningRuleStatusSchema,
  sourcePatternId: Id,
  createdAt: z.iso.datetime(),
  deactivatedAt: z.iso.datetime().nullable(),
});
export type PlanningRuleDto = z.infer<typeof PlanningRuleDtoSchema>;

// ─── Inputs (desktop only, user-ui: MCP/AI can never confirm a Pattern or activate a rule) ────────

export const ListPatternCandidatesInputSchema = z.strictObject({ limit: z.int().positive().max(100).default(20) });
export type ListPatternCandidatesInput = z.infer<typeof ListPatternCandidatesInputSchema>;

export const ConfirmPatternInputSchema = z.strictObject({ id: Id });
export type ConfirmPatternInput = z.infer<typeof ConfirmPatternInputSchema>;

export const RejectPatternInputSchema = z.strictObject({ id: Id });
export type RejectPatternInput = z.infer<typeof RejectPatternInputSchema>;

export const ListPlanningRulesInputSchema = z.strictObject({ limit: z.int().positive().max(200).default(50) });
export type ListPlanningRulesInput = z.infer<typeof ListPlanningRulesInputSchema>;

export const DeactivatePlanningRuleInputSchema = z.strictObject({ id: Id });
export type DeactivatePlanningRuleInput = z.infer<typeof DeactivatePlanningRuleInputSchema>;
