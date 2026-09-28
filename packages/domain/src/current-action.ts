import type { ActionStatus } from "./action";
import type { EntityId, Instant } from "./types";

/**
 * Minimal Action projection the selector needs. `estimatedDurationMinutes` is optional because no
 * Action in this domain model carries a duration yet (Stage 4 §5: never invent one to make
 * filtering work) — the field exists so the hard-calendar-window check below is real and testable,
 * not so it fires on real data today.
 */
export type SelectableAction = {
  readonly id: EntityId;
  readonly status: ActionStatus;
  readonly estimatedDurationMinutes?: number | null;
};

export type WhyNowReason =
  | { readonly kind: "first-in-plan" }
  | { readonly kind: "previous-done" }
  | { readonly kind: "previous-blocked" };

export type CurrentActionSelection =
  | { readonly status: "selected"; readonly actionId: EntityId; readonly reason: WhyNowReason }
  | { readonly status: "needs-ai-replan" };

/**
 * Picks the first admissible Action from the AI-maintained order (ARCHITECTURE §26). Never
 * reorders, never inserts work outside `orderedActionIds`, never guesses: the hard-calendar-window
 * check only applies when an Action actually carries a known duration, so an unknown duration never
 * produces invented fit logic. No plan at all means there is no strategic order to follow —
 * NeedsAIReplan, not a local guess (ARCHITECTURE §27).
 */
export function selectCurrentAction(input: {
  readonly orderedActionIds: readonly EntityId[] | null;
  readonly actions: readonly SelectableAction[];
  readonly now: Instant;
  readonly nextHardEventStart: Instant | null;
}): CurrentActionSelection {
  if (input.orderedActionIds === null) return { status: "needs-ai-replan" };
  const byId = new Map(input.actions.map((a) => [a.id, a]));
  let sawDone = false;
  let sawBlocked = false;
  for (const id of input.orderedActionIds) {
    const action = byId.get(id);
    if (!action) continue;
    if (action.status === "done") {
      sawDone = true;
      continue;
    }
    if (action.status === "blocked") {
      sawBlocked = true;
      continue;
    }
    if (action.estimatedDurationMinutes != null && input.nextHardEventStart != null) {
      const minutesUntilEvent = minutesBetween(input.now, input.nextHardEventStart);
      if (minutesUntilEvent < action.estimatedDurationMinutes) continue;
    }
    return {
      status: "selected",
      actionId: action.id,
      reason: sawBlocked
        ? { kind: "previous-blocked" }
        : sawDone
          ? { kind: "previous-done" }
          : { kind: "first-in-plan" },
    };
  }
  return { status: "needs-ai-replan" };
}

function minutesBetween(from: Instant, to: Instant): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
}
