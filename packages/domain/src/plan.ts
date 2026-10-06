import type { ActionStatus } from "./action";
import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * The canonical AI-maintained execution order of one Intention (ARCHITECTURE §25): "given the
 * currently known reality, this is the order in which it makes sense to move". Not a calendar.
 * The only strategic ordering source; Stage/Action `position` is display order inside a Stage.
 */
export type OrderedActionPlan = {
  readonly id: EntityId;
  readonly intentionId: EntityId;
  readonly orderedActionIds: readonly EntityId[];
  readonly rationale: string;
  /** Author of the current order (each version is a whole new order). */
  readonly createdBy: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly version: Version;
  /** state_revision of the world this order was reasoned against. */
  readonly sourceRevision: number;
};

export const PLAN_RATIONALE_MAX = 4000;

/**
 * A plan order must be exactly a permutation of the Intention's unfinished (open/blocked) Actions:
 * no duplicates, nothing foreign, nothing done, nothing unfinished left out.
 */
export function validateActionOrder(
  orderedIds: readonly EntityId[],
  actions: readonly { readonly id: EntityId; readonly status: ActionStatus }[],
): DomainResult<EntityId[]> {
  if (orderedIds.length === 0) return { ok: false, reason: "Order must contain at least one action" };
  if (new Set(orderedIds).size !== orderedIds.length) return { ok: false, reason: "Order contains duplicate actions" };
  const byId = new Map(actions.map((a) => [a.id, a]));
  for (const id of orderedIds) {
    const action = byId.get(id);
    if (!action) return { ok: false, reason: `Action ${id} does not belong to this Intention` };
    if (action.status === "done")
      return { ok: false, reason: `Action ${id} is already done; leave it out of the order` };
  }
  const missing = actions.filter((a) => a.status !== "done" && !orderedIds.includes(a.id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Order must include every unfinished action; missing: ${missing.map((a) => a.id).join(", ")}`,
    };
  }
  return { ok: true, value: [...orderedIds] };
}

function normalizeRationale(rationale: string): DomainResult<string> {
  const trimmed = rationale.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Rationale must not be empty" };
  if (trimmed.length > PLAN_RATIONALE_MAX) {
    return { ok: false, reason: `Rationale must be at most ${PLAN_RATIONALE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createPlan(input: {
  id: EntityId;
  intentionId: EntityId;
  orderedActionIds: readonly EntityId[];
  rationale: string;
  createdBy: string;
  sourceRevision: number;
  now: Instant;
}): DomainResult<OrderedActionPlan> {
  const rationale = normalizeRationale(input.rationale);
  if (!rationale.ok) return rationale;
  return {
    ok: true,
    value: {
      id: input.id,
      intentionId: input.intentionId,
      orderedActionIds: [...input.orderedActionIds],
      rationale: rationale.value,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
      version: 1,
      sourceRevision: input.sourceRevision,
    },
  };
}

/** Replaces the order (and its rationale) of an existing plan; the caller validates the order. */
export function replacePlanOrder(
  plan: OrderedActionPlan,
  input: { orderedActionIds: readonly EntityId[]; rationale: string; createdBy: string; sourceRevision: number },
  now: Instant,
): DomainResult<OrderedActionPlan> {
  const rationale = normalizeRationale(input.rationale);
  if (!rationale.ok) return rationale;
  return {
    ok: true,
    value: {
      ...plan,
      orderedActionIds: [...input.orderedActionIds],
      rationale: rationale.value,
      createdBy: input.createdBy,
      sourceRevision: input.sourceRevision,
      version: plan.version + 1,
      updatedAt: now,
    },
  };
}

export const OWNER_ORDER_NOTE = "Порядок изменён владельцем вручную — он главнее прежнего порядка ИИ.";

/**
 * Rationale of a plan the owner has taken over (Stage 9 Day 1 hotfix): an AI's reasoning must not stay on
 * screen as the reason for an order the owner changed — and must not be lost either, so it is kept after the note.
 */
export function ownerOrderRationale(previous: string): string {
  if (previous.startsWith(OWNER_ORDER_NOTE)) return previous;
  return `${OWNER_ORDER_NOTE} Прежнее обоснование: ${previous}`.slice(0, PLAN_RATIONALE_MAX);
}

/** Unfinished Actions the plan does not mention (e.g. added manually after the route was approved). */
export function unplannedActionIds(
  plan: OrderedActionPlan | undefined,
  actions: readonly { readonly id: EntityId; readonly status: ActionStatus }[],
): EntityId[] {
  const planned = new Set(plan?.orderedActionIds ?? []);
  return actions.filter((a) => a.status !== "done" && !planned.has(a.id)).map((a) => a.id);
}
