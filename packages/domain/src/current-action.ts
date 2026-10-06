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

/** What the project execution projection needs of a Stage / Action beyond the bare selector input. */
export type ExecutionStage = {
  readonly id: EntityId;
  readonly position: number;
  readonly isCurrent: boolean;
};
export type ExecutionAction = SelectableAction & { readonly stageId: EntityId; readonly position: number };

export type ProjectExecution =
  | {
      readonly status: "selected";
      readonly actionId: EntityId;
      readonly stageId: EntityId;
      readonly reason: WhyNowReason;
    }
  /** The owner's current Stage holds no usable Action: she stays in it (never a silent jump to another Stage). */
  | { readonly status: "stage-empty"; readonly stageId: EntityId }
  | { readonly status: "needs-ai-replan" };

/**
 * Order of one Stage's Actions: finished ones first (they only explain «previous-done»), then the approved
 * order restricted to this Stage, then Actions the plan does not cover (added by hand) in the owner's
 * display order. Never reaches outside the Stage.
 */
export function orderStageActions<T extends { id: EntityId; status: ActionStatus; position: number }>(
  stageActions: readonly T[],
  orderedActionIds: readonly EntityId[] | null,
): T[] {
  const planIndex = new Map((orderedActionIds ?? []).map((id, i) => [id, i] as const));
  const rank = (a: T) => (a.status === "done" ? -1 : (planIndex.get(a.id) ?? Number.POSITIVE_INFINITY));
  return [...stageActions].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.position - b.position || a.id.localeCompare(b.id);
  });
}

/**
 * THE one effective execution order of a project's unfinished Actions (Stage 9 Day 1 manual-order hotfix): the
 * owner's Stage order, and inside each Stage the stored order restricted to that Stage (Actions the stored
 * order does not know — added by hand — follow by position). `orderedActionIds` is only the baseline the
 * owner (or an AI proposal she accepted) wrote; this function is what every reader and writer agrees on, so
 * the stored order can never describe a different sequence than the one `Сейчас` follows.
 */
export function effectiveActionOrder(input: {
  readonly stages: readonly { readonly id: EntityId; readonly position: number }[];
  readonly actions: readonly (SelectableAction & { readonly stageId: EntityId; readonly position: number })[];
  readonly orderedActionIds: readonly EntityId[] | null;
}): EntityId[] {
  const stages = [...input.stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return stages.flatMap((stage) =>
    orderStageActions(
      input.actions.filter((a) => a.stageId === stage.id && a.status !== "done"),
      input.orderedActionIds,
    ).map((a) => a.id),
  );
}

/**
 * The single deterministic answer to «what is `Сейчас` in this project?» (ARCHITECTURE §26/§27, Stage 9 Day 1
 * hotfix). The owner's own structure decides WHERE: her explicit current Stage wins; without one the Stage
 * order she approved is followed. Only when that Stage is truly finished (it has Actions and all are done)
 * does the walk continue to the next Stage in her Stage order. WITHIN a Stage the order is the approved
 * order (restricted to the Stage), then hand-added Actions by position. An old AI order never decides which
 * Stage the owner is in. No approved route at all stays NeedsAIReplan (nothing to follow).
 */
export function selectProjectExecution(input: {
  readonly stages: readonly ExecutionStage[];
  readonly actions: readonly ExecutionAction[];
  readonly orderedActionIds: readonly EntityId[] | null;
  readonly now: Instant;
  readonly nextHardEventStart: Instant | null;
}): ProjectExecution {
  if (input.orderedActionIds === null) return { status: "needs-ai-replan" };
  const stages = [...input.stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const currentIndex = stages.findIndex((s) => s.isCurrent);
  const sequence = currentIndex < 0 ? stages : [...stages.slice(currentIndex), ...stages.slice(0, currentIndex)];

  const pick = (stageId: EntityId) => {
    const ordered = orderStageActions(
      input.actions.filter((a) => a.stageId === stageId),
      input.orderedActionIds,
    );
    return selectCurrentAction({
      orderedActionIds: ordered.map((a) => a.id),
      actions: ordered,
      now: input.now,
      nextHardEventStart: input.nextHardEventStart,
    });
  };

  const explicit = currentIndex >= 0 ? sequence[0] : undefined;
  let rest = sequence;
  if (explicit) {
    const own = input.actions.filter((a) => a.stageId === explicit.id);
    const finished = own.length > 0 && own.every((a) => a.status === "done");
    if (!finished) {
      const selection = pick(explicit.id);
      return selection.status === "selected"
        ? { status: "selected", actionId: selection.actionId, stageId: explicit.id, reason: selection.reason }
        : { status: "stage-empty", stageId: explicit.id };
    }
    rest = sequence.slice(1);
  }
  for (const stage of rest) {
    const selection = pick(stage.id);
    if (selection.status === "selected") {
      return { status: "selected", actionId: selection.actionId, stageId: stage.id, reason: selection.reason };
    }
  }
  return { status: "needs-ai-replan" };
}
