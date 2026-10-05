import { z } from "zod";

const Id = z.uuid();

/** Raw `+` text limit; the original is stored exactly as typed (ARCHITECTURE §34). */
export const CAPTURE_TEXT_MAX = 10_000;

export const CaptureStateSchema = z.enum(["pending", "processing", "processed", "failed"]);
export type CaptureState = z.infer<typeof CaptureStateSchema>;

/** Why the AI could not process a Capture — vendor-neutral (ADR-0007). The Capture itself is always kept. */
export const AiFailureSchema = z.enum([
  "not_installed",
  "not_authenticated",
  "rate_limited",
  "offline",
  "timeout",
  "malformed",
  "mcp_failed",
  "failed",
]);
export type AiFailure = z.infer<typeof AiFailureSchema>;

/**
 * The AI's structured interpretation of one Capture (ADR-0007). Never free prose parsed by LivingMap:
 * the AI host must return exactly this, and it is validated again before anything is recorded.
 */
export const CaptureAiResultSchema = z
  .strictObject({
    kind: z
      .enum(["answer", "memory", "commitment", "proposal", "household", "no_operation"])
      .describe(
        "answer = you answered a question; memory = you saved something worth remembering; commitment = a dated obligation/event you saved as memory; proposal = you created a proposal or reordered actions; household = the message is clearly a one-off everyday errand (not project work, not a calendar event) — you suggest putting it into «Быт», the user decides; no_operation = nothing to do",
      ),
    reply: z
      .string()
      .trim()
      .min(1)
      .max(1500)
      .describe("Short reply to the user in Russian (1-4 sentences). No IDs, no technical terms."),
    proposalId: Id.nullable().describe(
      "id returned by create_route_proposal / propose_desired_result_change, else null",
    ),
    householdText: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .nullable()
      .optional()
      .describe(
        "Only for kind household: the errand as a short self-contained line in the user's words (e.g. «Записаться к стоматологу»); otherwise null",
      ),
  })
  // A «Быт» suggestion always carries its text. A stray text on any other kind is dropped, not fatal: the
  // JSON schema the AI host enforces cannot express this link, so a correct answer must not fail on it.
  .refine((r) => r.kind !== "household" || Boolean(r.householdText), {
    message: "householdText is required for kind household",
  })
  .transform(({ householdText, ...rest }) => (rest.kind === "household" ? { ...rest, householdText } : rest));
export type CaptureAiResult = z.infer<typeof CaptureAiResultSchema>;

export const MemoryTypeSchema = z.enum(["decision", "fact", "observation", "preference", "commitment", "idea", "note"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryDtoSchema = z.object({
  id: Id,
  type: MemoryTypeSchema,
  text: z.string(),
  sourceCaptureId: Id.nullable(),
  linkedEntityIds: z.array(Id),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type MemoryDto = z.infer<typeof MemoryDtoSchema>;

export const CaptureDtoSchema = z.object({
  id: Id,
  rawText: z.string(),
  source: z.enum(["plus"]),
  createdAt: z.iso.datetime(),
  state: CaptureStateSchema,
  attempts: z.int().nonnegative(),
  lastError: AiFailureSchema.nullable(),
  result: CaptureAiResultSchema.nullable(),
  /** The Proposal the AI created for this Capture, linked when it was created (survives a failed finish). */
  proposalId: Id.nullable(),
  /** Memories the AI saved from this Capture. */
  memories: z.array(MemoryDtoSchema),
  /** The «Быт» item the owner created from this Capture's suggestion, if any. */
  householdItemId: Id.nullable(),
});
export type CaptureDto = z.infer<typeof CaptureDtoSchema>;

// ─── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** Desktop only (user-ui): the universal `+`. */
export const SubmitCaptureInputSchema = z.strictObject({
  rawText: z
    .string()
    .max(CAPTURE_TEXT_MAX)
    .refine((s) => s.trim().length > 0, "Empty capture"),
});
export type SubmitCaptureInput = z.infer<typeof SubmitCaptureInputSchema>;

export const RetryCaptureInputSchema = z.strictObject({ id: Id });
export type RetryCaptureInput = z.infer<typeof RetryCaptureInputSchema>;

/** USER-only: forget a Memory. The source Capture stays exactly as typed. */
export const ForgetMemoryInputSchema = z.strictObject({ id: Id });
export type ForgetMemoryInput = z.infer<typeof ForgetMemoryInputSchema>;

export const ListCapturesInputSchema = z.strictObject({
  limit: z.int().positive().max(50).default(10),
  state: CaptureStateSchema.optional().describe("Only captures in this processing state"),
});
export type ListCapturesInput = z.infer<typeof ListCapturesInputSchema>;

export const SearchMemoryInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe("Words to look for (any language, case-insensitive, word-prefix match). Empty = most recent"),
  entityId: Id.optional().describe("Only memories linked to this Intention/Stage/Action/Proposal"),
  limit: z.int().positive().max(50).default(10),
});
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;

/** SAFE WRITE (mcp-ai): remember something; never changes strategy, order or `Сейчас`. */
export const SaveMemoryInputSchema = z.strictObject({
  type: MemoryTypeSchema,
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Self-contained, in the user's language; dates absolute (e.g. «30 сентября 2026, 15:00»)"),
  captureId: Id.nullable().default(null).describe("The Capture this memory comes from, if any"),
  linkedEntityIds: z.array(Id).max(10).default([]).describe("Existing Intention/Stage/Action/Proposal ids"),
});
export type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;
