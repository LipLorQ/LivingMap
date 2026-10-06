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
export type { Capture, CaptureState } from "./capture";
export { CAPTURE_AUTO_RETRY_ATTEMPTS, CAPTURE_TEXT_MAX, createCapture } from "./capture";
export type { CourseChange, CourseLevel } from "./course-change";
export { COURSE_SUMMARY_MAX, createCourseChange, resolveCourseChange } from "./course-change";
export type {
  CurrentActionSelection,
  ExecutionAction,
  ExecutionStage,
  ProjectExecution,
  SelectableAction,
  WhyNowReason,
} from "./current-action";
export { effectiveActionOrder, orderStageActions, selectCurrentAction, selectProjectExecution } from "./current-action";
export type { GoodLifeCondition } from "./good-life-condition";
export { CONDITION_TEXT_MAX, createGoodLifeCondition, editGoodLifeCondition } from "./good-life-condition";
export type { HouseholdItem, HouseholdItemStatus } from "./household";
export { completeHouseholdItem, createHouseholdItem, HOUSEHOLD_TEXT_MAX } from "./household";
export type { Intention, IntentionStatus, IntentionStatusChange } from "./intention";
export {
  activeIntentions,
  changeIntentionStatus,
  createIntention,
  DESIRED_RESULT_MAX,
  editIntention,
  hasRoomForActive,
  INTENTION_TITLE_MAX,
  INTENTION_WHY_MAX,
  MAX_ACTIVE_INTENTIONS,
  nextActivePosition,
} from "./intention";
export type { Memory, MemoryType } from "./memory";
export { createMemory, MEMORY_TEXT_MAX, rankMemories } from "./memory";
export type { Pattern, PatternStatus, PlanningRule, PlanningRuleStatus } from "./pattern";
export {
  confirmPattern,
  createPatternCandidate,
  createPlanningRule,
  deactivatePlanningRule,
  growPatternCandidate,
  MIN_PATTERN_EVIDENCE,
  PATTERN_TEXT_MAX,
  rejectPattern,
} from "./pattern";
export type { OrderedActionPlan } from "./plan";
export {
  createPlan,
  OWNER_ORDER_NOTE,
  ownerOrderRationale,
  PLAN_RATIONALE_MAX,
  replacePlanOrder,
  unplannedActionIds,
  validateActionOrder,
} from "./plan";
export type { ApprovedPlanAction, ApprovedPlanStage, PlanReplacement } from "./plan-replacement";
export { APPROVED_PLAN_MAX_ACTIONS, APPROVED_PLAN_MAX_STAGES, replaceProjectPlan } from "./plan-replacement";
export type { Proposal, ProposalKind, ProposalStatus } from "./proposal";
export {
  createProposal,
  MAX_PENDING_PROPOSALS,
  PROPOSAL_RATIONALE_MAX,
  planningFingerprint,
  resolveProposal,
} from "./proposal";
export { computeReorder } from "./reorder";
export type {
  DueReviewPeriod,
  LastReviewPeriod,
  Review,
  ReviewFinding,
  ReviewFindingStatus,
  ReviewStatus,
  ReviewType,
} from "./review";
export {
  acceptedFindingText,
  acceptFinding,
  correctFinding,
  createReview,
  createReviewFinding,
  dueDailyPeriods,
  dueWeeklyPeriods,
  dueYearlyPeriods,
  REVIEW_AUTO_RETRY_ATTEMPTS,
  REVIEW_FINDING_TEXT_MAX,
  rejectFinding,
} from "./review";
export type { RouteChange, RouteOutcome } from "./route";
export { applyRouteChange } from "./route";
export type { RoutineItem, RoutineKind } from "./routine";
export { createRoutineItem, editRoutineItem, ROUTINE_MAX_ITEMS_PER_KIND, ROUTINE_TEXT_MAX } from "./routine";
export type { Season, SeasonHistoryEntry } from "./season";
export { createSeason, rewordSeason, SEASON_FOCUS_MAX, SEASON_WHY_MAX, startNewSeason } from "./season";
export type { Stage } from "./stage";
export { createStage, editStageTitle, isCurrentStageUnambiguous, STAGE_TITLE_MAX, stageToFollowReorder } from "./stage";
export type { DecadePlanItem, ThreeYearHorizon, YearDirection } from "./strategy";
export {
  createDecadeItem,
  createHorizon,
  createYearDirection,
  DECADE_MAX_SPAN_YEARS,
  DECADE_PLAN_MAX_ITEMS,
  DECADE_STATEMENT_MAX,
  decadesServedBy,
  HORIZON_DIRECTION_MAX,
  HORIZON_SPAN_YEARS,
  MAX_STRATEGY_YEAR,
  MIN_STRATEGY_YEAR,
  normalizeStrategyLabel,
  reviseDecadeItem,
  reviseHorizon,
  reviseYearDirection,
  rewordDecadeItem,
  rewordHorizon,
  rewordYearDirection,
  STRATEGY_LABEL_MAX,
  STRATEGY_TEXT_MAX,
  sortDecadePlan,
  yearRangesOverlap,
} from "./strategy";
export type {
  EvidenceItem,
  ImpactItem,
  ProjectProgress,
  ProjectSnapshot,
  StrategyState,
} from "./strategy-map";
export {
  computeCourseImpact,
  currentYearOf,
  evidenceForYears,
  evidenceSince,
  impactFingerprint,
  projectProgress,
  seasonProgress,
} from "./strategy-map";
export type { DomainResult, EntityId, Instant, Version } from "./types";
export type { WorkInterval } from "./work";
export {
  addDays,
  closeAt,
  isSilent,
  localDate,
  startOfLocalDay,
  totalWorkedMs,
  WORK_HEARTBEAT_GAP_MS,
  weekStart,
  workedMsBetweenDates,
} from "./work";

/** Optimistic concurrency check shared by every aggregate above (ARCHITECTURE §13). */
export function isAtVersion(entity: { version: number }, expected: number): boolean {
  return entity.version === expected;
}
