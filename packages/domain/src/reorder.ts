import type { DomainResult, EntityId } from "./types";

/**
 * Validates that `orderedIds` is a permutation of `currentIds` and turns it into 1-based
 * positions. Shared by Good Life Conditions, Stages and Actions manual reordering
 * (ARCHITECTURE §45: one real invariant, not three near-duplicate implementations).
 */
export function computeReorder(
  currentIds: readonly EntityId[],
  orderedIds: readonly EntityId[],
): DomainResult<ReadonlyMap<EntityId, number>> {
  const currentSet = new Set(currentIds);
  const orderedSet = new Set(orderedIds);
  if (orderedIds.length !== orderedSet.size) {
    return { ok: false, reason: "Order list must not contain duplicates" };
  }
  if (currentSet.size !== orderedSet.size || [...currentSet].some((id) => !orderedSet.has(id))) {
    return { ok: false, reason: "Order list must contain exactly the existing items, no more and no fewer" };
  }
  const positions = new Map<EntityId, number>(orderedIds.map((id, index) => [id, index + 1]));
  return { ok: true, value: positions };
}
