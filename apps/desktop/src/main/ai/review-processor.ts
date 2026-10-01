import type { AiRunner, Application, ReviewRunOutcome } from "@living-map/application";

/**
 * Reviews (Stage 7): no background service (this stage's prompt §9). At launch, `start()` determines
 * due periods and recovers any interrupted/not-yet-exhausted row, then processes them one at a time —
 * exactly the same single-flight shape as {@link createCaptureProcessor}, never a second queue
 * framework. Every failure is that Review's alone: the queue moves on, nothing is stranded.
 */
export function createReviewProcessor(
  app: Application,
  runner: AiRunner,
  timeZone: () => string,
  report: (message: string) => void = () => {},
) {
  const system = () => app.newContext("system", "ipc");
  const quitting = new AbortController();
  let draining: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (!quitting.signal.aborted) {
      const claimed = app.commands.claimNextReview(system());
      if (!claimed.ok || !claimed.value) return;
      const review = claimed.value;
      const evidence = app.queries.getReviewEvidence({ id: review.id });
      // An empty period is the healthy common case (this stage's prompt §5): no real facts, nothing
      // to call the AI about. Skipping the call also keeps captures/reviews from competing for the
      // subscription's limits on an app that has been closed for a while (a long catch-up queues
      // many periods at once, most of which are typically empty for a single user).
      const outcome: ReviewRunOutcome =
        evidence.ok && evidence.value.items.length === 0
          ? { ok: true, result: { kind: "no_useful_change" } }
          : evidence.ok
            ? await runner
                .processReview(evidence.value, quitting.signal)
                .catch(() => ({ ok: false, failure: "failed" }) as const) // a runner must not throw; never get stuck if it does
            : { ok: false, failure: "failed" };
      // Quitting mid-run: leave it `processing`; the next launch recovers it back to `needs_ai`.
      if (quitting.signal.aborted) return;
      const finished = app.commands.finishReview(system(), { id: review.id, outcome });
      if (!finished.ok) report(`review finish failed: ${finished.error.code}`);
      // A failure is this Review's alone: it stays `failed` («Повторить», retried at launch) and the
      // queue moves on — one unavailable run must never strand the Reviews behind it.
      if (!outcome.ok) report(`review processing failed: ${outcome.failure}`); // a code only, never text or output
    }
  }

  return {
    /** Starts processing due/pending Reviews unless a run is already going (single flight). */
    kick(): void {
      draining ??= drain().finally(() => {
        draining = undefined;
      });
    },
    /** Launch: determine due periods, requeue an interrupted/not-yet-exhausted row, then start processing. */
    start(): void {
      const scheduled = app.commands.scheduleDueReviews(system(), { timeZone: timeZone() });
      if (!scheduled.ok) report(`review scheduling failed: ${scheduled.error.code}`);
      const recovered = app.commands.recoverReviews(system());
      if (!recovered.ok) report(`review recovery failed: ${recovered.error.code}`);
      this.kick();
    },
    /** App quit: kills the running AI process; nothing is written afterwards. */
    stop(): void {
      quitting.abort();
    },
    /** Resolves when the current run (if any) has finished — for tests. */
    idle: (): Promise<void> => draining ?? Promise.resolve(),
  };
}

export type ReviewProcessor = ReturnType<typeof createReviewProcessor>;
