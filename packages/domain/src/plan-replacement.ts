import { type Action, createAction, editAction } from "./action";
import { createStage, type Stage } from "./stage";
import type { DomainResult, EntityId, Instant } from "./types";

/** One Action of an owner-approved plan. `existingActionId` carries an existing Action (and its history) over. */
export type ApprovedPlanAction = {
  readonly title: string;
  readonly doneWhen: string;
  readonly existingActionId?: EntityId | null | undefined;
};

export type ApprovedPlanStage = {
  readonly title: string;
  readonly actions: readonly ApprovedPlanAction[];
};

export type PlanReplacement = {
  /** The new Stage sequence, positions 1..n, exactly one current. */
  readonly stages: Stage[];
  readonly insertedActions: Action[];
  /** Existing Actions carried into the new Stages (same id, same history). */
  readonly movedActions: Action[];
  /** Every Stage of the previous structure: kept as history, no longer part of the project's route. */
  readonly archivedStageIds: EntityId[];
  /** Unfinished Actions of the previous structure the approved plan does not carry: inactive, never deleted. */
  readonly leftBehindActionIds: EntityId[];
  /** The exact approved order: every unfinished Action, Stage by Stage, Action by Action. */
  readonly orderedActionIds: EntityId[];
};

export const APPROVED_PLAN_MAX_STAGES = 50;
export const APPROVED_PLAN_MAX_ACTIONS = 300;

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * Replaces the operational structure of ONE project with an owner-approved plan (Stage 9, Day 1). The project
 * itself (identity, status, desired result, Season link) is untouched and nothing is deleted: the previous
 * Stages are archived as history, finished work stays exactly where it was (or is carried over by id), and
 * the order becomes exactly the approved sequence. Pure: the caller persists the outcome atomically.
 */
export function replaceProjectPlan(input: {
  intentionId: EntityId;
  /** The project's current (non-archived) Stages and their Actions. */
  stages: readonly Stage[];
  actions: readonly Action[];
  approved: readonly ApprovedPlanStage[];
  nextId: () => EntityId;
  now: Instant;
}): DomainResult<PlanReplacement> {
  const { approved, now } = input;
  if (approved.length === 0) return fail("An approved plan needs at least one Stage");
  if (approved.length > APPROVED_PLAN_MAX_STAGES) return fail(`At most ${APPROVED_PLAN_MAX_STAGES} Stages`);
  const total = approved.reduce((n, s) => n + s.actions.length, 0);
  if (total > APPROVED_PLAN_MAX_ACTIONS) return fail(`At most ${APPROVED_PLAN_MAX_ACTIONS} Actions`);
  if (input.stages.some((s) => s.intentionId !== input.intentionId)) return fail("Stage outside the project");

  const existing = new Map(input.actions.map((a) => [a.id, a]));
  const carried = new Set<EntityId>();
  const stages: Stage[] = [];
  const insertedActions: Action[] = [];
  const movedActions: Action[] = [];
  const placed: Action[] = [];

  for (const [stageIndex, spec] of approved.entries()) {
    const stage = createStage({
      id: input.nextId(),
      intentionId: input.intentionId,
      title: spec.title,
      position: stageIndex + 1,
      isCurrent: false,
      now,
    });
    if (!stage.ok) return fail(`Stage ${stageIndex + 1}: ${stage.reason}`);
    stages.push(stage.value);
    for (const [actionIndex, a] of spec.actions.entries()) {
      const where = `Stage ${stageIndex + 1}, action ${actionIndex + 1}`;
      const position = actionIndex + 1;
      if (a.existingActionId) {
        const old = existing.get(a.existingActionId);
        if (!old) return fail(`${where}: action ${a.existingActionId} is not part of this project's current plan`);
        if (carried.has(old.id)) return fail(`${where}: action ${old.id} is used twice`);
        carried.add(old.id);
        // Finished work keeps its words — it is history; an unfinished one takes the approved wording.
        let moved: Action = old;
        if (old.status !== "done") {
          const edited = editAction(old, { title: a.title, doneWhen: a.doneWhen }, now);
          if (!edited.ok) return fail(`${where}: ${edited.reason}`);
          moved = edited.value;
        } else {
          moved = { ...old, version: old.version + 1, updatedAt: now };
        }
        moved = { ...moved, stageId: stage.value.id, position };
        movedActions.push(moved);
        placed.push(moved);
      } else {
        const created = createAction({
          id: input.nextId(),
          stageId: stage.value.id,
          title: a.title,
          doneWhen: a.doneWhen,
          position,
          now,
        });
        if (!created.ok) return fail(`${where}: ${created.reason}`);
        insertedActions.push(created.value);
        placed.push(created.value);
      }
    }
  }

  const orderedActionIds = placed.filter((a) => a.status !== "done").map((a) => a.id);
  if (orderedActionIds.length === 0) return fail("An approved plan needs at least one unfinished Action");

  // The current Stage is where the first unfinished Action lives.
  const firstOpenStageId = placed.find((a) => a.status !== "done")?.stageId;
  const withCurrent = stages.map((s) => (s.id === firstOpenStageId ? { ...s, isCurrent: true } : s));

  return {
    ok: true,
    value: {
      stages: withCurrent,
      insertedActions,
      movedActions,
      archivedStageIds: input.stages.map((s) => s.id),
      leftBehindActionIds: input.actions.filter((a) => a.status !== "done" && !carried.has(a.id)).map((a) => a.id),
      orderedActionIds,
    },
  };
}
