import { z } from "zod";

const Id = z.uuid();

export const ReviewTypeSchema = z.enum(["daily", "weekly", "seasonal", "yearly"]);
export type ReviewType = z.infer<typeof ReviewTypeSchema>;

export const ReviewStatusSchema = z.enum(["needs_ai", "processing", "ready", "no_useful_change", "failed"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewFindingStatusSchema = z.enum(["proposed", "accepted", "corrected", "rejected"]);
export type ReviewFindingStatus = z.infer<typeof ReviewFindingStatusSchema>;

/** One fact behind a finding's `evidenceRefs`, resolved live for display — never raw internal ids/JSON (M4 fix). */
export const ReviewEvidenceItemDtoSchema = z.object({ id: z.string(), text: z.string() });
export type ReviewEvidenceItemDto = z.infer<typeof ReviewEvidenceItemDtoSchema>;

export const ReviewFindingDtoSchema = z.object({
  id: Id,
  reviewId: Id,
  text: z.string(),
  evidenceRefs: z.array(z.string()),
  /** The human-readable facts `evidenceRefs` point to, so the owner judges the finding, not a ref count (M4 fix). */
  evidenceItems: z.array(ReviewEvidenceItemDtoSchema),
  suggestion: z.string().nullable(),
  patternKey: z.string().nullable(),
  status: ReviewFindingStatusSchema,
  correctedText: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewFindingDto = z.infer<typeof ReviewFindingDtoSchema>;

export const ReviewDtoSchema = z.object({
  id: Id,
  type: ReviewTypeSchema,
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  timeZone: z.string(),
  status: ReviewStatusSchema,
  attempts: z.int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewDto = z.infer<typeof ReviewDtoSchema>;

export const ReviewWithFindingsDtoSchema = ReviewDtoSchema.extend({ findings: z.array(ReviewFindingDtoSchema) });
export type ReviewWithFindingsDto = z.infer<typeof ReviewWithFindingsDtoSchema>;

/** Compact «Разборы» nav badge: how many things wait for the user, never a full list. */
export const ReviewInboxDtoSchema = z.object({
  readyReviews: z.int().nonnegative(),
  patternCandidates: z.int().nonnegative(),
});
export type ReviewInboxDto = z.infer<typeof ReviewInboxDtoSchema>;

// ─── Inputs (desktop only; Reviews are never reachable from MCP) ──────────────────────────────────

export const ListReviewsInputSchema = z.strictObject({ limit: z.int().positive().max(200).default(30) });
export type ListReviewsInput = z.infer<typeof ListReviewsInputSchema>;

export const GetReviewInputSchema = z.strictObject({ id: Id });
export type GetReviewInput = z.infer<typeof GetReviewInputSchema>;

export const RetryReviewInputSchema = z.strictObject({ id: Id });
export type RetryReviewInput = z.infer<typeof RetryReviewInputSchema>;

export const AcceptReviewFindingInputSchema = z.strictObject({ id: Id });
export type AcceptReviewFindingInput = z.infer<typeof AcceptReviewFindingInputSchema>;

/**
 * `keepPattern` (default false) is the owner's explicit say on whether this correction is only wording
 * — the system cannot reliably tell that from a substantive disagreement, so it never guesses (M5 fix).
 */
export const CorrectReviewFindingInputSchema = z.strictObject({
  id: Id,
  text: z.string().trim().min(1).max(1000),
  keepPattern: z.boolean().default(false),
});
export type CorrectReviewFindingInput = z.infer<typeof CorrectReviewFindingInputSchema>;

export const RejectReviewFindingInputSchema = z.strictObject({ id: Id });
export type RejectReviewFindingInput = z.infer<typeof RejectReviewFindingInputSchema>;

// ─── AI review contract (ADR-0007 transport, new job kind; never free prose) ──────────────────────

export const ReviewFindingDraftSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe(
      "Russian. What should change future decisions — not a summary of what happened, not praise, not a diary entry.",
    ),
  evidenceRefs: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(20)
    .describe("ids copied exactly from the evidence pack you were given; never invented"),
  suggestion: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .describe("Optional: a strategic change this implies, for the user to raise themselves; you cannot apply it"),
  patternKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{3,60}$/)
    .nullable()
    .default(null)
    .describe(
      'Short stable slug for a recurring theme (e.g. "medical-appointments-eat-workday") if this looks likely to repeat across periods, else null',
    ),
});
export type ReviewFindingDraft = z.infer<typeof ReviewFindingDraftSchema>;

export const ReviewAiResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("no_useful_change") }),
  z
    .strictObject({ kind: z.literal("findings"), findings: z.array(ReviewFindingDraftSchema).min(1).max(8) })
    .describe("0–3 findings is the preference, not a hard cap"),
]);
export type ReviewAiResult = z.infer<typeof ReviewAiResultSchema>;

/**
 * The AI transport's structured-output tool schema requires a top-level object; a discriminated
 * union's JSON Schema is a root `oneOf` with none. This envelope is the transport-only wrapper — the
 * canonical, strict `ReviewAiResultSchema` is nested unchanged inside `result`, so semantic validation
 * is not weakened, only given an object root (see the AI adapter for why this is required, ADR-0007).
 */
export const ReviewAiTransportSchema = z.strictObject({ result: ReviewAiResultSchema });
export type ReviewAiTransport = z.infer<typeof ReviewAiTransportSchema>;
