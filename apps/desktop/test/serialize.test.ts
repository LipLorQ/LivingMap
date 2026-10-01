import type { AiRunner } from "@living-map/application";
import { describe, expect, it } from "vitest";
import { serializeAiRunner } from "../src/main/ai/serialize";

const never = new AbortController().signal;

describe("serializeAiRunner", () => {
  it("runs a Capture and a Review job one at a time, never overlapping, even across the two kinds", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const slow = async (name: string): Promise<void> => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${name}`);
      running--;
    };
    const inner: AiRunner = {
      processCapture: async (input) => {
        await slow(`capture:${input.captureId}`);
        return { ok: true, result: { kind: "answer", reply: "x", proposalId: null } };
      },
      processReview: async (evidence) => {
        await slow(`review:${evidence.reviewId}`);
        return { ok: true, result: { kind: "no_useful_change" } };
      },
    };
    const runner = serializeAiRunner(inner);

    const capture = runner.processCapture({ captureId: "c1", rawText: "x", createdAt: "t" }, never);
    const review = runner.processReview(
      {
        reviewId: "r1",
        type: "daily",
        periodStart: "t",
        periodEnd: "t",
        timeZone: "UTC",
        items: [],
        truncated: false,
        knownPatternThemes: [],
      },
      never,
    );
    await Promise.all([capture, review]);

    expect(maxConcurrent).toBe(1); // never overlapped, whichever kind
    expect(order).toEqual(["start:capture:c1", "end:capture:c1", "start:review:r1", "end:review:r1"]); // capture queued first, runs first
  });

  it("one job rejecting does not break the chain for the next", async () => {
    const inner: AiRunner = {
      processCapture: () => Promise.reject(new Error("boom")),
      processReview: async () => ({ ok: true, result: { kind: "no_useful_change" } }),
    };
    const runner = serializeAiRunner(inner);
    await expect(runner.processCapture({ captureId: "c1", rawText: "x", createdAt: "t" }, never)).rejects.toThrow(
      "boom",
    );
    await expect(
      runner.processReview(
        {
          reviewId: "r1",
          type: "daily",
          periodStart: "t",
          periodEnd: "t",
          timeZone: "UTC",
          items: [],
          truncated: false,
          knownPatternThemes: [],
        },
        never,
      ),
    ).resolves.toEqual({ ok: true, result: { kind: "no_useful_change" } });
  });
});
