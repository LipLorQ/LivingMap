export type { Action, ActionStatus, Blocker } from "./action";
export {
  ACTION_TITLE_MAX,
  BLOCKER_REASON_MAX,
  blockAction,
  completeAction,
  createAction,
  DONE_WHEN_MAX,
  editAction,
  reopenAction,
  unblockAction,
} from "./action";
export type { CurrentActionSelection, SelectableAction, WhyNowReason } from "./current-action";
export { selectCurrentAction } from "./current-action";
export type { GoodLifeCondition } from "./good-life-condition";
export { CONDITION_TEXT_MAX, createGoodLifeCondition, editGoodLifeCondition } from "./good-life-condition";
export type { Intention } from "./intention";
export { createIntention, DESIRED_RESULT_MAX, editIntention, INTENTION_TITLE_MAX } from "./intention";
export type { OrderedActionPlan } from "./plan";
export { createPlan, PLAN_RATIONALE_MAX, replacePlanOrder, unplannedActionIds, validateActionOrder } from "./plan";
export type { Proposal, ProposalKind, ProposalStatus } from "./proposal";
export {
  createProposal,
  MAX_PENDING_PROPOSALS,
  PROPOSAL_RATIONALE_MAX,
  planningFingerprint,
  resolveProposal,
} from "./proposal";
export { computeReorder } from "./reorder";
export type { RouteChange, RouteOutcome } from "./route";
export { applyRouteChange } from "./route";
export type { Season } from "./season";
export { createSeason, SEASON_FOCUS_MAX, updateSeasonFocus } from "./season";
export type { Stage } from "./stage";
export { createStage, editStageTitle, isCurrentStageUnambiguous, STAGE_TITLE_MAX } from "./stage";
export type { DomainResult, EntityId, Instant, Version } from "./types";

/** Optimistic concurrency check shared by every aggregate above (ARCHITECTURE §13). */
export function isAtVersion(entity: { version: number }, expected: number): boolean {
  return entity.version === expected;
}
