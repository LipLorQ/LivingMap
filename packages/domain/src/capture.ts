import type { DomainResult, EntityId, Instant } from "./types";

export type CaptureState = "pending" | "processing" | "processed" | "failed";

/**
 * One raw `+` input (ARCHITECTURE §34). `rawText` is the original exactly as typed and never changes;
 * the AI's interpretation lives separately in `result` (and in Memories), never over the original.
 */
export type Capture = {
  readonly id: EntityId;
  readonly rawText: string;
  readonly source: "plus";
  readonly createdAt: Instant;
  readonly state: CaptureState;
  /** AI processing attempts so far (claims), for the bounded automatic retry at launch. */
  readonly attempts: number;
  /** Vendor-neutral failure kind of the last attempt, while `failed`. */
  readonly lastError: string | null;
  /** The validated AI result, once `processed`. */
  readonly result: unknown;
  /**
   * The Proposal the AI created while processing this Capture — set in the same transaction as the
   * Proposal itself, so it survives a crash before the result is recorded and makes a retry idempotent.
   */
  readonly proposalId: EntityId | null;
  readonly updatedAt: Instant;
};

export const CAPTURE_TEXT_MAX = 10_000;

/** Failed Captures are retried automatically at launch only below this many attempts; "Повторить" always works. */
export const CAPTURE_AUTO_RETRY_ATTEMPTS = 5;

export function createCapture(input: { id: EntityId; rawText: string; now: Instant }): DomainResult<Capture> {
  if (input.rawText.trim().length === 0) return { ok: false, reason: "Capture must not be empty" };
  if (input.rawText.length > CAPTURE_TEXT_MAX) {
    return { ok: false, reason: `Capture must be at most ${CAPTURE_TEXT_MAX} characters` };
  }
  return {
    ok: true,
    value: {
      id: input.id,
      rawText: input.rawText,
      source: "plus",
      createdAt: input.now,
      state: "pending",
      attempts: 0,
      lastError: null,
      result: null,
      proposalId: null,
      updatedAt: input.now,
    },
  };
}
