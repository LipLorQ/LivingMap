import type { AiRunner, AiRunOutcome, Application } from "@living-map/application";

const ALREADY_PROPOSED = "Предложение по этой записи уже создано раньше — второе не создаю.";

/**
 * One AI job at a time, only while the app runs — no daemon (ADR-0007). Vendor-neutral: it knows the
 * AiRunner port, never the transport. Each Capture is committed before it can be claimed here; the AI
 * runs outside any write transaction; its outcome is recorded by a separate command from `processing`.
 */
export function createCaptureProcessor(
  app: Application,
  runner: AiRunner,
  report: (message: string) => void = () => {},
) {
  const system = () => app.newContext("system", "ipc");
  const quitting = new AbortController();
  let draining: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (!quitting.signal.aborted) {
      const claimed = app.commands.claimNextCapture(system());
      if (!claimed.ok || !claimed.value) return;
      const capture = claimed.value;
      // An earlier attempt already made this Capture's Proposal (then died before recording it): the
      // strategic effect exists, so it is not asked again — no second Proposal, no second AI run.
      const outcome: AiRunOutcome = capture.proposalId
        ? { ok: true, result: { kind: "proposal", reply: ALREADY_PROPOSED, proposalId: capture.proposalId } }
        : await runner
            .processCapture(
              { captureId: capture.id, rawText: capture.rawText, createdAt: capture.createdAt },
              quitting.signal,
            )
            .catch(() => ({ ok: false, failure: "failed" }) as const); // a runner must not throw; never get stuck if it does
      // Quitting mid-run: leave it `processing`; the next launch puts it back to `pending`.
      if (quitting.signal.aborted) return;
      const finished = app.commands.finishCapture(system(), { id: capture.id, outcome });
      if (!finished.ok) report(`capture finish failed: ${finished.error.code}`);
      // A failure is this Capture's alone: it is kept as `failed` («Повторить», retried at launch) and the
      // queue moves on — one unavailable run must never strand the Captures behind it.
      if (!outcome.ok) report(`capture processing failed: ${outcome.failure}`); // a code only, never text or output
    }
  }

  return {
    /** Starts processing pending Captures unless a run is already going (single flight). */
    kick(): void {
      draining ??= drain().finally(() => {
        draining = undefined;
      });
    },
    /** Launch: an interrupted or not-yet-exhausted failed Capture waits again, then processing starts. */
    start(): void {
      app.commands.recoverCaptures(system());
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

export type CaptureProcessor = ReturnType<typeof createCaptureProcessor>;
