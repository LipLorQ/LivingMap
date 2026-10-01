import type { AiRunner } from "@living-map/application";

/**
 * Only one AI job — Capture or Review — runs at a time, system-wide (ADR-0007: "одна задача ИИ
 * одновременно"). `CaptureProcessor` and `ReviewProcessor` are each single-flight on their own, but
 * are otherwise independent queues; without this, a Capture and a Review could call the AI
 * concurrently. Wrapping the shared runner once here needs no change to either processor.
 */
export function serializeAiRunner(runner: AiRunner): AiRunner {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const result = chain.then(job, job); // run after the previous job finishes, regardless of its outcome
    chain = result.then(
      () => {},
      () => {}, // never let one job's rejection break the chain for the next
    );
    return result;
  };
  return {
    processCapture: (input, signal) => run(() => runner.processCapture(input, signal)),
    processReview: (evidence, signal) => run(() => runner.processReview(evidence, signal)),
  };
}
