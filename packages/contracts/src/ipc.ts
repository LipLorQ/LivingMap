// Kept free of runtime dependencies: the sandboxed preload imports this file.
import type {
  AcceptReviewFindingInput,
  ActionDto,
  AddActionInput,
  AddGoodLifeConditionInput,
  AddHouseholdItemInput,
  AddRoutineItemInput,
  AddStageInput,
  BlockActionInput,
  CalendarSnapshotDto,
  CaptureDto,
  ChangeIntentionStatusInput,
  ChangeLogEntryDto,
  CompleteActionInput,
  CompleteHouseholdItemInput,
  ConfirmPatternInput,
  ConnectCalendarInput,
  CorrectReviewFindingInput,
  CourseImpactDto,
  CreateIntentionInput,
  CreateSeasonInput,
  CurrentViewDto,
  DeactivatePlanningRuleInput,
  EditActionInput,
  EditGoodLifeConditionInput,
  EditRoutineItemInput,
  EditStageInput,
  ExecutionDto,
  ForgetMemoryInput,
  GetReviewInput,
  GoodLifeConditionDto,
  HouseholdItemDto,
  HouseholdListDto,
  IntentionDto,
  ListCapturesInput,
  ListChangeHistoryInput,
  ListPatternCandidatesInput,
  ListPlanningRulesInput,
  ListReviewsInput,
  MemoryDto,
  PatternDto,
  PlanningRuleDto,
  PreviewCourseImpactInput,
  ProposalDto,
  RejectPatternInput,
  RejectReviewFindingInput,
  RemoveDecadeItemInput,
  RemoveGoodLifeConditionInput,
  RemoveRoutineItemInput,
  ReopenActionInput,
  ReorderActionsInput,
  ReorderGoodLifeConditionsInput,
  ReorderProjectsInput,
  ReorderRoutineItemsInput,
  ReorderStagesInput,
  ResolveCourseChangeInput,
  ResolveProposalInput,
  Result,
  RetryCaptureInput,
  RetryReviewInput,
  ReviewDto,
  ReviewFindingDto,
  ReviewWithFindingsDto,
  RoutineItemDto,
  SaveStrategyInput,
  SearchMemoryInput,
  SeasonDto,
  SelectWorkProjectInput,
  SetCurrentStageInput,
  SetDailyWorkTargetInput,
  StageDto,
  StateRevisionDto,
  StrategyHistoryDto,
  SubmitCaptureInput,
  UnblockActionInput,
  UpdateIntentionInput,
  UpdateSeasonFocusInput,
  WorkActionInput,
} from "./index";

/** The complete, finite set of IPC channels (ARCHITECTURE §30). No dynamic channels. */
export const IPC_CHANNELS = {
  getStateRevision: "lm:query:getStateRevision",
  getCurrentView: "lm:query:getCurrentView",
  listChangeHistory: "lm:query:listChangeHistory",
  createSeason: "lm:command:createSeason",
  updateSeasonFocus: "lm:command:updateSeasonFocus",
  addGoodLifeCondition: "lm:command:addGoodLifeCondition",
  editGoodLifeCondition: "lm:command:editGoodLifeCondition",
  removeGoodLifeCondition: "lm:command:removeGoodLifeCondition",
  reorderGoodLifeConditions: "lm:command:reorderGoodLifeConditions",
  createIntention: "lm:command:createIntention",
  updateIntention: "lm:command:updateIntention",
  addStage: "lm:command:addStage",
  editStage: "lm:command:editStage",
  reorderStages: "lm:command:reorderStages",
  setCurrentStage: "lm:command:setCurrentStage",
  addAction: "lm:command:addAction",
  editAction: "lm:command:editAction",
  completeAction: "lm:command:completeAction",
  blockAction: "lm:command:blockAction",
  unblockAction: "lm:command:unblockAction",
  reopenAction: "lm:command:reopenAction",
  reorderActions: "lm:command:reorderActions",
  acceptProposal: "lm:command:acceptProposal",
  rejectProposal: "lm:command:rejectProposal",
  connectCalendar: "lm:command:connectCalendar",
  refreshCalendar: "lm:command:refreshCalendar",
  disconnectCalendar: "lm:command:disconnectCalendar",
  startWork: "lm:command:startWork",
  pauseWork: "lm:command:pauseWork",
  setDailyWorkTarget: "lm:command:setDailyWorkTarget",
  listCaptures: "lm:query:listCaptures",
  submitCapture: "lm:command:submitCapture",
  retryCapture: "lm:command:retryCapture",
  searchMemory: "lm:query:searchMemory",
  forgetMemory: "lm:command:forgetMemory",
  listReviews: "lm:query:listReviews",
  getReview: "lm:query:getReview",
  retryReview: "lm:command:retryReview",
  acceptReviewFinding: "lm:command:acceptReviewFinding",
  correctReviewFinding: "lm:command:correctReviewFinding",
  rejectReviewFinding: "lm:command:rejectReviewFinding",
  listPatternCandidates: "lm:query:listPatternCandidates",
  confirmPattern: "lm:command:confirmPattern",
  rejectPattern: "lm:command:rejectPattern",
  listPlanningRules: "lm:query:listPlanningRules",
  deactivatePlanningRule: "lm:command:deactivatePlanningRule",
  getStrategyHistory: "lm:query:getStrategyHistory",
  previewCourseImpact: "lm:query:previewCourseImpact",
  saveStrategy: "lm:command:saveStrategy",
  removeDecadeItem: "lm:command:removeDecadeItem",
  resolveCourseChange: "lm:command:resolveCourseChange",
  changeIntentionStatus: "lm:command:changeIntentionStatus",
  reorderProjects: "lm:command:reorderProjects",
  addRoutineItem: "lm:command:addRoutineItem",
  editRoutineItem: "lm:command:editRoutineItem",
  removeRoutineItem: "lm:command:removeRoutineItem",
  reorderRoutineItems: "lm:command:reorderRoutineItems",
  selectWorkProject: "lm:command:selectWorkProject",
  listHouseholdItems: "lm:query:listHouseholdItems",
  addHouseholdItem: "lm:command:addHouseholdItem",
  completeHouseholdItem: "lm:command:completeHouseholdItem",
  stateChanged: "lm:event:stateChanged",
} as const;

export type LivingMapApi = {
  queries: {
    getStateRevision(): Promise<Result<StateRevisionDto>>;
    getCurrentView(): Promise<Result<CurrentViewDto>>;
    listChangeHistory(input: ListChangeHistoryInput): Promise<Result<ChangeLogEntryDto[]>>;
    listCaptures(input: ListCapturesInput): Promise<Result<CaptureDto[]>>;
    searchMemory(input: SearchMemoryInput): Promise<Result<MemoryDto[]>>;
    /** Reviews (Stage 7), newest first. */
    listReviews(input: ListReviewsInput): Promise<Result<ReviewDto[]>>;
    getReview(input: GetReviewInput): Promise<Result<ReviewWithFindingsDto>>;
    listPatternCandidates(input: ListPatternCandidatesInput): Promise<Result<PatternDto[]>>;
    listPlanningRules(input: ListPlanningRulesInput): Promise<Result<PlanningRuleDto[]>>;
    /** Past seasons and the projects closed in the current one (the Full Map's history). */
    getStrategyHistory(): Promise<Result<StrategyHistoryDto>>;
    /** What a change of course at this level may affect — to be shown BEFORE the change is confirmed. */
    previewCourseImpact(input: PreviewCourseImpactInput): Promise<Result<CourseImpactDto>>;
    /** «Быт»: active errands and the most recently done ones. Desktop only — never in the AI context. */
    listHouseholdItems(): Promise<Result<HouseholdListDto>>;
  };
  commands: {
    createSeason(input: CreateSeasonInput): Promise<Result<SeasonDto>>;
    updateSeasonFocus(input: UpdateSeasonFocusInput): Promise<Result<SeasonDto>>;
    addGoodLifeCondition(input: AddGoodLifeConditionInput): Promise<Result<GoodLifeConditionDto>>;
    editGoodLifeCondition(input: EditGoodLifeConditionInput): Promise<Result<GoodLifeConditionDto>>;
    removeGoodLifeCondition(input: RemoveGoodLifeConditionInput): Promise<Result<null>>;
    reorderGoodLifeConditions(input: ReorderGoodLifeConditionsInput): Promise<Result<GoodLifeConditionDto[]>>;
    createIntention(input: CreateIntentionInput): Promise<Result<IntentionDto>>;
    updateIntention(input: UpdateIntentionInput): Promise<Result<IntentionDto>>;
    addStage(input: AddStageInput): Promise<Result<StageDto>>;
    editStage(input: EditStageInput): Promise<Result<StageDto>>;
    reorderStages(input: ReorderStagesInput): Promise<Result<StageDto[]>>;
    setCurrentStage(input: SetCurrentStageInput): Promise<Result<StageDto[]>>;
    addAction(input: AddActionInput): Promise<Result<ActionDto>>;
    editAction(input: EditActionInput): Promise<Result<ActionDto>>;
    completeAction(input: CompleteActionInput): Promise<Result<ActionDto>>;
    blockAction(input: BlockActionInput): Promise<Result<ActionDto>>;
    unblockAction(input: UnblockActionInput): Promise<Result<ActionDto>>;
    reopenAction(input: ReopenActionInput): Promise<Result<ActionDto>>;
    reorderActions(input: ReorderActionsInput): Promise<Result<ActionDto[]>>;
    acceptProposal(input: ResolveProposalInput): Promise<Result<ProposalDto>>;
    rejectProposal(input: ResolveProposalInput): Promise<Result<null>>;
    /** Validates the private iCal feed URL by fetching it before saving (main process owns the fetch). */
    connectCalendar(input: ConnectCalendarInput): Promise<Result<CalendarSnapshotDto>>;
    refreshCalendar(): Promise<Result<CalendarSnapshotDto>>;
    disconnectCalendar(): Promise<Result<CalendarSnapshotDto>>;
    /** Начать / Продолжить: only for the current Action, only when nothing else is running. */
    startWork(input: WorkActionInput): Promise<Result<ExecutionDto>>;
    pauseWork(input: WorkActionInput): Promise<Result<ExecutionDto>>;
    setDailyWorkTarget(input: SetDailyWorkTargetInput): Promise<Result<ExecutionDto>>;
    /** Universal `+`: resolves once the raw text is committed; AI processing continues in the background. */
    submitCapture(input: SubmitCaptureInput): Promise<Result<CaptureDto>>;
    retryCapture(input: RetryCaptureInput): Promise<Result<CaptureDto>>;
    /** The user forgets a memory; the Capture it came from is kept as typed. */
    forgetMemory(input: ForgetMemoryInput): Promise<Result<null>>;
    /** «Повторить» a failed Review. */
    retryReview(input: RetryReviewInput): Promise<Result<ReviewDto>>;
    /** «Всё верно». */
    acceptReviewFinding(input: AcceptReviewFindingInput): Promise<Result<ReviewFindingDto>>;
    /** The user's correction becomes the accepted learning; the AI's draft is kept. */
    correctReviewFinding(input: CorrectReviewFindingInput): Promise<Result<ReviewFindingDto>>;
    /** «Игнорировать»: never becomes Pattern evidence. */
    rejectReviewFinding(input: RejectReviewFindingInput): Promise<Result<ReviewFindingDto>>;
    /** «Сделать правилом»: confirms the candidate and activates its PlanningRule atomically. */
    confirmPattern(input: ConfirmPatternInput): Promise<Result<PatternDto>>;
    /** «Не считать правилом». */
    rejectPattern(input: RejectPatternInput): Promise<Result<PatternDto>>;
    deactivatePlanningRule(input: DeactivatePlanningRuleInput): Promise<Result<PlanningRuleDto>>;
    /** Decade / 3-year / year layer: add, reword (MODE A) or change course (MODE B, with the shown impact). */
    saveStrategy(input: SaveStrategyInput): Promise<Result<null>>;
    removeDecadeItem(input: RemoveDecadeItemInput): Promise<Result<null>>;
    /** «Всё пересобрано»: closes the open reminder after a change of course. */
    resolveCourseChange(input: ResolveCourseChangeInput): Promise<Result<null>>;
    /** Complete / release / pause / resume / bring back a project. Resuming is limited to three active. */
    changeIntentionStatus(input: ChangeIntentionStatusInput): Promise<Result<IntentionDto>>;
    reorderProjects(input: ReorderProjectsInput): Promise<Result<IntentionDto[]>>;
    addRoutineItem(input: AddRoutineItemInput): Promise<Result<RoutineItemDto>>;
    editRoutineItem(input: EditRoutineItemInput): Promise<Result<RoutineItemDto>>;
    removeRoutineItem(input: RemoveRoutineItemInput): Promise<Result<null>>;
    reorderRoutineItems(input: ReorderRoutineItemsInput): Promise<Result<RoutineItemDto[]>>;
    /** Which active project `Сейчас` works on. Pauses running work on another project; never starts any. */
    selectWorkProject(input: SelectWorkProjectInput): Promise<Result<null>>;
    addHouseholdItem(input: AddHouseholdItemInput): Promise<Result<HouseholdItemDto>>;
    completeHouseholdItem(input: CompleteHouseholdItemInput): Promise<Result<HouseholdItemDto>>;
  };
  events: {
    /** Returns an unsubscribe function. */
    onStateChanged(listener: (change: StateRevisionDto) => void): () => void;
  };
};
