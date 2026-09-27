import {
  type ActionDto,
  type AddActionInput,
  type AddGoodLifeConditionInput,
  type AddStageInput,
  type BlockActionInput,
  type ChangeLogEntryDto,
  type CompleteActionInput,
  type CreateIntentionInput,
  type CreateSeasonInput,
  type CurrentViewDto,
  type EditActionInput,
  type EditGoodLifeConditionInput,
  type EditStageInput,
  err,
  type GoodLifeConditionDto,
  type IntentionDto,
  type ListChangeHistoryInput,
  ok,
  type RemoveGoodLifeConditionInput,
  type ReopenActionInput,
  type ReorderActionsInput,
  type ReorderGoodLifeConditionsInput,
  type ReorderStagesInput,
  type Result,
  type SeasonDto,
  type SetCurrentStageInput,
  type StageDto,
  type StateRevisionDto,
  type UnblockActionInput,
  type UpdateIntentionInput,
  type UpdateSeasonFocusInput,
} from "@living-map/contracts";
import {
  type Action,
  type Blocker,
  blockAction,
  completeAction,
  computeReorder,
  createAction,
  createGoodLifeCondition,
  createIntention,
  createSeason,
  createStage,
  editAction,
  editGoodLifeCondition,
  editIntention,
  editStageTitle,
  type GoodLifeCondition,
  type Intention,
  isAtVersion,
  reopenAction,
  type Season,
  type Stage,
  unblockAction,
  updateSeasonFocus,
} from "@living-map/domain";
import { type Actor, type CommandContext, type CommandSource, createCommandContext } from "./context";
import { type CommandName, isAllowed } from "./policy";
import {
  type ChangeLogEntry,
  type Clock,
  type IdGenerator,
  SchemaConflictError,
  type Store,
  type WriteScope,
} from "./ports";

export type ApplicationDeps = {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  /** Technical diagnostics only; never receives user content beyond the thrown error. */
  reportError?: (operation: string, error: unknown) => void;
};

const toSeasonDto = (season: Season): SeasonDto => ({ ...season });
const toGoodLifeConditionDto = (c: GoodLifeCondition): GoodLifeConditionDto => ({ ...c });
const toIntentionDto = (intention: Intention): IntentionDto => ({ ...intention });
const toStageDto = (stage: Stage): StageDto => ({ ...stage });
const toBlockerDto = (blocker: Blocker | null) => (blocker ? { ...blocker } : null);
const toActionDto = (action: Action): ActionDto => ({ ...action, blocker: toBlockerDto(action.blocker) });
const toChangeLogEntryDto = (entry: ChangeLogEntry): ChangeLogEntryDto => ({ ...entry });

/** Carries a failed Result out of a write transaction so the store rolls it back. */
class RollbackSignal {
  constructor(readonly result: Result<never>) {}
}

export function createApplication(deps: ApplicationDeps) {
  const { store, clock, ids } = deps;

  function guarded<T>(operation: string, run: () => Result<T>): Result<T> {
    try {
      return run();
    } catch (error) {
      deps.reportError?.(operation, error);
      if (error instanceof SchemaConflictError) {
        return err("SCHEMA_INCOMPATIBLE", "Database schema changed; reopen the Living Map desktop app");
      }
      return err("STORAGE_ERROR", "Storage operation failed");
    }
  }

  /**
   * The only way commands write (ARCHITECTURE §44): returning a failed Result from `work`
   * rolls the transaction back exactly like a throw — never a half-applied command.
   */
  function transact<T>(ctx: CommandContext, work: (scope: WriteScope) => Result<T>): Result<T> {
    try {
      return store.write(ctx, (scope) => {
        const result = work(scope);
        if (!result.ok) throw new RollbackSignal(result);
        return result;
      });
    } catch (error) {
      if (error instanceof RollbackSignal) return error.result;
      throw error;
    }
  }

  function authorize(command: CommandName, ctx: CommandContext): Result<never> | undefined {
    return isAllowed(command, ctx.actor) ? undefined : err("PERMISSION_DENIED", `${ctx.actor} may not ${command}`);
  }

  return {
    newContext: (actor: Actor, source: CommandSource): CommandContext =>
      createCommandContext({ clock, ids }, actor, source),

    queries: {
      getStateRevision: (): Result<StateRevisionDto> =>
        guarded("getStateRevision", () => ok({ stateRevision: store.read((s) => s.stateRevision()) })),

      getSeason: (): Result<SeasonDto | null> =>
        guarded("getSeason", () => {
          const current = store.read((s) => s.season.get());
          return ok(current ? toSeasonDto(current) : null);
        }),

      listGoodLifeConditions: (): Result<GoodLifeConditionDto[]> =>
        guarded("listGoodLifeConditions", () =>
          ok(store.read((s) => s.goodLifeConditions.list()).map(toGoodLifeConditionDto)),
        ),

      getActiveIntention: (): Result<IntentionDto | null> =>
        guarded("getActiveIntention", () => {
          const active = store.read((s) => s.intentions.list()[0]);
          return ok(active ? toIntentionDto(active) : null);
        }),

      getCurrentView: (): Result<CurrentViewDto> =>
        guarded("getCurrentView", () =>
          ok(
            store.read((s) => {
              const season = s.season.get();
              const intention = s.intentions.list()[0];
              const stages = intention ? s.stages.listByIntention(intention.id) : [];
              // One batched query for every Stage's actions instead of one query per Stage: this
              // view is re-fetched after every write (via the revision watcher), so an N+1 here
              // would recur continuously rather than costing once.
              const actionsByStage = new Map<string, ActionDto[]>();
              for (const action of s.actions.listByStages(stages.map((stage) => stage.id))) {
                const list = actionsByStage.get(action.stageId) ?? [];
                list.push(toActionDto(action));
                actionsByStage.set(action.stageId, list);
              }
              return {
                season: season ? toSeasonDto(season) : null,
                goodLifeConditions: s.goodLifeConditions.list().map(toGoodLifeConditionDto),
                intention: intention ? toIntentionDto(intention) : null,
                stages: stages.map((stage) => ({ ...toStageDto(stage), actions: actionsByStage.get(stage.id) ?? [] })),
              };
            }),
          ),
        ),

      listChangeHistory: (input: ListChangeHistoryInput): Result<ChangeLogEntryDto[]> =>
        guarded("listChangeHistory", () =>
          ok(store.read((s) => s.changeLog.listRecent(input.limit)).map(toChangeLogEntryDto)),
        ),
    },

    commands: {
      createSeason: (ctx: CommandContext, input: CreateSeasonInput): Result<SeasonDto> =>
        authorize("season.create", ctx) ??
        guarded("createSeason", () =>
          transact(ctx, (s): Result<SeasonDto> => {
            if (s.season.get()) return err("VALIDATION_ERROR", "A season already exists; use updateSeasonFocus");
            const created = createSeason({ id: ids.next(), focus: input.focus, now: clock.now() });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.season.insert(created.value);
            s.recordChange({
              commandType: "season.create",
              entityType: "season",
              entityId: created.value.id,
              summary: "created",
            });
            return ok(toSeasonDto(created.value));
          }),
        ),

      updateSeasonFocus: (ctx: CommandContext, input: UpdateSeasonFocusInput): Result<SeasonDto> =>
        authorize("season.updateFocus", ctx) ??
        guarded("updateSeasonFocus", () =>
          transact(ctx, (s): Result<SeasonDto> => {
            const current = s.season.get();
            if (!current) return err("NOT_FOUND", "Season not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Season changed (now v${current.version}); reload and retry`);
            }
            const updated = updateSeasonFocus(current, input.focus, clock.now());
            if (!updated.ok) return err("VALIDATION_ERROR", updated.reason);
            if (!s.season.updateIfVersion(updated.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Season changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "season.updateFocus",
              entityType: "season",
              entityId: current.id,
              summary: `v${current.version}→v${updated.value.version}`,
            });
            return ok(toSeasonDto(updated.value));
          }),
        ),

      addGoodLifeCondition: (ctx: CommandContext, input: AddGoodLifeConditionInput): Result<GoodLifeConditionDto> =>
        authorize("goodLifeCondition.add", ctx) ??
        guarded("addGoodLifeCondition", () =>
          transact(ctx, (s): Result<GoodLifeConditionDto> => {
            const position = s.goodLifeConditions.list().length + 1;
            const created = createGoodLifeCondition({ id: ids.next(), text: input.text, position, now: clock.now() });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.goodLifeConditions.insert(created.value);
            s.recordChange({
              commandType: "goodLifeCondition.add",
              entityType: "goodLifeCondition",
              entityId: created.value.id,
              summary: "added",
            });
            return ok(toGoodLifeConditionDto(created.value));
          }),
        ),

      editGoodLifeCondition: (ctx: CommandContext, input: EditGoodLifeConditionInput): Result<GoodLifeConditionDto> =>
        authorize("goodLifeCondition.edit", ctx) ??
        guarded("editGoodLifeCondition", () =>
          transact(ctx, (s): Result<GoodLifeConditionDto> => {
            const current = s.goodLifeConditions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Good life condition not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Condition changed (now v${current.version}); reload and retry`);
            }
            const edited = editGoodLifeCondition(current, input.text, clock.now());
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (!s.goodLifeConditions.updateIfVersion(edited.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Condition changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "goodLifeCondition.edit",
              entityType: "goodLifeCondition",
              entityId: current.id,
              summary: `v${current.version}→v${edited.value.version}`,
            });
            return ok(toGoodLifeConditionDto(edited.value));
          }),
        ),

      removeGoodLifeCondition: (ctx: CommandContext, input: RemoveGoodLifeConditionInput): Result<null> =>
        authorize("goodLifeCondition.remove", ctx) ??
        guarded("removeGoodLifeCondition", () =>
          transact(ctx, (s): Result<null> => {
            const current = s.goodLifeConditions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Good life condition not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Condition changed (now v${current.version}); reload and retry`);
            }
            if (!s.goodLifeConditions.removeIfVersion(input.id, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Condition changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "goodLifeCondition.remove",
              entityType: "goodLifeCondition",
              entityId: input.id,
              summary: "removed",
            });
            return ok(null);
          }),
        ),

      reorderGoodLifeConditions: (
        ctx: CommandContext,
        input: ReorderGoodLifeConditionsInput,
      ): Result<GoodLifeConditionDto[]> =>
        authorize("goodLifeCondition.reorder", ctx) ??
        guarded("reorderGoodLifeConditions", () =>
          transact(ctx, (s): Result<GoodLifeConditionDto[]> => {
            const current = s.goodLifeConditions.list();
            const positions = computeReorder(
              current.map((c) => c.id),
              input.orderedIds,
            );
            if (!positions.ok) return err("VALIDATION_ERROR", positions.reason);
            s.goodLifeConditions.reorder(positions.value, clock.now());
            // Good Life Conditions are a flat, unscoped list (no owning parent like an Intention or
            // Stage), so the change log points at the collection itself rather than an arbitrary item.
            s.recordChange({
              commandType: "goodLifeCondition.reorder",
              entityType: "goodLifeCondition",
              entityId: "all",
              summary: "order changed",
            });
            return ok(s.goodLifeConditions.list().map(toGoodLifeConditionDto));
          }),
        ),

      createIntention: (ctx: CommandContext, input: CreateIntentionInput): Result<IntentionDto> =>
        authorize("intention.create", ctx) ??
        guarded("createIntention", () =>
          transact(ctx, (s): Result<IntentionDto> => {
            if (s.intentions.list().length > 0) return err("VALIDATION_ERROR", "An active Intention already exists");
            const created = createIntention({
              id: ids.next(),
              title: input.title,
              desiredResult: input.desiredResult,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.intentions.insert(created.value);
            s.recordChange({
              commandType: "intention.create",
              entityType: "intention",
              entityId: created.value.id,
              summary: "created",
            });
            return ok(toIntentionDto(created.value));
          }),
        ),

      updateIntention: (ctx: CommandContext, input: UpdateIntentionInput): Result<IntentionDto> =>
        authorize("intention.update", ctx) ??
        guarded("updateIntention", () =>
          transact(ctx, (s): Result<IntentionDto> => {
            const current = s.intentions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Intention not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Intention changed (now v${current.version}); reload and retry`);
            }
            const edited = editIntention(current, input, clock.now());
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (!s.intentions.updateIfVersion(edited.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Intention changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "intention.update",
              entityType: "intention",
              entityId: current.id,
              summary: `v${current.version}→v${edited.value.version}`,
            });
            return ok(toIntentionDto(edited.value));
          }),
        ),

      addStage: (ctx: CommandContext, input: AddStageInput): Result<StageDto> =>
        authorize("stage.add", ctx) ??
        guarded("addStage", () =>
          transact(ctx, (s): Result<StageDto> => {
            if (!s.intentions.findById(input.intentionId)) return err("NOT_FOUND", "Intention not found");
            const siblings = s.stages.listByIntention(input.intentionId);
            const created = createStage({
              id: ids.next(),
              intentionId: input.intentionId,
              title: input.title,
              position: siblings.length + 1,
              isCurrent: siblings.length === 0,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.stages.insert(created.value);
            s.recordChange({
              commandType: "stage.add",
              entityType: "stage",
              entityId: created.value.id,
              summary: "added",
            });
            return ok(toStageDto(created.value));
          }),
        ),

      editStage: (ctx: CommandContext, input: EditStageInput): Result<StageDto> =>
        authorize("stage.edit", ctx) ??
        guarded("editStage", () =>
          transact(ctx, (s): Result<StageDto> => {
            const current = s.stages.findById(input.id);
            if (!current) return err("NOT_FOUND", "Stage not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Stage changed (now v${current.version}); reload and retry`);
            }
            const edited = editStageTitle(current, input.title, clock.now());
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (!s.stages.updateIfVersion(edited.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Stage changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "stage.edit",
              entityType: "stage",
              entityId: current.id,
              summary: `v${current.version}→v${edited.value.version}`,
            });
            return ok(toStageDto(edited.value));
          }),
        ),

      reorderStages: (ctx: CommandContext, input: ReorderStagesInput): Result<StageDto[]> =>
        authorize("stage.reorder", ctx) ??
        guarded("reorderStages", () =>
          transact(ctx, (s): Result<StageDto[]> => {
            const current = s.stages.listByIntention(input.intentionId);
            const positions = computeReorder(
              current.map((stage) => stage.id),
              input.orderedIds,
            );
            if (!positions.ok) return err("VALIDATION_ERROR", positions.reason);
            s.stages.reorder(positions.value, clock.now());
            s.recordChange({
              commandType: "stage.reorder",
              entityType: "intention",
              entityId: input.intentionId,
              summary: "stage order changed",
            });
            return ok(s.stages.listByIntention(input.intentionId).map(toStageDto));
          }),
        ),

      setCurrentStage: (ctx: CommandContext, input: SetCurrentStageInput): Result<StageDto[]> =>
        authorize("stage.setCurrent", ctx) ??
        guarded("setCurrentStage", () =>
          transact(ctx, (s): Result<StageDto[]> => {
            const target = s.stages.findById(input.stageId);
            if (!target || target.intentionId !== input.intentionId) return err("NOT_FOUND", "Stage not found");
            s.stages.setCurrent(input.intentionId, input.stageId, clock.now());
            s.recordChange({
              commandType: "stage.setCurrent",
              entityType: "stage",
              entityId: input.stageId,
              summary: "became current",
            });
            return ok(s.stages.listByIntention(input.intentionId).map(toStageDto));
          }),
        ),

      addAction: (ctx: CommandContext, input: AddActionInput): Result<ActionDto> =>
        authorize("action.add", ctx) ??
        guarded("addAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            if (!s.stages.findById(input.stageId)) return err("NOT_FOUND", "Stage not found");
            const siblings = s.actions.listByStage(input.stageId);
            const created = createAction({
              id: ids.next(),
              stageId: input.stageId,
              title: input.title,
              doneWhen: input.doneWhen,
              position: siblings.length + 1,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.actions.insert(created.value);
            s.recordChange({
              commandType: "action.add",
              entityType: "action",
              entityId: created.value.id,
              summary: "added",
            });
            return ok(toActionDto(created.value));
          }),
        ),

      editAction: (ctx: CommandContext, input: EditActionInput): Result<ActionDto> =>
        authorize("action.edit", ctx) ??
        guarded("editAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            const current = s.actions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const edited = editAction(current, input, clock.now());
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (!s.actions.updateIfVersion(edited.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "action.edit",
              entityType: "action",
              entityId: current.id,
              summary: `v${current.version}→v${edited.value.version}`,
            });
            return ok(toActionDto(edited.value));
          }),
        ),

      completeAction: (ctx: CommandContext, input: CompleteActionInput): Result<ActionDto> =>
        authorize("action.complete", ctx) ??
        guarded("completeAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            const current = s.actions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const completed = completeAction(current, clock.now());
            if (!completed.ok) return err("VALIDATION_ERROR", completed.reason);
            if (!s.actions.updateIfVersion(completed.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "action.complete",
              entityType: "action",
              entityId: current.id,
              summary: "completed",
            });
            return ok(toActionDto(completed.value));
          }),
        ),

      blockAction: (ctx: CommandContext, input: BlockActionInput): Result<ActionDto> =>
        authorize("action.block", ctx) ??
        guarded("blockAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            const current = s.actions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const blocked = blockAction(current, input.reason, clock.now());
            if (!blocked.ok) return err("VALIDATION_ERROR", blocked.reason);
            if (!s.actions.updateIfVersion(blocked.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "action.block",
              entityType: "action",
              entityId: current.id,
              summary: `blocked: ${blocked.value.blocker?.reason ?? ""}`,
            });
            return ok(toActionDto(blocked.value));
          }),
        ),

      unblockAction: (ctx: CommandContext, input: UnblockActionInput): Result<ActionDto> =>
        authorize("action.unblock", ctx) ??
        guarded("unblockAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            const current = s.actions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const unblocked = unblockAction(current, clock.now());
            if (!unblocked.ok) return err("VALIDATION_ERROR", unblocked.reason);
            if (!s.actions.updateIfVersion(unblocked.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "action.unblock",
              entityType: "action",
              entityId: current.id,
              summary: "unblocked",
            });
            return ok(toActionDto(unblocked.value));
          }),
        ),

      reopenAction: (ctx: CommandContext, input: ReopenActionInput): Result<ActionDto> =>
        authorize("action.reopen", ctx) ??
        guarded("reopenAction", () =>
          transact(ctx, (s): Result<ActionDto> => {
            const current = s.actions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const reopened = reopenAction(current, clock.now());
            if (!reopened.ok) return err("VALIDATION_ERROR", reopened.reason);
            if (!s.actions.updateIfVersion(reopened.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "action.reopen",
              entityType: "action",
              entityId: current.id,
              summary: "reopened",
            });
            return ok(toActionDto(reopened.value));
          }),
        ),

      reorderActions: (ctx: CommandContext, input: ReorderActionsInput): Result<ActionDto[]> =>
        authorize("action.reorder", ctx) ??
        guarded("reorderActions", () =>
          transact(ctx, (s): Result<ActionDto[]> => {
            const current = s.actions.listByStage(input.stageId);
            const positions = computeReorder(
              current.map((action) => action.id),
              input.orderedIds,
            );
            if (!positions.ok) return err("VALIDATION_ERROR", positions.reason);
            s.actions.reorder(positions.value, clock.now());
            s.recordChange({
              commandType: "action.reorder",
              entityType: "stage",
              entityId: input.stageId,
              summary: "action order changed",
            });
            return ok(s.actions.listByStage(input.stageId).map(toActionDto));
          }),
        ),
    },
  };
}

export type Application = ReturnType<typeof createApplication>;
