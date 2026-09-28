// Kept free of runtime dependencies: the sandboxed preload imports this file.
import type {
  ActionDto,
  AddActionInput,
  AddGoodLifeConditionInput,
  AddStageInput,
  BlockActionInput,
  ChangeLogEntryDto,
  CompleteActionInput,
  CreateIntentionInput,
  CreateSeasonInput,
  CurrentViewDto,
  EditActionInput,
  EditGoodLifeConditionInput,
  EditStageInput,
  GoodLifeConditionDto,
  IntentionDto,
  ListChangeHistoryInput,
  ProposalDto,
  RemoveGoodLifeConditionInput,
  ReopenActionInput,
  ReorderActionsInput,
  ReorderGoodLifeConditionsInput,
  ReorderStagesInput,
  ResolveProposalInput,
  Result,
  SeasonDto,
  SetCurrentStageInput,
  StageDto,
  StateRevisionDto,
  UnblockActionInput,
  UpdateIntentionInput,
  UpdateSeasonFocusInput,
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
  stateChanged: "lm:event:stateChanged",
} as const;

export type LivingMapApi = {
  queries: {
    getStateRevision(): Promise<Result<StateRevisionDto>>;
    getCurrentView(): Promise<Result<CurrentViewDto>>;
    listChangeHistory(input: ListChangeHistoryInput): Promise<Result<ChangeLogEntryDto[]>>;
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
    rejectProposal(input: ResolveProposalInput): Promise<Result<ProposalDto>>;
  };
  events: {
    /** Returns an unsubscribe function. */
    onStateChanged(listener: (change: StateRevisionDto) => void): () => void;
  };
};
