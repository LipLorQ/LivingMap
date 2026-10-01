import type { Application } from "@living-map/application";
import {
  AcceptReviewFindingInputSchema,
  AddActionInputSchema,
  AddGoodLifeConditionInputSchema,
  AddStageInputSchema,
  BlockActionInputSchema,
  CompleteActionInputSchema,
  ConfirmPatternInputSchema,
  ConnectCalendarInputSchema,
  CorrectReviewFindingInputSchema,
  CreateIntentionInputSchema,
  CreateSeasonInputSchema,
  DeactivatePlanningRuleInputSchema,
  EditActionInputSchema,
  EditGoodLifeConditionInputSchema,
  EditStageInputSchema,
  err,
  ForgetMemoryInputSchema,
  GetReviewInputSchema,
  ListCapturesInputSchema,
  ListChangeHistoryInputSchema,
  ListPatternCandidatesInputSchema,
  ListPlanningRulesInputSchema,
  ListReviewsInputSchema,
  RejectPatternInputSchema,
  RejectReviewFindingInputSchema,
  RemoveGoodLifeConditionInputSchema,
  ReopenActionInputSchema,
  ReorderActionsInputSchema,
  ReorderGoodLifeConditionsInputSchema,
  ReorderStagesInputSchema,
  ResolveProposalInputSchema,
  type Result,
  RetryCaptureInputSchema,
  RetryReviewInputSchema,
  SearchMemoryInputSchema,
  SetCurrentStageInputSchema,
  SetDailyWorkTargetInputSchema,
  SubmitCaptureInputSchema,
  UnblockActionInputSchema,
  UpdateIntentionInputSchema,
  UpdateSeasonFocusInputSchema,
  WorkActionInputSchema,
} from "@living-map/contracts";
import { IPC_CHANNELS } from "@living-map/contracts/ipc";
import { ipcMain, type WebFrameMain } from "electron";
import { z } from "zod";
import type { CaptureProcessor } from "./ai/capture-processor";
import type { ReviewProcessor } from "./ai/review-processor";
import type { CalendarOrchestrator } from "./calendar";

type TrustCheck = (frame: WebFrameMain | null) => boolean;

/**
 * The renderer is an untrusted boundary (ARCHITECTURE §30): every payload is re-validated here,
 * the sender frame is checked, and handlers only delegate to application use cases.
 */
export function registerIpcHandlers(
  app: Application,
  isTrusted: TrustCheck,
  calendar: CalendarOrchestrator,
  captures: CaptureProcessor,
  reviews: ReviewProcessor,
): void {
  function handle<S extends z.ZodType>(
    channel: string,
    schema: S | null,
    run: (input: z.infer<S>) => Result<unknown> | Promise<Result<unknown>>,
  ): void {
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!isTrusted(event.senderFrame)) return err("PERMISSION_DENIED", "Untrusted sender");
      if (schema === null) {
        return raw === undefined ? run(undefined as z.infer<S>) : err("VALIDATION_ERROR", "No input expected");
      }
      const parsed = schema.safeParse(raw);
      return parsed.success ? run(parsed.data) : err("VALIDATION_ERROR", z.prettifyError(parsed.error));
    });
  }

  const ui = () => app.newContext("user-ui", "ipc");

  handle(IPC_CHANNELS.getStateRevision, null, () => app.queries.getStateRevision());
  handle(IPC_CHANNELS.getCurrentView, null, () => app.queries.getCurrentView());
  handle(IPC_CHANNELS.listChangeHistory, ListChangeHistoryInputSchema, (input) => app.queries.listChangeHistory(input));

  handle(IPC_CHANNELS.createSeason, CreateSeasonInputSchema, (input) => app.commands.createSeason(ui(), input));
  handle(IPC_CHANNELS.updateSeasonFocus, UpdateSeasonFocusInputSchema, (input) =>
    app.commands.updateSeasonFocus(ui(), input),
  );

  handle(IPC_CHANNELS.addGoodLifeCondition, AddGoodLifeConditionInputSchema, (input) =>
    app.commands.addGoodLifeCondition(ui(), input),
  );
  handle(IPC_CHANNELS.editGoodLifeCondition, EditGoodLifeConditionInputSchema, (input) =>
    app.commands.editGoodLifeCondition(ui(), input),
  );
  handle(IPC_CHANNELS.removeGoodLifeCondition, RemoveGoodLifeConditionInputSchema, (input) =>
    app.commands.removeGoodLifeCondition(ui(), input),
  );
  handle(IPC_CHANNELS.reorderGoodLifeConditions, ReorderGoodLifeConditionsInputSchema, (input) =>
    app.commands.reorderGoodLifeConditions(ui(), input),
  );

  handle(IPC_CHANNELS.createIntention, CreateIntentionInputSchema, (input) =>
    app.commands.createIntention(ui(), input),
  );
  handle(IPC_CHANNELS.updateIntention, UpdateIntentionInputSchema, (input) =>
    app.commands.updateIntention(ui(), input),
  );

  handle(IPC_CHANNELS.addStage, AddStageInputSchema, (input) => app.commands.addStage(ui(), input));
  handle(IPC_CHANNELS.editStage, EditStageInputSchema, (input) => app.commands.editStage(ui(), input));
  handle(IPC_CHANNELS.reorderStages, ReorderStagesInputSchema, (input) => app.commands.reorderStages(ui(), input));
  handle(IPC_CHANNELS.setCurrentStage, SetCurrentStageInputSchema, (input) =>
    app.commands.setCurrentStage(ui(), input),
  );

  handle(IPC_CHANNELS.addAction, AddActionInputSchema, (input) => app.commands.addAction(ui(), input));
  handle(IPC_CHANNELS.editAction, EditActionInputSchema, (input) => app.commands.editAction(ui(), input));
  handle(IPC_CHANNELS.completeAction, CompleteActionInputSchema, (input) => app.commands.completeAction(ui(), input));
  handle(IPC_CHANNELS.blockAction, BlockActionInputSchema, (input) => app.commands.blockAction(ui(), input));
  handle(IPC_CHANNELS.unblockAction, UnblockActionInputSchema, (input) => app.commands.unblockAction(ui(), input));
  handle(IPC_CHANNELS.reopenAction, ReopenActionInputSchema, (input) => app.commands.reopenAction(ui(), input));
  handle(IPC_CHANNELS.reorderActions, ReorderActionsInputSchema, (input) => app.commands.reorderActions(ui(), input));

  // The user's decision on an AI proposal. Only reachable from the desktop (never from MCP).
  handle(IPC_CHANNELS.acceptProposal, ResolveProposalInputSchema, (input) => app.commands.acceptProposal(ui(), input));
  handle(IPC_CHANNELS.rejectProposal, ResolveProposalInputSchema, (input) => app.commands.rejectProposal(ui(), input));

  // Calendar (ARCHITECTURE §32): the HTTP fetch happens here, never inside a store write
  // transaction — `calendar` persists the result through the normal saveCalendarSnapshot command.
  handle(IPC_CHANNELS.connectCalendar, ConnectCalendarInputSchema, (input) => calendar.connect(input.icalUrl));
  handle(IPC_CHANNELS.refreshCalendar, null, () => calendar.refresh());
  handle(IPC_CHANNELS.disconnectCalendar, null, () => calendar.disconnect());

  // Execution (Stage 5): direct user actions. Resume is startWork on an Action that already has time.
  handle(IPC_CHANNELS.startWork, WorkActionInputSchema, (input) => app.commands.startWork(ui(), input));
  handle(IPC_CHANNELS.pauseWork, WorkActionInputSchema, (input) => app.commands.pauseWork(ui(), input));
  handle(IPC_CHANNELS.setDailyWorkTarget, SetDailyWorkTargetInputSchema, (input) =>
    app.commands.setDailyWorkTarget(ui(), input),
  );

  // Universal `+` (ADR-0007): the Capture is committed first; only then may the AI processor pick it up.
  // The renderer never influences how (or whether) an AI process is started.
  handle(IPC_CHANNELS.listCaptures, ListCapturesInputSchema, (input) => app.queries.listCaptures(input));
  const thenProcess = <T>(result: Result<T>): Result<T> => {
    if (result.ok) captures.kick();
    return result;
  };
  handle(IPC_CHANNELS.submitCapture, SubmitCaptureInputSchema, (input) =>
    thenProcess(app.commands.createCapture(ui(), input)),
  );
  handle(IPC_CHANNELS.retryCapture, RetryCaptureInputSchema, (input) =>
    thenProcess(app.commands.retryCapture(ui(), input)),
  );

  // Memory v1: the user can see what LivingMap remembered and forget it (never reachable from MCP).
  handle(IPC_CHANNELS.searchMemory, SearchMemoryInputSchema, (input) => app.queries.searchMemory(input));
  handle(IPC_CHANNELS.forgetMemory, ForgetMemoryInputSchema, (input) => app.commands.forgetMemory(ui(), input));

  // Reviews / Patterns / PlanningRules (Stage 7): desktop only — never reachable from MCP.
  handle(IPC_CHANNELS.listReviews, ListReviewsInputSchema, (input) => app.queries.listReviews(input));
  handle(IPC_CHANNELS.getReview, GetReviewInputSchema, (input) => app.queries.getReview(input));
  handle(IPC_CHANNELS.retryReview, RetryReviewInputSchema, (input) => {
    const result = app.commands.retryReview(ui(), input);
    if (result.ok) reviews.kick();
    return result;
  });
  handle(IPC_CHANNELS.acceptReviewFinding, AcceptReviewFindingInputSchema, (input) =>
    app.commands.acceptReviewFinding(ui(), input),
  );
  handle(IPC_CHANNELS.correctReviewFinding, CorrectReviewFindingInputSchema, (input) =>
    app.commands.correctReviewFinding(ui(), input),
  );
  handle(IPC_CHANNELS.rejectReviewFinding, RejectReviewFindingInputSchema, (input) =>
    app.commands.rejectReviewFinding(ui(), input),
  );
  handle(IPC_CHANNELS.listPatternCandidates, ListPatternCandidatesInputSchema, (input) =>
    app.queries.listPatternCandidates(input),
  );
  handle(IPC_CHANNELS.confirmPattern, ConfirmPatternInputSchema, (input) => app.commands.confirmPattern(ui(), input));
  handle(IPC_CHANNELS.rejectPattern, RejectPatternInputSchema, (input) => app.commands.rejectPattern(ui(), input));
  handle(IPC_CHANNELS.listPlanningRules, ListPlanningRulesInputSchema, (input) => app.queries.listPlanningRules(input));
  handle(IPC_CHANNELS.deactivatePlanningRule, DeactivatePlanningRuleInputSchema, (input) =>
    app.commands.deactivatePlanningRule(ui(), input),
  );
}
