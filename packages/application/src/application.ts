import {
  type ActionDto,
  type AddActionInput,
  type AddGoodLifeConditionInput,
  type AddStageInput,
  type BlockActionInput,
  type ChangeLogEntryDto,
  type CompleteActionInput,
  type CreateIntentionInput,
  type CreateRouteProposalInput,
  type CreateSeasonInput,
  type CurrentViewDto,
  type EditActionInput,
  type EditGoodLifeConditionInput,
  type EditStageInput,
  err,
  type GetProposalInput,
  type GoodLifeConditionDto,
  type IntentionDto,
  type ListChangeHistoryInput,
  type OrderedActionPlanDto,
  ok,
  type PlanningContextDto,
  type ProposalDto,
  type ProposeDesiredResultChangeInput,
  type RemoveGoodLifeConditionInput,
  type ReopenActionInput,
  type ReorderActionsInput,
  type ReorderExistingActionsInput,
  type ReorderGoodLifeConditionsInput,
  type ReorderStagesInput,
  type ResolveProposalInput,
  type Result,
  type RoutePayload,
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
  applyRouteChange,
  type Blocker,
  blockAction,
  completeAction,
  computeReorder,
  createAction,
  createGoodLifeCondition,
  createIntention,
  createPlan,
  createProposal,
  createSeason,
  createStage,
  editAction,
  editGoodLifeCondition,
  editIntention,
  editStageTitle,
  type GoodLifeCondition,
  type Intention,
  isAtVersion,
  MAX_PENDING_PROPOSALS,
  type Proposal,
  type RouteChange,
  reopenAction,
  replacePlanOrder,
  resolveProposal,
  type Season,
  type Stage,
  unblockAction,
  unplannedActionIds,
  updateSeasonFocus,
  validateActionOrder,
} from "@living-map/domain";
import { type Actor, type CommandContext, type CommandSource, createCommandContext } from "./context";
import {
  contextFingerprint,
  intentionTree,
  PLANNING_MEANINGS,
  parsePayload,
  routeChangeFromPayload,
  toPlanDto,
  toProposalDto,
} from "./planning";
import { type CommandName, isAllowed } from "./policy";
import {
  type ChangeLogEntry,
  type Clock,
  type IdGenerator,
  type ReadScope,
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

  function currentView(s: ReadScope): CurrentViewDto {
    const season = s.season.get();
    const intention = s.intentions.list()[0];
    const stages = intention ? s.stages.listByIntention(intention.id) : [];
    // One batched query for every Stage's actions instead of one query per Stage: this view is
    // re-fetched after every write (via the revision watcher), so an N+1 here would recur continuously.
    const actions = s.actions.listByStages(stages.map((stage) => stage.id));
    const actionsByStage = new Map<string, ActionDto[]>();
    for (const action of actions) {
      const list = actionsByStage.get(action.stageId) ?? [];
      list.push(toActionDto(action));
      actionsByStage.set(action.stageId, list);
    }
    const plan = intention ? s.plans.findByIntention(intention.id) : undefined;
    const now = clock.now();
    return {
      season: season ? toSeasonDto(season) : null,
      goodLifeConditions: s.goodLifeConditions.list().map(toGoodLifeConditionDto),
      intention: intention ? toIntentionDto(intention) : null,
      stages: stages.map((stage) => ({ ...toStageDto(stage), actions: actionsByStage.get(stage.id) ?? [] })),
      orderedActionPlan: plan ? toPlanDto(plan) : null,
      unplannedActionIds: plan ? unplannedActionIds(plan, actions) : [],
      pendingProposals: s.proposals
        .listPending()
        .map((p) => toProposalDto(s, p, now))
        .filter((p): p is ProposalDto => p !== undefined),
    };
  }

  function checkRevision(s: WriteScope, expected: number): Result<never> | undefined {
    const current = s.stateRevision();
    return current === expected
      ? undefined
      : err("CONFLICT_RELOAD", `Living Map changed (revision ${expected} → ${current}); reread the context and retry`);
  }

  /** Common checks + persistence for every AI proposal kind. */
  function insertProposal(
    s: WriteScope,
    ctx: CommandContext,
    input: { kind: Proposal["kind"]; intentionId: string; payload: unknown; affected: string[]; rationale: string },
  ): Result<ProposalDto> {
    if (s.proposals.listPending().length >= MAX_PENDING_PROPOSALS) {
      return err("VALIDATION_ERROR", "Too many pending proposals; ask the user to review the existing ones first");
    }
    const created = createProposal({
      id: ids.next(),
      kind: input.kind,
      createdBy: ctx.actor,
      baseRevision: s.stateRevision(),
      baseFingerprint: contextFingerprint(s, input.intentionId),
      affectedEntityIds: [input.intentionId, ...input.affected],
      payload: input.payload,
      rationale: input.rationale,
      now: clock.now(),
    });
    if (!created.ok) return err("VALIDATION_ERROR", created.reason);
    s.proposals.insert(created.value);
    s.recordChange({
      commandType: "proposal.create",
      entityType: "proposal",
      entityId: created.value.id,
      summary: input.kind,
    });
    const dto = toProposalDto(s, created.value, clock.now());
    return dto ? ok(dto) : err("STORAGE_ERROR", "Proposal could not be read back");
  }

  /** Writes an accepted route — every entity write and the plan — inside the caller's transaction. */
  function applyRoute(s: WriteScope, proposal: Proposal, payload: RoutePayload): Result<"applied" | "stale"> {
    const before = intentionTree(s, payload.intentionId);
    const now = clock.now();
    const outcome = applyRouteChange({
      ...before,
      intentionId: payload.intentionId,
      change: routeChangeFromPayload(payload),
      now,
    });
    if (!outcome.ok) return ok("stale");
    const versionOf = new Map([...before.stages, ...before.actions].map((e) => [e.id, e.version]));
    const log = (entityType: string, entityId: string, summary: string) =>
      s.recordChange({ commandType: "proposal.accept", entityType, entityId, summary });

    for (const stage of outcome.value.insertedStages) {
      s.stages.insert(stage);
      log("stage", stage.id, "added");
    }
    for (const stage of outcome.value.updatedStages) {
      if (!s.stages.updateIfVersion(stage, versionOf.get(stage.id) as number)) {
        return err("CONFLICT_RELOAD", "Stage changed concurrently; reload and retry");
      }
      log("stage", stage.id, "edited");
    }
    for (const action of outcome.value.insertedActions) {
      s.actions.insert(action);
      log("action", action.id, "added");
    }
    for (const action of outcome.value.updatedActions) {
      if (!s.actions.updateIfVersion(action, versionOf.get(action.id) as number)) {
        return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
      }
      log("action", action.id, "edited");
    }

    const order = {
      orderedActionIds: outcome.value.orderedActionIds,
      rationale: proposal.rationale,
      createdBy: proposal.createdBy,
      sourceRevision: proposal.baseRevision,
    };
    const existing = s.plans.findByIntention(payload.intentionId);
    if (existing) {
      const next = replacePlanOrder(existing, order, now);
      if (!next.ok) return err("VALIDATION_ERROR", next.reason);
      if (!s.plans.updateIfVersion(next.value, existing.version)) {
        return err("CONFLICT_RELOAD", "Plan changed concurrently; reload and retry");
      }
      log("plan", existing.id, `v${existing.version}→v${next.value.version}`);
    } else {
      const created = createPlan({ id: ids.next(), intentionId: payload.intentionId, ...order, now });
      if (!created.ok) return err("VALIDATION_ERROR", created.reason);
      s.plans.insert(created.value);
      log("plan", created.value.id, "created");
    }
    return ok("applied");
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

      getCurrentView: (): Result<CurrentViewDto> => guarded("getCurrentView", () => ok(store.read(currentView))),

      /** One coherent planning snapshot for an external AI (MCP get_living_map_context). */
      getPlanningContext: (): Result<PlanningContextDto> =>
        guarded("getPlanningContext", () =>
          ok(
            store.read((s) => ({
              stateRevision: s.stateRevision(),
              meanings: PLANNING_MEANINGS,
              ...currentView(s),
              recentHistory: s.changeLog.listRecent(30).map(toChangeLogEntryDto),
            })),
          ),
        ),

      getProposal: (input: GetProposalInput): Result<ProposalDto> =>
        guarded("getProposal", () =>
          store.read((s) => {
            const proposal = s.proposals.findById(input.id);
            const dto = proposal && toProposalDto(s, proposal, clock.now());
            return dto ? ok(dto) : err("NOT_FOUND", "Proposal not found");
          }),
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

      /** PROPOSAL (mcp-ai): a first route or a replan. Validated by a full dry run; never applied here. */
      createRouteProposal: (ctx: CommandContext, input: CreateRouteProposalInput): Result<ProposalDto> =>
        authorize("proposal.create", ctx) ??
        guarded("createRouteProposal", () =>
          transact(ctx, (s): Result<ProposalDto> => {
            const conflict = checkRevision(s, input.expectedRevision);
            if (conflict) return conflict;
            if (!s.intentions.findById(input.intentionId)) return err("NOT_FOUND", "Intention not found");

            const change = resolveRouteRefs(input, () => ids.next());
            if (!change.ok) return change;
            const before = intentionTree(s, input.intentionId);
            const dryRun = applyRouteChange({
              ...before,
              intentionId: input.intentionId,
              change: change.value,
              now: clock.now(),
            });
            if (!dryRun.ok) return err("VALIDATION_ERROR", dryRun.reason);

            const stagesById = new Map(before.stages.map((st) => [st.id, st]));
            const actionsById = new Map(before.actions.map((a) => [a.id, a]));
            const plan = s.plans.findByIntention(input.intentionId);
            const payload: RoutePayload = {
              intentionId: input.intentionId,
              isFirstRoute: !plan,
              newStages: [...change.value.newStages],
              stageEdits: change.value.stageEdits.map((e) => ({
                ...e,
                previousTitle: stagesById.get(e.id)?.title ?? "",
              })),
              newActions: [...change.value.newActions],
              actionEdits: change.value.actionEdits.map((e) => ({
                ...e,
                previousTitle: actionsById.get(e.id)?.title ?? "",
                previousDoneWhen: actionsById.get(e.id)?.doneWhen ?? "",
              })),
              stageOrder: change.value.stageOrder ? [...change.value.stageOrder] : null,
              orderedActionIds: dryRun.value.orderedActionIds,
            };
            const affected = [
              ...dryRun.value.insertedStages,
              ...dryRun.value.updatedStages,
              ...dryRun.value.insertedActions,
              ...dryRun.value.updatedActions,
              ...(plan ? [plan] : []),
            ].map((e) => e.id);
            return insertProposal(s, ctx, {
              kind: "route",
              intentionId: input.intentionId,
              payload,
              affected,
              rationale: input.rationale,
            });
          }),
        ),

      /** PROPOSAL (mcp-ai): change what must become true for the Intention to count as embodied. */
      proposeDesiredResultChange: (ctx: CommandContext, input: ProposeDesiredResultChangeInput): Result<ProposalDto> =>
        authorize("proposal.create", ctx) ??
        guarded("proposeDesiredResultChange", () =>
          transact(ctx, (s): Result<ProposalDto> => {
            const conflict = checkRevision(s, input.expectedRevision);
            if (conflict) return conflict;
            const intention = s.intentions.findById(input.intentionId);
            if (!intention) return err("NOT_FOUND", "Intention not found");
            const edited = editIntention(
              intention,
              { title: intention.title, desiredResult: input.desiredResult },
              clock.now(),
            );
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (edited.value.desiredResult === intention.desiredResult) {
              return err("VALIDATION_ERROR", "The proposed desired result is identical to the current one");
            }
            return insertProposal(s, ctx, {
              kind: "desired_result",
              intentionId: intention.id,
              payload: {
                intentionId: intention.id,
                desiredResult: edited.value.desiredResult,
                previousDesiredResult: intention.desiredResult,
              },
              affected: [],
              rationale: input.rationale,
            });
          }),
        ),

      /**
       * The user's confirmation (user-ui only). Revalidates status, payload and the planning-context
       * fingerprint, then applies everything atomically. A materially changed world never gets a
       * silent rebase: the proposal is persisted as `stale` and STALE_PROPOSAL is returned.
       */
      acceptProposal: (ctx: CommandContext, input: ResolveProposalInput): Result<ProposalDto> =>
        authorize("proposal.accept", ctx) ??
        guarded("acceptProposal", () => {
          type Outcome = { stale: boolean; dto: ProposalDto | undefined };
          const result = transact(ctx, (s): Result<Outcome> => {
            const proposal = s.proposals.findById(input.id);
            if (!proposal) return err("NOT_FOUND", "Proposal not found");
            if (proposal.status !== "pending") {
              return err(
                proposal.status === "stale" ? "STALE_PROPOSAL" : "VALIDATION_ERROR",
                `Proposal is already ${proposal.status}`,
              );
            }
            const now = clock.now();
            const finish = (status: "accepted" | "stale"): Result<Outcome> => {
              const resolved = resolveProposal(proposal, status, ctx.actor, now);
              if (!resolved.ok) return err("VALIDATION_ERROR", resolved.reason);
              if (!s.proposals.resolveIfPending(resolved.value)) {
                return err("CONFLICT_RELOAD", "Proposal changed concurrently; reload and retry");
              }
              s.recordChange({
                commandType: status === "accepted" ? "proposal.accept" : "proposal.stale",
                entityType: "proposal",
                entityId: proposal.id,
                summary: proposal.kind,
              });
              return ok({ stale: status === "stale", dto: toProposalDto(s, resolved.value, now) });
            };

            const parsed = parsePayload(proposal);
            if (!parsed || contextFingerprint(s, parsed.payload.intentionId) !== proposal.baseFingerprint) {
              return finish("stale");
            }
            if (parsed.kind === "route") {
              const applied = applyRoute(s, proposal, parsed.payload);
              if (!applied.ok) return applied;
              if (applied.value === "stale") return finish("stale");
            } else {
              const intention = s.intentions.findById(parsed.payload.intentionId);
              if (!intention) return finish("stale");
              const edited = editIntention(
                intention,
                { title: intention.title, desiredResult: parsed.payload.desiredResult },
                now,
              );
              if (!edited.ok) return finish("stale");
              if (!s.intentions.updateIfVersion(edited.value, intention.version)) {
                return err("CONFLICT_RELOAD", "Intention changed concurrently; reload and retry");
              }
              s.recordChange({
                commandType: "proposal.accept",
                entityType: "intention",
                entityId: intention.id,
                summary: "desired result changed",
              });
            }
            return finish("accepted");
          });
          if (!result.ok) return result;
          if (result.value.stale) {
            return err("STALE_PROPOSAL", "Living Map changed after this proposal was made; ask the AI to rebuild it");
          }
          return result.value.dto ? ok(result.value.dto) : err("STORAGE_ERROR", "Proposal could not be read back");
        }),

      rejectProposal: (ctx: CommandContext, input: ResolveProposalInput): Result<ProposalDto> =>
        authorize("proposal.reject", ctx) ??
        guarded("rejectProposal", () =>
          transact(ctx, (s): Result<ProposalDto> => {
            const proposal = s.proposals.findById(input.id);
            if (!proposal) return err("NOT_FOUND", "Proposal not found");
            const rejected = resolveProposal(proposal, "rejected", ctx.actor, clock.now());
            if (!rejected.ok) return err("VALIDATION_ERROR", rejected.reason);
            if (!s.proposals.resolveIfPending(rejected.value)) {
              return err("CONFLICT_RELOAD", "Proposal changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "proposal.reject",
              entityType: "proposal",
              entityId: proposal.id,
              summary: proposal.kind,
            });
            const dto = toProposalDto(s, rejected.value, clock.now());
            return dto ? ok(dto) : err("STORAGE_ERROR", "Proposal could not be read back");
          }),
        ),

      /**
       * SAFE WRITE (mcp-ai): reorders the already-approved unfinished Actions of an already-approved
       * route. Touches only the plan row — no creation, deletion, text, status or blocker change is
       * even expressible. Without an approved route it refuses: the first order needs the user.
       */
      reorderExistingActions: (ctx: CommandContext, input: ReorderExistingActionsInput): Result<OrderedActionPlanDto> =>
        authorize("plan.reorder", ctx) ??
        guarded("reorderExistingActions", () =>
          transact(ctx, (s): Result<OrderedActionPlanDto> => {
            if (!s.intentions.findById(input.intentionId)) return err("NOT_FOUND", "Intention not found");
            const plan = s.plans.findByIntention(input.intentionId);
            if (!plan) {
              return err(
                "REQUIRES_CONFIRMATION",
                "No approved route yet: use create_route_proposal and let the user confirm it",
              );
            }
            if (!isAtVersion(plan, input.expectedPlanVersion)) {
              return err("CONFLICT_RELOAD", `Plan changed (now v${plan.version}); reread the context and retry`);
            }
            const order = validateActionOrder(input.orderedActionIds, intentionTree(s, input.intentionId).actions);
            if (!order.ok) return err("VALIDATION_ERROR", order.reason);
            const next = replacePlanOrder(
              plan,
              {
                orderedActionIds: order.value,
                rationale: input.rationale,
                createdBy: ctx.actor,
                sourceRevision: s.stateRevision(),
              },
              clock.now(),
            );
            if (!next.ok) return err("VALIDATION_ERROR", next.reason);
            if (!s.plans.updateIfVersion(next.value, plan.version)) {
              return err("CONFLICT_RELOAD", "Plan changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "plan.reorder",
              entityType: "plan",
              entityId: plan.id,
              summary: `v${plan.version}→v${next.value.version}`,
            });
            return ok(toPlanDto(next.value));
          }),
        ),
    },
  };
}

/**
 * AI-facing refs → fresh UUIDs. Refs are unique across the whole proposal; a Stage slot resolves
 * only Stage refs and an order slot only Action refs. Anything else passes through unchanged and is
 * rejected by the domain dry run as "does not belong to this Intention".
 */
function resolveRouteRefs(input: CreateRouteProposalInput, nextId: () => string): Result<RouteChange> {
  const stageRefs = new Map<string, string>();
  const actionRefs = new Map<string, string>();
  for (const [refs, items] of [
    [stageRefs, input.newStages],
    [actionRefs, input.newActions],
  ] as const) {
    for (const { ref } of items) {
      if (stageRefs.has(ref) || actionRefs.has(ref)) return err("VALIDATION_ERROR", `Duplicate ref "${ref}"`);
      refs.set(ref, nextId());
    }
  }
  const stage = (v: string) => stageRefs.get(v) ?? v;
  const action = (v: string) => actionRefs.get(v) ?? v;
  return ok({
    newStages: input.newStages.map((st) => ({ id: stage(st.ref), title: st.title })),
    stageEdits: input.stageEdits.map((e) => ({ id: e.stageId, title: e.title })),
    newActions: input.newActions.map((a) => ({
      id: action(a.ref),
      stageId: stage(a.stage),
      title: a.title,
      doneWhen: a.doneWhen,
    })),
    actionEdits: input.actionEdits.map((e) => ({ id: e.actionId, title: e.title, doneWhen: e.doneWhen })),
    stageOrder: input.stageOrder ? input.stageOrder.map(stage) : null,
    orderedActionIds: input.actionOrder.map(action),
  });
}

export type Application = ReturnType<typeof createApplication>;
