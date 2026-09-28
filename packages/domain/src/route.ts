import { type Action, createAction, editAction } from "./action";
import { validateActionOrder } from "./plan";
import { computeReorder } from "./reorder";
import { createStage, editStageTitle, type Stage } from "./stage";
import type { DomainResult, EntityId, Instant } from "./types";

/**
 * The structural part of a route proposal, with real ids already assigned to new entities.
 * No deletions and no status changes exist here by construction.
 */
export type RouteChange = {
  readonly newStages: readonly { readonly id: EntityId; readonly title: string }[];
  readonly stageEdits: readonly { readonly id: EntityId; readonly title: string }[];
  readonly newActions: readonly {
    readonly id: EntityId;
    readonly stageId: EntityId;
    readonly title: string;
    readonly doneWhen: string;
  }[];
  readonly actionEdits: readonly { readonly id: EntityId; readonly title: string; readonly doneWhen: string }[];
  /** Full resulting Stage sequence, or null to keep existing order and append new Stages. */
  readonly stageOrder: readonly EntityId[] | null;
  readonly orderedActionIds: readonly EntityId[];
};

export type RouteOutcome = {
  /** Every Stage of the Intention after the change, in position order. */
  readonly stages: Stage[];
  /** Every Action of those Stages after the change. */
  readonly actions: Action[];
  readonly insertedStages: Stage[];
  /** Existing Stages whose title and/or position changed (version already bumped once). */
  readonly updatedStages: Stage[];
  readonly insertedActions: Action[];
  readonly updatedActions: Action[];
  readonly orderedActionIds: EntityId[];
};

const fail = (reason: string): DomainResult<never> => ({ ok: false, reason });

function hasDuplicates(ids: readonly EntityId[]): boolean {
  return new Set(ids).size !== ids.length;
}

/**
 * Pure dry-run of a route change against the current Stages/Actions of one Intention. Used both to
 * validate a proposal when the AI creates it and to apply it on acceptance, so the preview the user
 * reviews is produced by exactly the same code that later writes it.
 */
export function applyRouteChange(input: {
  intentionId: EntityId;
  stages: readonly Stage[];
  actions: readonly Action[];
  change: RouteChange;
  now: Instant;
}): DomainResult<RouteOutcome> {
  const { intentionId, change, now } = input;
  const stages = new Map(input.stages.map((s) => [s.id, s]));
  const actions = new Map(input.actions.map((a) => [a.id, a]));
  if ([...stages.values()].some((s) => s.intentionId !== intentionId)) return fail("Stage outside the Intention");
  if ([...actions.values()].some((a) => !stages.has(a.stageId))) return fail("Action outside the Intention");

  const allNewIds = [...change.newStages.map((s) => s.id), ...change.newActions.map((a) => a.id)];
  if (hasDuplicates(allNewIds) || allNewIds.some((id) => stages.has(id) || actions.has(id))) {
    return fail("New entity ids must be unique");
  }
  if (hasDuplicates(change.stageEdits.map((e) => e.id))) return fail("A Stage is edited more than once");
  if (hasDuplicates(change.actionEdits.map((e) => e.id))) return fail("An Action is edited more than once");

  const updatedStageIds = new Set<EntityId>();
  for (const edit of change.stageEdits) {
    const current = stages.get(edit.id);
    if (!current) return fail(`Stage ${edit.id} does not belong to this Intention`);
    const edited = editStageTitle(current, edit.title, now);
    if (!edited.ok) return edited;
    stages.set(edit.id, edited.value);
    updatedStageIds.add(edit.id);
  }

  const existingStageCount = stages.size;
  const insertedStageIds = new Set<EntityId>();
  for (const [index, spec] of change.newStages.entries()) {
    const created = createStage({
      id: spec.id,
      intentionId,
      title: spec.title,
      position: existingStageCount + index + 1,
      isCurrent: false,
      now,
    });
    if (!created.ok) return created;
    stages.set(spec.id, created.value);
    insertedStageIds.add(spec.id);
  }

  if (change.stageOrder) {
    const positions = computeReorder([...stages.keys()], change.stageOrder);
    if (!positions.ok) return positions;
    for (const [id, position] of positions.value) {
      const stage = stages.get(id) as Stage;
      if (stage.position === position) continue;
      // An existing Stage bumps its version once, even if it was also renamed above.
      const version = insertedStageIds.has(id) || updatedStageIds.has(id) ? stage.version : stage.version + 1;
      stages.set(id, { ...stage, position, version, updatedAt: now });
      if (!insertedStageIds.has(id)) updatedStageIds.add(id);
    }
  }

  // Same rule as manual addStage: an Intention's very first Stage becomes current. Existing Intentions
  // with Stages always have exactly one current Stage already, and a route never changes it.
  const first = [...stages.values()].sort((a, b) => a.position - b.position)[0];
  if (input.stages.length === 0 && first) stages.set(first.id, { ...first, isCurrent: true });

  const updatedActionIds = new Set<EntityId>();
  for (const edit of change.actionEdits) {
    const current = actions.get(edit.id);
    if (!current) return fail(`Action ${edit.id} does not belong to this Intention`);
    const edited = editAction(current, edit, now);
    if (!edited.ok) return edited;
    actions.set(edit.id, edited.value);
    updatedActionIds.add(edit.id);
  }

  const insertedActionIds = new Set<EntityId>();
  for (const spec of change.newActions) {
    if (!stages.has(spec.stageId)) return fail(`Stage ${spec.stageId} does not belong to this Intention`);
    const siblings = [...actions.values()].filter((a) => a.stageId === spec.stageId).length;
    const created = createAction({ ...spec, position: siblings + 1, now });
    if (!created.ok) return created;
    actions.set(spec.id, created.value);
    insertedActionIds.add(spec.id);
  }

  const order = validateActionOrder(change.orderedActionIds, [...actions.values()]);
  if (!order.ok) return order;

  const pick = <T>(map: Map<EntityId, T>, ids: Set<EntityId>) => [...ids].map((id) => map.get(id) as T);
  return {
    ok: true,
    value: {
      stages: [...stages.values()].sort((a, b) => a.position - b.position),
      actions: [...actions.values()],
      insertedStages: pick(stages, insertedStageIds),
      updatedStages: pick(stages, updatedStageIds),
      insertedActions: pick(actions, insertedActionIds),
      updatedActions: pick(actions, updatedActionIds),
      orderedActionIds: order.value,
    },
  };
}
