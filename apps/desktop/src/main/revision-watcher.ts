import type { Application } from "@living-map/application";
import type { StateRevisionDto } from "@living-map/contracts";

/**
 * Cheap `state_revision` polling while the app is open — not a background service (ARCHITECTURE §15).
 * The interval is an implementation detail, not a product decision.
 */
export function watchStateRevision(
  app: Application,
  onChange: (change: StateRevisionDto) => void,
  intervalMs = 500,
): () => void {
  let last: number | undefined;
  const tick = () => {
    const r = app.queries.getStateRevision();
    if (!r.ok || r.value.stateRevision === last) return;
    last = r.value.stateRevision;
    onChange(r.value);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
