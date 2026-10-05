import {
  type AcceptReviewFindingInput,
  type ActionDto,
  type AddActionInput,
  type AddGoodLifeConditionInput,
  type AddHouseholdItemInput,
  type AddRoutineItemInput,
  type AddStageInput,
  AiFailureSchema,
  type ApprovedProjectPlan,
  type BlockActionInput,
  type CalendarSnapshotDto,
  CaptureAiResultSchema,
  type CaptureDto,
  type ChangeIntentionStatusInput,
  type ChangeLogEntryDto,
  type CompleteActionInput,
  type CompleteHouseholdItemInput,
  type ConfirmPatternInput,
  type CorrectReviewFindingInput,
  type CourseImpactDto,
  type CreateIntentionInput,
  type CreateRouteProposalInput,
  type CreateSeasonInput,
  type CurrentViewDto,
  type DeactivatePlanningRuleInput,
  type EditActionInput,
  type EditGoodLifeConditionInput,
  type EditRoutineItemInput,
  type EditStageInput,
  type ExecutionDto,
  err,
  type ForgetMemoryInput,
  type GetProposalInput,
  type GetReviewInput,
  type GoodLifeConditionDto,
  type HouseholdItemDto,
  type HouseholdListDto,
  type IntentionDto,
  type ListCapturesInput,
  type ListChangeHistoryInput,
  type ListPatternCandidatesInput,
  type ListPlanningRulesInput,
  type ListReviewsInput,
  type MemoryDto,
  type OrderedActionPlanDto,
  ok,
  type PatternDto,
  type PlanningContextDto,
  type PlanningRuleDto,
  type PreviewCourseImpactInput,
  type ProjectPlanReplacementDto,
  type ProposalDto,
  type ProposeDesiredResultChangeInput,
  type RejectPatternInput,
  type RejectReviewFindingInput,
  type RemoveDecadeItemInput,
  type RemoveGoodLifeConditionInput,
  type RemoveRoutineItemInput,
  type ReopenActionInput,
  type ReorderActionsInput,
  type ReorderExistingActionsInput,
  type ReorderGoodLifeConditionsInput,
  type ReorderProjectsInput,
  type ReorderRoutineItemsInput,
  type ReorderStagesInput,
  type ReplaceProjectPlanInput,
  type ResolveCourseChangeInput,
  type ResolveProposalInput,
  type Result,
  type RetryCaptureInput,
  type RetryReviewInput,
  ReviewAiResultSchema,
  type ReviewDto,
  type ReviewFindingDto,
  type ReviewInboxDto,
  type ReviewWithFindingsDto,
  type RoutePayload,
  type RoutineItemDto,
  type SaveMemoryInput,
  type SaveStrategyInput,
  type SearchMemoryInput,
  type SeasonDto,
  type SelectWorkProjectInput,
  type SetCurrentStageInput,
  type SetDailyWorkTargetInput,
  type StageDto,
  type StateRevisionDto,
  type StrategyHistoryDto,
  type SubmitCaptureInput,
  type UnblockActionInput,
  type UpdateIntentionInput,
  type UpdateSeasonFocusInput,
  type WorkActionInput,
} from "@living-map/contracts";
import {
  acceptedFindingText,
  acceptFinding,
  activeIntentions,
  addDays,
  applyRouteChange,
  blockAction,
  CAPTURE_AUTO_RETRY_ATTEMPTS,
  type Capture,
  type CourseLevel,
  changeIntentionStatus,
  closeAt,
  completeAction,
  completeHouseholdItem,
  computeCourseImpact,
  computeReorder,
  confirmPattern,
  correctFinding,
  createAction,
  createCapture,
  createCourseChange,
  createDecadeItem,
  createGoodLifeCondition,
  createHorizon,
  createHouseholdItem,
  createIntention,
  createMemory,
  createPatternCandidate,
  createPlan,
  createPlanningRule,
  createProposal,
  createReview,
  createReviewFinding,
  createRoutineItem,
  createSeason,
  createStage,
  createYearDirection,
  deactivatePlanningRule,
  type EntityId,
  editAction,
  editGoodLifeCondition,
  editIntention,
  editRoutineItem,
  editStageTitle,
  type GoodLifeCondition,
  growPatternCandidate,
  type HouseholdItem,
  hasRoomForActive,
  type ImpactItem,
  type Instant,
  type Intention,
  impactFingerprint,
  isAtVersion,
  isSilent,
  localDate,
  MAX_ACTIVE_INTENTIONS,
  MAX_PENDING_PROPOSALS,
  type Memory,
  nextActivePosition,
  type Pattern,
  type PlanningRule,
  type PlanReplacement,
  type Proposal,
  replaceProjectPlan as planReplacement,
  REVIEW_AUTO_RETRY_ATTEMPTS,
  type Review,
  type ReviewFinding,
  type RouteChange,
  rankMemories,
  rejectFinding,
  rejectPattern,
  reopenAction,
  replacePlanOrder,
  resolveCourseChange,
  resolveProposal,
  reviseDecadeItem,
  reviseHorizon,
  reviseYearDirection,
  rewordDecadeItem,
  rewordHorizon,
  rewordSeason,
  rewordYearDirection,
  startNewSeason,
  totalWorkedMs,
  unblockAction,
  validateActionOrder,
  WORK_HEARTBEAT_GAP_MS,
  type WorkInterval,
  weekStart,
  workedMsBetweenDates,
} from "@living-map/domain";
import { type Actor, type CommandContext, type CommandSource, createCommandContext } from "./context";
import {
  loadFocusState,
  openProjectSnapshots,
  snapshotOf,
  strategyState,
  toActionDto,
  toCourseImpactDto,
  toIntentionDto,
  toProjectViewDto,
  toRoutineItemDto,
  toSeasonDto,
  toStageDto,
  toStrategyDto,
  toStrategyHistoryDto,
} from "./map";
import {
  contextFingerprint,
  intentionTree,
  PLANNING_MEANINGS,
  parsePayload,
  routeChangeFromPayload,
  shortDigest,
  toPlanDto,
  toProposalDto,
} from "./planning";
import { type CommandName, isAllowed } from "./policy";
import {
  type AiRunOutcome,
  type ChangeLogEntry,
  type Clock,
  type IdGenerator,
  type ReadScope,
  type ReviewEvidencePack,
  type ReviewRunOutcome,
  SchemaConflictError,
  type Store,
  type WriteScope,
} from "./ports";
import { buildReviewEvidence, computeDueReviews } from "./review-evidence";

export type ApplicationDeps = {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  /** Technical diagnostics only; never receives user content beyond the thrown error. */
  reportError?: (operation: string, error: unknown) => void;
  /** IANA zone new work intervals are attributed to; defaults to the system zone. */
  timeZone?: () => string;
};

export { WORK_HEARTBEAT_GAP_MS };

const toGoodLifeConditionDto = (c: GoodLifeCondition): GoodLifeConditionDto => ({ ...c });
const toHouseholdItemDto = ({ version: _version, ...item }: HouseholdItem): HouseholdItemDto => item;
const toChangeLogEntryDto = (entry: ChangeLogEntry): ChangeLogEntryDto => ({ ...entry });
// sourceCaptureVerified (M-A) is internal Pattern-provenance bookkeeping, never exposed on the DTO.
const toMemoryDto = (m: Memory): MemoryDto => ({
  id: m.id,
  type: m.type,
  text: m.text,
  sourceCaptureId: m.sourceCaptureId,
  linkedEntityIds: [...m.linkedEntityIds],
  createdBy: m.createdBy,
  createdAt: m.createdAt,
});
const toReviewDto = (r: Review): ReviewDto => ({ ...r });

/**
 * The human-readable facts behind a finding's `evidenceRefs`, rebuilt live from the same deterministic
 * `buildReviewEvidence` the AI/validation already use — never a second source of truth, never business
 * logic duplicated in the renderer (M4 fix). A ref whose underlying record no longer exists (e.g. a
 * `memory.forget`d Memory) is silently omitted rather than shown as a dangling id.
 */
const EVIDENCE_ITEM_GONE = "Этой записи больше нет — например, если её забыли.";
function findingEvidenceItems(s: ReadScope, f: ReviewFinding): { id: string; text: string }[] {
  const review = s.reviews.findById(f.reviewId);
  // A missing review is a data-model impossibility here, not a "no evidence" case: keep the finding's
  // own ref count faithful (below) rather than silently showing zero facts for something the Pattern
  // engine still counts as evidence.
  const byId = review ? new Map(buildReviewEvidence(s, review).items.map((i) => [i.id, i.text])) : new Map();
  // One entry per cited ref, always — never fewer. A ref whose underlying record is gone (e.g. a
  // `memory.forget`d Memory) still counted as evidence when this finding was created and still counts
  // in the Pattern engine's independence check now: showing nothing here would let evidence silently
  // disappear from the owner's view while it keeps counting behind the scenes (M4 faithfulness).
  return f.evidenceRefs.map((ref) => ({ id: ref, text: byId.get(ref) ?? EVIDENCE_ITEM_GONE }));
}
const toReviewFindingDto = (s: ReadScope, f: ReviewFinding): ReviewFindingDto => ({
  ...f,
  evidenceRefs: [...f.evidenceRefs],
  evidenceItems: findingEvidenceItems(s, f),
});
const toReviewWithFindingsDto = (s: ReadScope, review: Review): ReviewWithFindingsDto => ({
  ...toReviewDto(review),
  findings: s.reviewFindings.listByReview(review.id).map((f) => toReviewFindingDto(s, f)),
});
/**
 * A Pattern candidate/confirmed/rejected row together with the concrete episodes behind it — the user
 * must be able to see why the system thinks this repeats, not just a finding count (M4 fix).
 */
const toPatternDto = (s: ReadScope, p: Pattern): PatternDto => ({
  ...p,
  evidenceFindingIds: [...p.evidenceFindingIds],
  supportingFindings: p.evidenceFindingIds.flatMap((id) => {
    const f = s.reviewFindings.findById(id);
    const review = f && s.reviews.findById(f.reviewId);
    if (!f || !review) return [];
    return [
      {
        id: f.id,
        reviewId: f.reviewId,
        reviewType: review.type,
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        text: acceptedFindingText(f) ?? f.text,
        evidenceItems: findingEvidenceItems(s, f),
      },
    ];
  }),
});
const toPlanningRuleDto = (r: PlanningRule): PlanningRuleDto => ({ ...r });

const FORGOTTEN_REPLY = "Этого больше нет в памяти.";

/** Stored JSON is re-validated on the way out: an unreadable result/error reads as absent, never as trusted. */
function toCaptureDtos(s: Pick<ReadScope, "memories" | "household">, captures: readonly Capture[]): CaptureDto[] {
  const memories = s.memories.listBySourceCaptures(captures.map((c) => c.id));
  const errands = s.household.listBySourceCaptures(captures.map((c) => c.id));
  return captures.map((c) => {
    const result = CaptureAiResultSchema.safeParse(c.result);
    const lastError = AiFailureSchema.safeParse(c.lastError);
    const own = memories.filter((m) => m.sourceCaptureId === c.id).map(toMemoryDto);
    // The user forgot what this run remembered: its old «Запомнила: …» reply must not keep echoing it to the
    // UI or to later AI runs. The raw text stays as typed; only the derived reply is withheld.
    const forgotten =
      result.success && (result.data.kind === "memory" || result.data.kind === "commitment") && !own.length;
    return {
      id: c.id,
      rawText: c.rawText,
      source: c.source,
      createdAt: c.createdAt,
      state: c.state,
      attempts: c.attempts,
      lastError: lastError.success ? lastError.data : null,
      result: !result.success ? null : forgotten ? { ...result.data, reply: FORGOTTEN_REPLY } : result.data,
      proposalId: c.proposalId,
      memories: own,
      householdItemId: errands.find((h) => h.sourceCaptureId === c.id)?.id ?? null,
    };
  });
}

/** Carries a failed Result out of a write transaction so the store rolls it back. */
class RollbackSignal {
  constructor(readonly result: Result<never>) {}
}

export function createApplication(deps: ApplicationDeps) {
  const { store, clock, ids } = deps;
  const timeZone = deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

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
    const now = clock.now();
    const tz = timeZone();
    // One batched query per project instead of one per Stage: this view is re-fetched after every write
    // (via the revision watcher), so an N+1 here would recur continuously.
    const focusState = loadFocusState(s, now, workingActionId(s, now), s.settings.selectedIntentionId());
    const { focus, currentAction, needsAiReplan } = focusState;
    const focusView = focus ? toProjectViewDto(focus) : undefined;
    const activeCount = focusState.projects.filter((p) => p.intention.status === "active").length;
    const snapshots = focusState.projects.map((p) => snapshotOf(p.intention, p.stages, p.actions));
    return {
      season: season ? toSeasonDto(season) : null,
      goodLifeConditions: s.goodLifeConditions.list().map(toGoodLifeConditionDto),
      intention: focusView?.intention ?? null,
      stages: focusView?.stages ?? [],
      orderedActionPlan: focusView?.orderedActionPlan ?? null,
      unplannedActionIds: focusView?.unplannedActionIds ?? [],
      projects: focusState.projects.map(toProjectViewDto),
      projectSlots: { active: activeCount, max: MAX_ACTIVE_INTENTIONS },
      strategy: toStrategyDto(s, strategyState(s, snapshots, now, tz), s.intentions.list(), tz),
      routines: s.routines.list().map(toRoutineItemDto),
      pendingProposals: s.proposals
        .listPending()
        .map((p) => toProposalDto(s, p, now))
        .filter((p): p is ProposalDto => p !== undefined),
      selectedProjectId: focusState.selectedProjectId,
      currentAction,
      needsAiReplan,
      calendarSnapshot: s.calendar.get(),
      execution: execution(s, currentAction?.actionId ?? null, now),
      reviewInbox: reviewInbox(s),
    };
  }

  /** Compact «Разборы» nav badge (Stage 7): counts only, never the full list. */
  function reviewInbox(s: Pick<ReadScope, "reviews" | "reviewFindings" | "patterns">): ReviewInboxDto {
    // "Ready" alone would never clear: a Review stays `ready` forever even after every finding is
    // resolved. The badge means "waits for you", so only a still-`proposed` finding counts.
    const readyReviews = s.reviews
      .listRecent(200)
      .filter(
        (r) => r.status === "ready" && s.reviewFindings.listByReview(r.id).some((f) => f.status === "proposed"),
      ).length;
    return { readyReviews, patternCandidates: s.patterns.listCandidates(200).length };
  }

  /** The Action really being worked on — it pins `Сейчас`; a silent interval (unnoticed sleep) does not. */
  function workingActionId(s: Pick<ReadScope, "work">, now: Instant): EntityId | null {
    const running = s.work.findRunning();
    return running && !isSilent(running, now) ? running.actionId : null;
  }

  /** The `Сейчас` Action as the view would show it — the only Action work may start on. */
  function currentActionId(s: ReadScope | WriteScope, now: Instant): EntityId | null {
    return (
      loadFocusState(s, now, workingActionId(s, now), s.settings.selectedIntentionId()).currentAction?.actionId ?? null
    );
  }

  function execution(s: Pick<ReadScope, "work" | "settings">, actionId: EntityId | null, now: Instant): ExecutionDto {
    const running = s.work.findRunning();
    const onAction = actionId ? s.work.listByAction(actionId) : [];
    const today = localDate(now, timeZone());
    const monday = weekStart(today);
    // Any zone is within ±14h of UTC, so a day of slack before Monday catches every candidate interval.
    const recent = s.work.listEndedSince(`${addDays(monday, -1)}T00:00:00.000Z`);
    return {
      // A silent interval (unnoticed sleep, killed app) is not shown as running: its time stopped growing.
      state:
        running && running.actionId === actionId && !isSilent(running, now)
          ? "running"
          : onAction.length > 0
            ? "paused"
            : "idle",
      actionId,
      actionWorkedMs: Math.round(totalWorkedMs(onAction, now)),
      todayWorkedMs: Math.round(workedMsBetweenDates(recent, today, addDays(today, 1), now)),
      weekWorkedMs: Math.round(workedMsBetweenDates(recent, monday, addDays(monday, 7), now)),
      dailyWorkTargetMinutes: s.settings.dailyWorkTargetMinutes(),
      computedAt: now,
    };
  }

  /** Stops `interval` at `at` (never before it started) and logs it; false if it already stopped. */
  function stopInterval(
    s: WriteScope,
    interval: WorkInterval,
    at: Instant,
    commandType: "work.pause" | "work.recover",
  ): Result<null> {
    if (!s.work.closeIfRunning(interval.id, closeAt(interval, at))) {
      return err("CONFLICT_RELOAD", "Work was already paused; reload");
    }
    s.recordChange({
      commandType,
      entityType: "action",
      entityId: interval.actionId,
      summary: commandType === "work.pause" ? "paused" : "paused after interruption",
    });
    return ok(null);
  }

  /** Complete/Block while running: the interval ends in the same transaction as the status change. */
  function stopIfRunningOn(s: WriteScope, actionId: EntityId, at: Instant): void {
    const running = s.work.findRunning();
    if (running?.actionId === actionId) s.work.closeIfRunning(running.id, closeAt(running, at));
  }

  function checkRevision(s: WriteScope, expected: number): Result<never> | undefined {
    const current = s.stateRevision();
    return current === expected
      ? undefined
      : err("CONFLICT_RELOAD", `Living Map changed (revision ${expected} → ${current}); reread the context and retry`);
  }

  /** Persists a status transition of a pending proposal and logs it (one entry, shared revision). */
  function resolveAndLog(
    s: WriteScope,
    ctx: CommandContext,
    proposal: Proposal,
    status: "accepted" | "rejected" | "stale",
  ): Result<Proposal> {
    const resolved = resolveProposal(proposal, status, ctx.actor, clock.now());
    if (!resolved.ok) return err("CONFLICT_RELOAD", `${resolved.reason}; reload`);
    if (!s.proposals.resolveIfPending(resolved.value)) {
      return err("CONFLICT_RELOAD", "Proposal changed concurrently; reload and retry");
    }
    s.recordChange({
      commandType: `proposal.${status === "accepted" ? "accept" : status === "rejected" ? "reject" : "stale"}`,
      entityType: "proposal",
      entityId: proposal.id,
      summary: proposal.kind,
    });
    return ok(resolved.value);
  }

  const markStale = (s: WriteScope, ctx: CommandContext, proposal: Proposal) =>
    resolveAndLog(s, ctx, proposal, "stale");

  /** Common checks + persistence for every AI proposal kind. */
  function insertProposal(
    s: WriteScope,
    ctx: CommandContext,
    input: {
      kind: Proposal["kind"];
      intentionId: string;
      payload: unknown;
      affected: string[];
      summary: string;
      rationale: string;
    },
  ): Result<ProposalDto> {
    // Idempotent per Capture: a retried run gets the Proposal its earlier attempt already made, never a second one.
    const capture = ctx.captureId ? s.captures.findById(ctx.captureId) : undefined;
    const earlier = capture?.proposalId ? s.proposals.findById(capture.proposalId) : undefined;
    if (earlier) {
      const dto = toProposalDto(s, earlier, clock.now());
      return dto ? ok(dto) : err("STORAGE_ERROR", "Proposal could not be read back");
    }
    // Pending proposals that can no longer apply (stale or unreadable) are persisted as stale first,
    // so they neither occupy the pending limit nor linger invisibly.
    const now = clock.now();
    for (const pending of s.proposals.listPending()) {
      if (toProposalDto(s, pending, now)?.status !== "pending") {
        const marked = markStale(s, ctx, pending);
        if (!marked.ok) return marked;
      }
    }
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
      summary: input.summary,
      rationale: input.rationale,
      now: clock.now(),
    });
    if (!created.ok) return err("VALIDATION_ERROR", created.reason);
    s.proposals.insert(created.value);
    if (capture) s.captures.linkProposal(capture.id, created.value.id);
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

  /**
   * Fact evidence → repeated accepted evidence → Pattern candidate (this stage's prompt §14–16).
   * Runs after a finding is accepted/corrected — a rejected finding never reaches here at all.
   */
  function maybeSurfacePatternCandidate(s: WriteScope, finding: ReviewFinding): void {
    const patternKey = finding.patternKey;
    if (!patternKey) return;
    const evidence = s.reviewFindings.listAcceptedByPatternKey(patternKey);
    // A single episode must never become a candidate, and review periods overlap by design (a day sits
    // inside its week/season/year): two Reviews can each cite the very same underlying fact(s) — even
    // under DIFFERENT evidence-ref spellings (a work interval cited directly by a daily finding and
    // aggregated into a `worktotal:` by a weekly one; a Capture and a Memory explicitly derived from
    // it). Comparing raw ref strings therefore is not enough — comparing canonical `evidenceFactIds`
    // (H2 fix) is.
    //
    // "Each review cites at least one fact no other review also cites" is NOT enough on its own: an
    // aggregate (`worktotal:`) can legitimately fold in several unrelated intervals from the same
    // period, so a daily and a weekly review can share the one fact that is actually the episode while
    // each still happens to have some OTHER, thematically irrelevant fact that makes it look "unique".
    // The only safe requirement is that at least two contributing Reviews' fact-id sets are PAIRWISE
    // DISJOINT — zero facts in common between that pair, not just "not identical" — a genuinely
    // independent episode, never a re-citation of someone else's under any spelling (this stage's §14).
    const factIdsByReview = new Map<string, Set<string>>();
    for (const f of evidence) {
      const set = factIdsByReview.get(f.reviewId) ?? new Set<string>();
      for (const factId of f.evidenceFactIds) set.add(factId);
      factIdsByReview.set(f.reviewId, set);
    }
    const reviewIds = [...factIdsByReview.keys()];
    const disjoint = (a: string, b: string): boolean => {
      const setA = factIdsByReview.get(a) as Set<string>;
      const setB = factIdsByReview.get(b) as Set<string>;
      // An empty fact set means unknown provenance (e.g. a pre-H2 row, migration default '[]'), not a
      // proven-independent one — treating it as vacuously disjoint from everything would let it "prove"
      // independence from any other review. Unknown provenance can never establish independence.
      if (setA.size === 0 || setB.size === 0) return false;
      for (const factId of setA) if (setB.has(factId)) return false;
      return true;
    };
    /** Any two reviews (subject to `filter`) with zero facts in common. */
    const hasDisjointPair = (filter?: (a: string, b: string) => boolean): boolean => {
      for (let i = 0; i < reviewIds.length; i++) {
        for (let j = i + 1; j < reviewIds.length; j++) {
          const a = reviewIds[i] as string;
          const b = reviewIds[j] as string;
          if ((!filter || filter(a, b)) && disjoint(a, b)) return true;
        }
      }
      return false;
    };
    if (!hasDisjointPair()) return;
    const evidenceFindingIds = evidence.map((f) => f.id);
    const now = clock.now();

    // At most one non-rejected Pattern exists per key at a time (this stage's prompt §15).
    const existing = s.patterns.findByKey(patternKey);
    if (existing?.status === "confirmed") return; // already an active rule for this theme
    if (existing?.status === "candidate") {
      if (existing.evidenceFindingIds.length >= evidenceFindingIds.length) return; // nothing new to add
      const grown = growPatternCandidate(existing, evidenceFindingIds, now);
      if (!grown.ok || !s.patterns.growIfCandidate(grown.value)) return;
      s.recordChange({
        commandType: "pattern.candidate",
        entityType: "pattern",
        entityId: grown.value.id,
        summary: `${evidenceFindingIds.length} evidence`,
      });
      return;
    }
    if (existing?.status === "rejected") {
      // Resurrection needs a genuinely NEW fact, not just a Review row the owner hadn't rejected by id
      // yet — a Review can be "new" while only re-citing a fact that was already part of what the owner
      // rejected (same fact, different evidence-ref spelling or a different Review). Compare against the
      // rejected FACT set, not the rejected REVIEW set.
      const rejectedFacts = new Set<string>();
      for (const f of evidence) {
        if (existing.evidenceFindingIds.includes(f.id)) {
          for (const factId of f.evidenceFactIds) rejectedFacts.add(factId);
        }
      }
      const hasNewFact = (reviewId: string): boolean => {
        for (const factId of factIdsByReview.get(reviewId) ?? []) if (!rejectedFacts.has(factId)) return true;
        return false;
      };
      if (!hasDisjointPair((a, b) => hasNewFact(a) || hasNewFact(b))) return;
    }
    const created = createPatternCandidate({
      id: ids.next(),
      patternKey,
      text: acceptedFindingText(finding) ?? finding.text,
      evidenceFindingIds,
      now,
    });
    if (!created.ok) return;
    s.patterns.insert(created.value);
    s.recordChange({
      commandType: "pattern.candidate",
      entityType: "pattern",
      entityId: created.value.id,
      summary: `${evidenceFindingIds.length} evidence`,
    });
  }

  /** Work running on a project that leaves the active state ends in the same transaction (like Готово/Block). */
  function stopWorkInProject(s: WriteScope, intentionId: EntityId, at: Instant): void {
    const running = s.work.findRunning();
    if (!running) return;
    const action = s.actions.findById(running.actionId);
    const stage = action && s.stages.findById(action.stageId);
    if (stage?.intentionId === intentionId) s.work.closeIfRunning(running.id, closeAt(running, at));
  }

  /**
   * An Action the commands may still touch: it exists AND its Stage is still part of the project's route. An
   * Action left in a Stage archived by an owner-approved plan replacement is history, never edited again.
   */
  function routeAction(s: WriteScope, id: EntityId) {
    const action = s.actions.findById(id);
    return action && s.stages.findById(action.stageId) ? action : undefined;
  }

  /** The owner-approved plan as it would be applied — the same pure domain function for preview and apply. */
  function computePlanReplacement(
    s: ReadScope | WriteScope,
    input: ApprovedProjectPlan,
  ): Result<{
    intention: Intention;
    before: ReturnType<typeof intentionTree>;
    outcome: PlanReplacement;
    fingerprint: string;
  }> {
    const intention = s.intentions.findById(input.intentionId);
    if (!intention) return err("NOT_FOUND", "Project not found");
    if (intention.status !== "active" && intention.status !== "deferred") {
      return err("VALIDATION_ERROR", "Only an active or paused project can get a new plan");
    }
    const before = intentionTree(s, intention.id);
    const outcome = planReplacement({
      intentionId: intention.id,
      stages: before.stages,
      actions: before.actions,
      approved: input.stages,
      nextId: () => ids.next(),
      now: clock.now(),
    });
    if (!outcome.ok) return err("VALIDATION_ERROR", outcome.reason);
    const { intentionId, rationale, stages } = input;
    const fingerprint = shortDigest(
      `${contextFingerprint(s, intention.id)}|${JSON.stringify({ intentionId, rationale, stages })}`,
    );
    return ok({ intention, before, outcome: outcome.value, fingerprint });
  }

  function toPlanReplacementDto(
    intention: Intention,
    before: ReturnType<typeof intentionTree>,
    outcome: PlanReplacement,
    fingerprint: string,
  ): ProjectPlanReplacementDto {
    const carried = new Set(outcome.movedActions.map((a) => a.id));
    const placed = [...outcome.insertedActions, ...outcome.movedActions];
    const byId = new Map(placed.map((a) => [a.id, a]));
    const firstId =
      outcome.orderedActionIds.find((id) => byId.get(id)?.status === "open") ?? (outcome.orderedActionIds[0] as string);
    return {
      intentionId: intention.id,
      projectTitle: intention.title,
      stages: outcome.stages.map((stage) => ({
        title: stage.title,
        isCurrent: stage.isCurrent,
        actions: placed
          .filter((a) => a.stageId === stage.id)
          .sort((a, b) => a.position - b.position)
          .map((a) => ({ id: a.id, title: a.title, status: a.status, carried: carried.has(a.id) })),
      })),
      archivedStages: before.stages.map((stage) => ({ id: stage.id, title: stage.title })),
      leftBehindActions: outcome.leftBehindActionIds.map((id) => ({
        id,
        title: before.actions.find((a) => a.id === id)?.title ?? "",
      })),
      keptDoneActions: before.actions.filter((a) => a.status === "done" && !carried.has(a.id)).length,
      firstAction: { id: firstId, title: byId.get(firstId)?.title ?? "" },
      fingerprint,
    };
  }

  /**
   * MODE B gate (Stage 8 §12): a change of course is applied only against the exact impact the owner was
   * shown. With nothing below to affect there is nothing to confirm. Nothing below is ever rewritten.
   */
  function gateCourse(
    s: WriteScope,
    level: CourseLevel,
    targetId: EntityId | null,
    fingerprint: string | undefined,
    proposed?: { startYear: number; endYear: number },
  ): Result<ImpactItem[]> {
    const state = strategyState(s, openProjectSnapshots(s), clock.now(), timeZone());
    const impact = computeCourseImpact(state, level, targetId, proposed);
    if (impact.length > 0 && fingerprint !== impactFingerprint(impact)) {
      return err(
        "REQUIRES_CONFIRMATION",
        "A change of course must be confirmed against the impact the owner has seen; preview it first",
      );
    }
    return ok(impact);
  }

  /** Keeps «посмотреть, что нужно пересобрать» alive after a change of course that actually affects something. */
  function recordCourseChange(
    s: WriteScope,
    level: CourseLevel,
    targetId: EntityId,
    summary: string,
    impact: readonly ImpactItem[],
  ): void {
    if (impact.length === 0) return;
    const created = createCourseChange({ id: ids.next(), level, targetId, summary, now: clock.now() });
    if (created.ok) s.courseChanges.insert(created.value);
  }

  /**
   * One owner edit of the decade plan / 3-year horizon / year. Adding needs nothing more. Editing something
   * that exists is either MODE A (`wording`: same meaning, only the words — years untouched, nothing else
   * looked at) or MODE B (`course`: the meaning changes — applied only against the shown impact). Nothing
   * below is ever rewritten; at most a course-change reminder is recorded.
   */
  function saveStrategyTx(s: WriteScope, input: SaveStrategyInput): Result<null> {
    const now = clock.now();
    const conflict = (version?: number) =>
      err<null>(
        "CONFLICT_RELOAD",
        version === undefined
          ? "Changed concurrently; reload and retry"
          : `Changed (now v${version}); reload and retry`,
      );
    const needMode = err<null>("VALIDATION_ERROR", "Say whether this is a wording edit or a change of course");
    const yearsMeanCourse = err<null>(
      "VALIDATION_ERROR",
      "Changing the years or the period's name changes the course, not just the wording",
    );
    /** Omitted = unchanged; otherwise compared the way it would be stored (empty = no label). */
    const labelChanges = (proposed: string | undefined, current: string | null) =>
      proposed !== undefined && (proposed.trim() || null) !== current;

    if (input.level === "decade") {
      const all = s.decades.list();
      if (input.id === undefined) {
        const created = createDecadeItem({
          id: ids.next(),
          startYear: input.startYear,
          endYear: input.endYear,
          statement: input.statement,
          label: input.label,
          others: all,
          now,
        });
        if (!created.ok) return err("VALIDATION_ERROR", created.reason);
        s.decades.insert(created.value);
        s.recordChange({
          commandType: "strategy.decade.add",
          entityType: "decade",
          entityId: created.value.id,
          summary: `${created.value.label ?? `${created.value.startYear}–${created.value.endYear}`}: ${created.value.statement}`,
        });
        return ok(null);
      }
      const current = all.find((d) => d.id === input.id);
      if (!current) return err("NOT_FOUND", "Decade item not found");
      if (input.expectedVersion === undefined || !isAtVersion(current, input.expectedVersion)) {
        return conflict(current.version);
      }
      if (input.mode === undefined) return needMode;
      if (input.mode === "wording") {
        if (
          input.startYear !== current.startYear ||
          input.endYear !== current.endYear ||
          labelChanges(input.label, current.label)
        ) {
          return yearsMeanCourse;
        }
        const next = rewordDecadeItem(current, input.statement, now);
        if (!next.ok) return err("VALIDATION_ERROR", next.reason);
        if (!s.decades.updateIfVersion(next.value, input.expectedVersion)) return conflict();
        s.recordChange({
          commandType: "strategy.decade.reword",
          entityType: "decade",
          entityId: current.id,
          summary: next.value.statement,
        });
        return ok(null);
      }
      const gate = gateCourse(s, "decade", current.id, input.impactFingerprint, {
        startYear: input.startYear,
        endYear: input.endYear,
      });
      if (!gate.ok) return gate;
      const next = reviseDecadeItem(
        current,
        { startYear: input.startYear, endYear: input.endYear, statement: input.statement, label: input.label },
        all.filter((d) => d.id !== current.id),
        now,
      );
      if (!next.ok) return err("VALIDATION_ERROR", next.reason);
      if (!s.decades.updateIfVersion(next.value, input.expectedVersion)) return conflict();
      s.recordChange({
        commandType: "strategy.decade.course",
        entityType: "decade",
        entityId: current.id,
        summary: `${next.value.label ?? `${next.value.startYear}–${next.value.endYear}`}: ${next.value.statement}`,
      });
      recordCourseChange(s, "decade", current.id, next.value.statement, gate.value);
      return ok(null);
    }

    if (input.level === "horizon") {
      const current = s.horizon.get();
      if (!current) {
        if (input.expectedVersion !== undefined) return err("NOT_FOUND", "The 3-year horizon is not set yet");
        const created = createHorizon({
          id: ids.next(),
          startYear: input.startYear,
          direction: input.direction,
          whyItMatters: input.whyItMatters,
          now,
        });
        if (!created.ok) return err("VALIDATION_ERROR", created.reason);
        s.horizon.insert(created.value);
        s.recordChange({
          commandType: "strategy.horizon.set",
          entityType: "horizon",
          entityId: created.value.id,
          summary: created.value.direction,
        });
        return ok(null);
      }
      if (input.expectedVersion === undefined || !isAtVersion(current, input.expectedVersion)) {
        return conflict(current.version);
      }
      if (input.mode === undefined) return needMode;
      if (input.mode === "wording") {
        if (input.startYear !== current.startYear) return yearsMeanCourse;
        const next = rewordHorizon(current, { direction: input.direction, whyItMatters: input.whyItMatters }, now);
        if (!next.ok) return err("VALIDATION_ERROR", next.reason);
        if (!s.horizon.updateIfVersion(next.value, input.expectedVersion)) return conflict();
        s.recordChange({
          commandType: "strategy.horizon.reword",
          entityType: "horizon",
          entityId: current.id,
          summary: next.value.direction,
        });
        return ok(null);
      }
      const gate = gateCourse(s, "horizon", current.id, input.impactFingerprint);
      if (!gate.ok) return gate;
      const next = reviseHorizon(
        current,
        { startYear: input.startYear, direction: input.direction, whyItMatters: input.whyItMatters },
        now,
      );
      if (!next.ok) return err("VALIDATION_ERROR", next.reason);
      if (!s.horizon.updateIfVersion(next.value, input.expectedVersion)) return conflict();
      s.recordChange({
        commandType: "strategy.horizon.course",
        entityType: "horizon",
        entityId: current.id,
        summary: next.value.direction,
      });
      recordCourseChange(s, "horizon", current.id, next.value.direction, gate.value);
      return ok(null);
    }

    const current = s.year.get();
    if (!current) {
      if (input.expectedVersion !== undefined) return err("NOT_FOUND", "The year direction is not set yet");
      const created = createYearDirection({
        id: ids.next(),
        year: input.year,
        label: input.label,
        direction: input.direction,
        whyItMatters: input.whyItMatters,
        now,
      });
      if (!created.ok) return err("VALIDATION_ERROR", created.reason);
      s.year.insert(created.value);
      s.recordChange({
        commandType: "strategy.year.set",
        entityType: "year",
        entityId: created.value.id,
        summary: created.value.direction,
      });
      return ok(null);
    }
    if (input.expectedVersion === undefined || !isAtVersion(current, input.expectedVersion)) {
      return conflict(current.version);
    }
    if (input.mode === undefined) return needMode;
    if (input.mode === "wording") {
      if (input.year !== current.year || labelChanges(input.label, current.label)) return yearsMeanCourse;
      const next = rewordYearDirection(current, { direction: input.direction, whyItMatters: input.whyItMatters }, now);
      if (!next.ok) return err("VALIDATION_ERROR", next.reason);
      if (!s.year.updateIfVersion(next.value, input.expectedVersion)) return conflict();
      s.recordChange({
        commandType: "strategy.year.reword",
        entityType: "year",
        entityId: current.id,
        summary: next.value.direction,
      });
      return ok(null);
    }
    const gate = gateCourse(s, "year", current.id, input.impactFingerprint);
    if (!gate.ok) return gate;
    const next = reviseYearDirection(
      current,
      { year: input.year, label: input.label, direction: input.direction, whyItMatters: input.whyItMatters },
      now,
    );
    if (!next.ok) return err("VALIDATION_ERROR", next.reason);
    if (!s.year.updateIfVersion(next.value, input.expectedVersion)) return conflict();
    s.recordChange({
      commandType: "strategy.year.course",
      entityType: "year",
      entityId: current.id,
      summary: next.value.direction,
    });
    recordCourseChange(s, "year", current.id, next.value.direction, gate.value);
    return ok(null);
  }

  const notActive = () =>
    err<never>("VALIDATION_ERROR", "The project is not active; only an active project can be planned");

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

      /** The project that leads `Сейчас` (the first active one in the owner's order), if any. */
      getActiveIntention: (): Result<IntentionDto | null> =>
        guarded("getActiveIntention", () => {
          const active = store.read((s) => activeIntentions(s.intentions.list())[0]);
          return ok(active ? toIntentionDto(active) : null);
        }),

      getCurrentView: (): Result<CurrentViewDto> => guarded("getCurrentView", () => ok(store.read(currentView))),

      /**
       * One coherent planning snapshot for an external AI (MCP get_living_map_context). Daily routines are
       * deliberately left out: they are the owner's stable infrastructure of the day, not strategic context.
       */
      getPlanningContext: (): Result<PlanningContextDto> =>
        guarded("getPlanningContext", () =>
          ok(
            store.read((s) => {
              const { routines: _routines, ...view } = currentView(s);
              return {
                stateRevision: s.stateRevision(),
                meanings: PLANNING_MEANINGS,
                ...view,
                recentHistory: s.changeLog.listRecent(30).map(toChangeLogEntryDto),
                activePlanningRules: s.planningRules.listActive().map(toPlanningRuleDto),
              };
            }),
          ),
        ),

      /** Past seasons and the projects closed during the current one (Full Map history). Desktop only. */
      getStrategyHistory: (): Result<StrategyHistoryDto> =>
        guarded("getStrategyHistory", () => ok(store.read(toStrategyHistoryDto))),

      /**
       * What a change of course at `level` may affect, with the fingerprint the owner must hand back to
       * confirm it. Pure read: it describes, it never rewrites anything below.
       */
      previewCourseImpact: (input: PreviewCourseImpactInput): Result<CourseImpactDto> =>
        guarded("previewCourseImpact", () =>
          store.read((s) => {
            if (input.level === "decade" && input.targetId && !s.decades.findById(input.targetId)) {
              return err("NOT_FOUND", "Decade item not found");
            }
            const state = strategyState(s, openProjectSnapshots(s), clock.now(), timeZone());
            const proposed =
              input.level === "decade" && input.startYear !== undefined && input.endYear !== undefined
                ? { startYear: input.startYear, endYear: input.endYear }
                : undefined;
            const items = computeCourseImpact(state, input.level, input.targetId ?? null, proposed);
            return ok(toCourseImpactDto(input.level, input.targetId ?? null, items));
          }),
        ),

      /**
       * Dry run of an owner-approved plan (Stage 9): exactly what `replaceProjectPlan` would do, nothing
       * written. The new ids it shows are throwaway — applying generates its own.
       */
      previewProjectPlanReplacement: (input: ApprovedProjectPlan): Result<ProjectPlanReplacementDto> =>
        guarded("previewProjectPlanReplacement", () =>
          store.read((s) => {
            const computed = computePlanReplacement(s, input);
            if (!computed.ok) return computed;
            const { intention, before, outcome, fingerprint } = computed.value;
            return ok(toPlanReplacementDto(intention, before, outcome, fingerprint));
          }),
        ),

      /** «Быт»: active errands (oldest first) and the 20 most recently done. Never part of the AI context. */
      listHouseholdItems: (): Result<HouseholdListDto> =>
        guarded("listHouseholdItems", () =>
          ok(
            store.read((s) => ({
              active: s.household.listActive().map(toHouseholdItemDto),
              recentlyDone: s.household.listRecentlyDone(20).map(toHouseholdItemDto),
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

      /** Recent `+` Captures, newest first, with their processing state, AI result and saved memories. */
      listCaptures: (input: ListCapturesInput): Result<CaptureDto[]> =>
        guarded("listCaptures", () =>
          ok(store.read((s) => toCaptureDtos(s, s.captures.listRecent(input.limit, input.state)))),
        ),

      searchMemory: (input: SearchMemoryInput): Result<MemoryDto[]> =>
        guarded("searchMemory", () =>
          ok(
            store.read((s) =>
              rankMemories(
                s.memories.list().filter((m) => !input.entityId || m.linkedEntityIds.includes(input.entityId)),
                input.query,
                input.limit,
              ).map(toMemoryDto),
            ),
          ),
        ),

      /** Reviews (Stage 7), newest first. Desktop only — never reachable from MCP. */
      listReviews: (input: ListReviewsInput): Result<ReviewDto[]> =>
        guarded("listReviews", () => ok(store.read((s) => s.reviews.listRecent(input.limit)).map(toReviewDto))),

      getReview: (input: GetReviewInput): Result<ReviewWithFindingsDto> =>
        guarded("getReview", () =>
          store.read((s) => {
            const review = s.reviews.findById(input.id);
            return review ? ok(toReviewWithFindingsDto(s, review)) : err("NOT_FOUND", "Review not found");
          }),
        ),

      listPatternCandidates: (input: ListPatternCandidatesInput): Result<PatternDto[]> =>
        guarded("listPatternCandidates", () =>
          ok(store.read((s) => s.patterns.listCandidates(input.limit).map((p) => toPatternDto(s, p)))),
        ),

      listPlanningRules: (input: ListPlanningRulesInput): Result<PlanningRuleDto[]> =>
        guarded("listPlanningRules", () =>
          ok(store.read((s) => s.planningRules.listAll(input.limit)).map(toPlanningRuleDto)),
        ),

      /** The evidence pack for a claimed Review — the closed set of facts the AI may cite (§21). Desktop processor only. */
      getReviewEvidence: (input: { id: string }): Result<ReviewEvidencePack> =>
        guarded("getReviewEvidence", () =>
          store.read((s) => {
            const review = s.reviews.findById(input.id);
            return review ? ok(buildReviewEvidence(s, review)) : err("NOT_FOUND", "Review not found");
          }),
        ),
    },

    commands: {
      createSeason: (ctx: CommandContext, input: CreateSeasonInput): Result<SeasonDto> =>
        authorize("season.create", ctx) ??
        guarded("createSeason", () =>
          transact(ctx, (s): Result<SeasonDto> => {
            if (s.season.get()) return err("VALIDATION_ERROR", "A season already exists; use updateSeasonFocus");
            const created = createSeason({
              id: ids.next(),
              focus: input.focus,
              whyItMatters: input.whyItMatters,
              now: clock.now(),
            });
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
            const now = clock.now();
            // A wording edit (MODE A) and an actual season change (MODE B) are recorded under different
            // commandTypes (M2 fix): only `season.changeSeason` is a seasonal-Review boundary
            // (`SEASON_COMMANDS`, review-evidence.ts) — the owner says which this is, since the system
            // cannot reliably infer "still the same stretch of life, reworded" from "the season turned".
            if (!input.startsNewSeason) {
              const reworded = rewordSeason(current, { focus: input.focus, whyItMatters: input.whyItMatters }, now);
              if (!reworded.ok) return err("VALIDATION_ERROR", reworded.reason);
              if (!s.season.updateIfVersion(reworded.value, input.expectedVersion)) {
                return err("CONFLICT_RELOAD", "Season changed concurrently; reload and retry");
              }
              s.recordChange({
                commandType: "season.updateFocus",
                entityType: "season",
                entityId: current.id,
                summary: `v${current.version}→v${reworded.value.version}`,
              });
              return ok(toSeasonDto(reworded.value));
            }
            const gate = gateCourse(s, "season", current.id, input.impactFingerprint);
            if (!gate.ok) return gate;
            const turned = startNewSeason(
              current,
              { focus: input.focus, whyItMatters: input.whyItMatters, historyId: ids.next() },
              now,
            );
            if (!turned.ok) return err("VALIDATION_ERROR", turned.reason);
            s.seasonHistory.insert(turned.value.ended);
            if (!s.season.updateIfVersion(turned.value.season, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Season changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "season.changeSeason",
              entityType: "season",
              entityId: current.id,
              summary: `v${current.version}→v${turned.value.season.version}`,
            });
            recordCourseChange(s, "season", current.id, turned.value.season.focus, gate.value);
            return ok(toSeasonDto(turned.value.season));
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
            // The Season holds at most three active projects (usually one or two). Never silently exceed it:
            // the owner must complete, release or pause one first (ACTIVE_PROJECT_LIMIT).
            const all = s.intentions.list();
            if (!hasRoomForActive(all)) {
              return err(
                "ACTIVE_PROJECT_LIMIT",
                `At most ${MAX_ACTIVE_INTENTIONS} projects can be active; complete, release or pause one first`,
              );
            }
            const created = createIntention({
              id: ids.next(),
              title: input.title,
              desiredResult: input.desiredResult,
              whyItMatters: input.whyItMatters,
              position: nextActivePosition(all),
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
            const current = routeAction(s, input.id);
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
            const current = routeAction(s, input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const completed = completeAction(current, clock.now());
            if (!completed.ok) return err("VALIDATION_ERROR", completed.reason);
            // Готово while running (Stage 5 §11): one command, one revision — the time is saved too.
            stopIfRunningOn(s, current.id, completed.value.updatedAt);
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
            const current = routeAction(s, input.id);
            if (!current) return err("NOT_FOUND", "Action not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Action changed (now v${current.version}); reload and retry`);
            }
            const blocked = blockAction(current, input.reason, clock.now());
            if (!blocked.ok) return err("VALIDATION_ERROR", blocked.reason);
            // A blocked Action cannot be worked on: never keep recording time against it.
            stopIfRunningOn(s, current.id, blocked.value.updatedAt);
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
            const current = routeAction(s, input.id);
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
            const current = routeAction(s, input.id);
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
            if (!s.stages.findById(input.stageId)) return err("NOT_FOUND", "Stage not found");
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

      /**
       * Owner only (Stage 8): complete, release, pause, resume or bring back a project. Resuming past three
       * active is a typed ACTIVE_PROJECT_LIMIT result — never a silent bypass (the database trigger is the
       * backstop). Work running on a project that leaves the active state stops in the same transaction.
       */
      changeIntentionStatus: (ctx: CommandContext, input: ChangeIntentionStatusInput): Result<IntentionDto> =>
        authorize("intention.changeStatus", ctx) ??
        guarded("changeIntentionStatus", () =>
          transact(ctx, (s): Result<IntentionDto> => {
            const current = s.intentions.findById(input.id);
            if (!current) return err("NOT_FOUND", "Intention not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Intention changed (now v${current.version}); reload and retry`);
            }
            const now = clock.now();
            const changed = changeIntentionStatus(s.intentions.list(), input.id, input.to, now);
            if (!changed.ok) return err(changed.limit ? "ACTIVE_PROJECT_LIMIT" : "VALIDATION_ERROR", changed.reason);
            if (input.to !== "active") stopWorkInProject(s, input.id, now);
            if (!s.intentions.updateIfVersion(changed.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Intention changed concurrently; reload and retry");
            }
            // A project that leaves the active state can no longer be the one the owner works on.
            if (input.to !== "active" && s.settings.selectedIntentionId() === input.id) {
              s.settings.setSelectedIntentionId(null);
            }
            const commandType =
              input.to === "completed"
                ? "intention.complete"
                : input.to === "released"
                  ? "intention.release"
                  : input.to === "active"
                    ? "intention.activate"
                    : current.status === "active"
                      ? "intention.defer"
                      : "intention.reopen";
            s.recordChange({ commandType, entityType: "intention", entityId: current.id, summary: current.title });
            return ok(toIntentionDto(changed.value));
          }),
        ),

      /** The owner's order of the active projects: the first one is asked first for `Сейчас`. */
      reorderProjects: (ctx: CommandContext, input: ReorderProjectsInput): Result<IntentionDto[]> =>
        authorize("intention.reorder", ctx) ??
        guarded("reorderProjects", () =>
          transact(ctx, (s): Result<IntentionDto[]> => {
            const active = activeIntentions(s.intentions.list());
            const positions = computeReorder(
              active.map((i) => i.id),
              input.orderedIds,
            );
            if (!positions.ok) return err("VALIDATION_ERROR", positions.reason);
            s.intentions.reorder(positions.value, clock.now());
            s.recordChange({
              commandType: "intention.reorder",
              entityType: "intention",
              entityId: "all",
              summary: "project order changed",
            });
            return ok(activeIntentions(s.intentions.list()).map(toIntentionDto));
          }),
        ),

      /** Decade plan / 3-year horizon / year: add, reword (MODE A) or change course (MODE B). Owner only. */
      saveStrategy: (ctx: CommandContext, input: SaveStrategyInput): Result<null> =>
        authorize("strategy.save", ctx) ??
        guarded("saveStrategy", () => transact(ctx, (s) => saveStrategyTx(s, input))),

      /** Removing a decade statement is a change of course too: confirmed against the impact it was previewed with. */
      removeDecadeItem: (ctx: CommandContext, input: RemoveDecadeItemInput): Result<null> =>
        authorize("strategy.remove", ctx) ??
        guarded("removeDecadeItem", () =>
          transact(ctx, (s): Result<null> => {
            const current = s.decades.findById(input.id);
            if (!current) return err("NOT_FOUND", "Decade item not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Decade item changed (now v${current.version}); reload and retry`);
            }
            const gate = gateCourse(s, "decade", current.id, input.impactFingerprint);
            if (!gate.ok) return gate;
            if (!s.decades.removeIfVersion(current.id, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Decade item changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "strategy.decade.remove",
              entityType: "decade",
              entityId: current.id,
              summary: `${current.startYear}–${current.endYear}: ${current.statement}`,
            });
            recordCourseChange(s, "decade", current.id, current.statement, gate.value);
            return ok(null);
          }),
        ),

      /** «Всё пересобрано»: the owner closes the reminder after a change of course. */
      resolveCourseChange: (ctx: CommandContext, input: ResolveCourseChangeInput): Result<null> =>
        authorize("strategy.resolveCourseChange", ctx) ??
        guarded("resolveCourseChange", () =>
          transact(ctx, (s): Result<null> => {
            const current = s.courseChanges.findById(input.id);
            if (!current) return err("NOT_FOUND", "Course change not found");
            const resolved = resolveCourseChange(current, clock.now());
            if (!resolved.ok) return err("CONFLICT_RELOAD", `${resolved.reason}; reload`);
            if (!s.courseChanges.resolveIfOpen(resolved.value)) {
              return err("CONFLICT_RELOAD", "Course change changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "strategy.courseChange.resolve",
              entityType: "course_change",
              entityId: current.id,
              summary: current.summary,
            });
            return ok(null);
          }),
        ),

      addRoutineItem: (ctx: CommandContext, input: AddRoutineItemInput): Result<RoutineItemDto> =>
        authorize("routine.add", ctx) ??
        guarded("addRoutineItem", () =>
          transact(ctx, (s): Result<RoutineItemDto> => {
            const created = createRoutineItem({
              id: ids.next(),
              kind: input.kind,
              text: input.text,
              siblingCount: s.routines.listByKind(input.kind).length,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.routines.insert(created.value);
            s.recordChange({
              commandType: "routine.add",
              entityType: "routine",
              entityId: created.value.id,
              summary: created.value.kind,
            });
            return ok(toRoutineItemDto(created.value));
          }),
        ),

      editRoutineItem: (ctx: CommandContext, input: EditRoutineItemInput): Result<RoutineItemDto> =>
        authorize("routine.edit", ctx) ??
        guarded("editRoutineItem", () =>
          transact(ctx, (s): Result<RoutineItemDto> => {
            const current = s.routines.findById(input.id);
            if (!current) return err("NOT_FOUND", "Routine item not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Routine item changed (now v${current.version}); reload and retry`);
            }
            const edited = editRoutineItem(current, { text: input.text, active: input.active }, clock.now());
            if (!edited.ok) return err("VALIDATION_ERROR", edited.reason);
            if (!s.routines.updateIfVersion(edited.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Routine item changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "routine.edit",
              entityType: "routine",
              entityId: current.id,
              summary: `v${current.version}→v${edited.value.version}`,
            });
            return ok(toRoutineItemDto(edited.value));
          }),
        ),

      removeRoutineItem: (ctx: CommandContext, input: RemoveRoutineItemInput): Result<null> =>
        authorize("routine.remove", ctx) ??
        guarded("removeRoutineItem", () =>
          transact(ctx, (s): Result<null> => {
            const current = s.routines.findById(input.id);
            if (!current) return err("NOT_FOUND", "Routine item not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Routine item changed (now v${current.version}); reload and retry`);
            }
            if (!s.routines.removeIfVersion(input.id, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Routine item changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "routine.remove",
              entityType: "routine",
              entityId: input.id,
              summary: current.kind,
            });
            // Close the gap, so the next item added never shares a position with a survivor.
            const rest = s.routines.listByKind(current.kind).map((i) => i.id);
            const positions = computeReorder(rest, rest);
            if (positions.ok) s.routines.reorder(positions.value, clock.now());
            return ok(null);
          }),
        ),

      reorderRoutineItems: (ctx: CommandContext, input: ReorderRoutineItemsInput): Result<RoutineItemDto[]> =>
        authorize("routine.reorder", ctx) ??
        guarded("reorderRoutineItems", () =>
          transact(ctx, (s): Result<RoutineItemDto[]> => {
            const positions = computeReorder(
              s.routines.listByKind(input.kind).map((i) => i.id),
              input.orderedIds,
            );
            if (!positions.ok) return err("VALIDATION_ERROR", positions.reason);
            s.routines.reorder(positions.value, clock.now());
            s.recordChange({
              commandType: "routine.reorder",
              entityType: "routine",
              entityId: input.kind,
              summary: "order changed",
            });
            return ok(s.routines.listByKind(input.kind).map(toRoutineItemDto));
          }),
        ),

      /** PROPOSAL (mcp-ai): a first route or a replan. Validated by a full dry run; never applied here. */
      createRouteProposal: (ctx: CommandContext, input: CreateRouteProposalInput): Result<ProposalDto> =>
        authorize("proposal.create", ctx) ??
        guarded("createRouteProposal", () =>
          transact(ctx, (s): Result<ProposalDto> => {
            const conflict = checkRevision(s, input.expectedRevision);
            if (conflict) return conflict;
            const target = s.intentions.findById(input.intentionId);
            if (!target) return err("NOT_FOUND", "Intention not found");
            if (target.status !== "active") return notActive();

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

            const plan = s.plans.findByIntention(input.intentionId);
            const payload: RoutePayload = {
              intentionId: input.intentionId,
              isFirstRoute: !plan,
              newStages: [...change.value.newStages],
              stageEdits: [...change.value.stageEdits],
              newActions: [...change.value.newActions],
              actionEdits: [...change.value.actionEdits],
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
              summary: input.summary,
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
            if (intention.status !== "active") return notActive();
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
              summary: input.summary,
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
                proposal.status === "stale" ? "STALE_PROPOSAL" : "CONFLICT_RELOAD",
                `Proposal is already ${proposal.status}`,
              );
            }
            const now = clock.now();
            const finish = (status: "accepted" | "stale"): Result<Outcome> => {
              const resolved = resolveAndLog(s, ctx, proposal, status);
              if (!resolved.ok) return resolved;
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

      /** The user's refusal (user-ui only). Dismissing one that can no longer apply records it as stale. */
      rejectProposal: (ctx: CommandContext, input: ResolveProposalInput): Result<null> =>
        authorize("proposal.reject", ctx) ??
        guarded("rejectProposal", () =>
          transact(ctx, (s): Result<null> => {
            const proposal = s.proposals.findById(input.id);
            if (!proposal) return err("NOT_FOUND", "Proposal not found");
            const actionable = toProposalDto(s, proposal, clock.now())?.status === "pending";
            const resolved = resolveAndLog(s, ctx, proposal, actionable ? "rejected" : "stale");
            return resolved.ok ? ok(null) : resolved;
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
            // The order must be reasoned against the world the AI actually read (not just the plan row).
            const conflict = checkRevision(s, input.expectedRevision);
            if (conflict) return conflict;
            const owner = s.intentions.findById(input.intentionId);
            if (!owner) return err("NOT_FOUND", "Intention not found");
            if (owner.status !== "active") return notActive();
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
            // A no-op would still bump the plan version and stale every pending route proposal.
            if (order.value.join() === plan.orderedActionIds.join() && input.rationale.trim() === plan.rationale) {
              return err("VALIDATION_ERROR", "Order and rationale are unchanged; nothing to do");
            }
            const next = replacePlanOrder(
              plan,
              {
                orderedActionIds: order.value,
                rationale: input.rationale,
                createdBy: ctx.actor,
                sourceRevision: input.expectedRevision,
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
              // mcp-ai's SAFE WRITE reorder is the AI acting on a Capture's news (H-A fix): without this
              // link, the reorder's changelog line and the Capture that prompted it are the same lived
              // episode under two unrelated evidence ids.
              sourceCaptureId: ctx.captureId ?? null,
            });
            return ok(toPlanDto(next.value));
          }),
        ),

      /**
       * Persists a freshly fetched calendar snapshot (ARCHITECTURE §32). The desktop main process is
       * the only caller: it fetches the private iCal feed itself, then hands the already-mapped DTO
       * here — the actual HTTP call happens outside any write transaction (ARCHITECTURE §12
       * forbids I/O inside `store.write`). mcp-ai has no path to this command (policy.ts).
       */
      saveCalendarSnapshot: (ctx: CommandContext, input: CalendarSnapshotDto): Result<CalendarSnapshotDto> =>
        authorize("calendar.save", ctx) ??
        guarded("saveCalendarSnapshot", () =>
          transact(ctx, (s): Result<CalendarSnapshotDto> => {
            s.calendar.save(input);
            s.recordChange({
              commandType: "calendar.save",
              entityType: "calendar",
              entityId: "calendar",
              summary: !input.connected ? "disconnected" : input.lastError ? `error: ${input.lastError}` : "synced",
            });
            return ok(input);
          }),
        ),

      /** Начать / Продолжить. Only the current `Сейчас` Action, only when nothing else runs. */
      startWork: (ctx: CommandContext, input: WorkActionInput): Result<ExecutionDto> =>
        authorize("work.start", ctx) ??
        guarded("startWork", () =>
          transact(ctx, (s): Result<ExecutionDto> => {
            const now = clock.now();
            const running = s.work.findRunning();
            if (running && isSilent(running, now)) {
              // Resuming after an unnoticed sleep: first stop the silent interval at its checkpoint.
              const stopped = stopInterval(s, running, running.lastHeartbeatAt, "work.recover");
              if (!stopped.ok) return stopped;
            } else if (running) return err("CONFLICT_RELOAD", "Work is already running; reload");
            if (currentActionId(s, now) !== input.actionId) {
              return err("CONFLICT_RELOAD", "This Action is no longer the current one; reload");
            }
            const resumed = s.work.listByAction(input.actionId).length > 0;
            s.work.insert({
              id: ids.next(),
              actionId: input.actionId,
              startedAt: now,
              endedAt: null,
              lastHeartbeatAt: now,
              timeZone: timeZone(),
            });
            s.recordChange({
              commandType: resumed ? "work.resume" : "work.start",
              entityType: "action",
              entityId: input.actionId,
              summary: resumed ? "resumed" : "started",
            });
            return ok(execution(s, input.actionId, now));
          }),
        ),

      /** Пауза. Repeating it (double click, stale UI) is a CONFLICT_RELOAD, never a second interval. */
      pauseWork: (ctx: CommandContext, input: WorkActionInput): Result<ExecutionDto> =>
        authorize("work.pause", ctx) ??
        guarded("pauseWork", () =>
          transact(ctx, (s): Result<ExecutionDto> => {
            const now = clock.now();
            const running = s.work.findRunning();
            if (running?.actionId !== input.actionId) return err("CONFLICT_RELOAD", "Work is not running; reload");
            const stopped = stopInterval(s, running, now, "work.pause");
            return stopped.ok ? ok(execution(s, input.actionId, now)) : stopped;
          }),
        ),

      /** App quit / OS suspend: pauses whatever is running; a no-op (no write) when nothing is. */
      pauseRunningWork: (ctx: CommandContext): Result<null> =>
        authorize("work.pause", ctx) ??
        guarded("pauseRunningWork", () =>
          transact(ctx, (s): Result<null> => {
            const running = s.work.findRunning();
            return running ? stopInterval(s, running, clock.now(), "work.pause") : ok(null);
          }),
        ),

      /**
       * Desktop startup: an interval still open now was left by a crash / power loss. It is capped at
       * its last trustworthy checkpoint and becomes paused — offline time never counts as work.
       */
      recoverInterruptedWork: (ctx: CommandContext): Result<null> =>
        authorize("work.recover", ctx) ??
        guarded("recoverInterruptedWork", () =>
          transact(ctx, (s): Result<null> => {
            const running = s.work.findRunning();
            return running ? stopInterval(s, running, running.lastHeartbeatAt, "work.recover") : ok(null);
          }),
        ),

      /**
       * ~Once a minute while the app runs. Normally only moves the technical checkpoint (no revision,
       * no history). A checkpoint older than WORK_HEARTBEAT_GAP_MS means the process was not really
       * running (missed suspend event, frozen VM, clock jump): cap there and pause, like a crash.
       */
      heartbeatWork: (ctx: CommandContext): Result<"idle" | "checkpoint" | "recovered"> =>
        authorize("work.recover", ctx) ??
        guarded("heartbeatWork", (): Result<"idle" | "checkpoint" | "recovered"> => {
          const running = store.read((s) => s.work.findRunning());
          if (!running) return ok("idle");
          const now = clock.now();
          const gap = new Date(now).getTime() - new Date(running.lastHeartbeatAt).getTime();
          if (gap <= WORK_HEARTBEAT_GAP_MS && gap >= 0) {
            store.touchWorkHeartbeat(running.id, now);
            return ok("checkpoint");
          }
          if (gap < 0) {
            // The clock went backwards: keep the later checkpoint, do not invent time.
            return ok("checkpoint");
          }
          const recovered = transact(ctx, (s) => stopInterval(s, running, running.lastHeartbeatAt, "work.recover"));
          return recovered.ok ? ok("recovered") : recovered;
        }),

      /** «Норма»: a user setting. Changes only the comparison text, never recorded time. */
      setDailyWorkTarget: (ctx: CommandContext, input: SetDailyWorkTargetInput): Result<ExecutionDto> =>
        authorize("settings.dailyWorkTarget", ctx) ??
        guarded("setDailyWorkTarget", () =>
          transact(ctx, (s): Result<ExecutionDto> => {
            const now = clock.now();
            if (s.settings.dailyWorkTargetMinutes() === input.minutes) {
              return err("VALIDATION_ERROR", "Daily work target is unchanged");
            }
            s.settings.setDailyWorkTargetMinutes(input.minutes);
            s.recordChange({
              commandType: "settings.dailyWorkTarget",
              entityType: "settings",
              entityId: "dailyWorkTarget",
              summary: `${input.minutes}`,
            });
            return ok(execution(s, currentActionId(s, now), now));
          }),
        ),

      /**
       * «Над каким проектом я сейчас работаю?» (Stage 9, Day 1). The owner may pick any active project with
       * something admissible in its order; `Сейчас` then follows THAT project's own approved order until she
       * picks another. Not strategy: project order, plans and versions stay untouched (no proposal goes stale).
       * Work running on another project is paused first — never two running intervals, never time moved
       * across projects — and nothing is started on the new one: the owner presses «Начать» herself.
       */
      selectWorkProject: (ctx: CommandContext, input: SelectWorkProjectInput): Result<null> =>
        authorize("work.selectProject", ctx) ??
        guarded("selectWorkProject", () =>
          transact(ctx, (s): Result<null> => {
            const now = clock.now();
            const target = s.intentions.findById(input.intentionId);
            if (!target) return err("NOT_FOUND", "Project not found");
            if (target.status !== "active") return err("VALIDATION_ERROR", "Only an active project can be worked on");
            const usable = loadFocusState(s, now, null).projects.find((p) => p.intention.id === target.id);
            if (!usable?.selection.currentAction) {
              return err(
                "NEEDS_AI_REPLAN",
                "Nothing in this project's order can be done now; ask the AI to rebuild it",
              );
            }
            const running = s.work.findRunning();
            if (running) {
              const action = s.actions.findById(running.actionId);
              const stage = action && s.stages.findById(action.stageId);
              if (stage?.intentionId !== target.id) {
                const stopped = stopInterval(s, running, now, "work.pause");
                if (!stopped.ok) return stopped;
              }
            }
            if (s.settings.selectedIntentionId() !== target.id) {
              s.settings.setSelectedIntentionId(target.id);
              s.recordChange({
                commandType: "work.selectProject",
                entityType: "intention",
                entityId: target.id,
                summary: "selected for work",
              });
            }
            return ok(null);
          }),
        ),

      /**
       * Applies an owner-approved operational plan to ONE existing project (Stage 9, Day 1): the plan was
       * designed outside the app with the owner and is applied deterministically, exactly as given — never an
       * AI guess (no MCP path; owner/system only). The project keeps its id, status, desired result and Season
       * link. The previous Stages are archived as history: finished Actions, work time and review evidence stay
       * intact; unfinished Actions the plan does not carry over stay inactive, never deleted. Work running on
       * the project pauses. Pending AI proposals about it go stale on their own (the route changed).
       */
      replaceProjectPlan: (ctx: CommandContext, input: ReplaceProjectPlanInput): Result<ProjectPlanReplacementDto> =>
        authorize("plan.replace", ctx) ??
        guarded("replaceProjectPlan", () =>
          transact(ctx, (s): Result<ProjectPlanReplacementDto> => {
            const computed = computePlanReplacement(s, input);
            if (!computed.ok) return computed;
            const { intention, before, outcome, fingerprint } = computed.value;
            // Applied only against the exact dry run the owner saw (like a MODE B change of course).
            if (input.expectedFingerprint !== fingerprint) {
              return err(
                "REQUIRES_CONFIRMATION",
                "The project or the plan changed since the dry run the owner saw; run the dry run again",
              );
            }
            const now = clock.now();
            // Before archiving: the running Action's Stage must still be found to know it is this project's.
            stopWorkInProject(s, intention.id, now);
            s.stages.archive(outcome.archivedStageIds, now);
            for (const stage of outcome.stages) s.stages.insert(stage);
            for (const action of outcome.insertedActions) s.actions.insert(action);
            const versionOf = new Map(before.actions.map((a) => [a.id, a.version]));
            for (const action of outcome.movedActions) {
              if (!s.actions.relocateIfVersion(action, versionOf.get(action.id) as number)) {
                return err("CONFLICT_RELOAD", "Action changed concurrently; reload and retry");
              }
            }
            const order = {
              orderedActionIds: outcome.orderedActionIds,
              rationale: input.rationale,
              createdBy: ctx.actor,
              sourceRevision: s.stateRevision(),
            };
            const existing = s.plans.findByIntention(intention.id);
            if (existing) {
              const next = replacePlanOrder(existing, order, now);
              if (!next.ok) return err("VALIDATION_ERROR", next.reason);
              if (!s.plans.updateIfVersion(next.value, existing.version)) {
                return err("CONFLICT_RELOAD", "Plan changed concurrently; reload and retry");
              }
            } else {
              const created = createPlan({ id: ids.next(), intentionId: intention.id, ...order, now });
              if (!created.ok) return err("VALIDATION_ERROR", created.reason);
              s.plans.insert(created.value);
            }
            s.recordChange({
              commandType: "plan.replace",
              entityType: "intention",
              entityId: intention.id,
              summary: `${outcome.stages.length} stages, ${outcome.orderedActionIds.length} open actions; archived ${outcome.archivedStageIds.length} stages, left behind ${outcome.leftBehindActionIds.length}`,
            });
            return ok(toPlanReplacementDto(intention, before, outcome, fingerprint));
          }),
        ),

      /**
       * «Быт» (Stage 9, Day 1): the owner writes down a one-off errand — directly, or by accepting the AI's
       * suggestion for a «+» record (`sourceCaptureId`, provenance; the Capture itself is never changed).
       */
      addHouseholdItem: (ctx: CommandContext, input: AddHouseholdItemInput): Result<HouseholdItemDto> =>
        authorize("household.add", ctx) ??
        guarded("addHouseholdItem", () =>
          transact(ctx, (s): Result<HouseholdItemDto> => {
            const sourceCaptureId = input.sourceCaptureId ?? null;
            if (sourceCaptureId) {
              if (!s.captures.findById(sourceCaptureId)) return err("NOT_FOUND", "Capture not found");
              if (s.household.listBySourceCaptures([sourceCaptureId]).length > 0) {
                return err("CONFLICT_RELOAD", "This record is already in «Быт»; reload");
              }
            }
            const created = createHouseholdItem({
              id: ids.next(),
              text: input.text,
              sourceCaptureId,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.household.insert(created.value);
            s.recordChange({
              commandType: "household.add",
              entityType: "household",
              entityId: created.value.id,
              summary: sourceCaptureId ? "added from «+»" : "added",
            });
            return ok(toHouseholdItemDto(created.value));
          }),
        ),

      /** «Сделано»: the errand leaves the active list and stays as minimal history. No timer, no work time. */
      completeHouseholdItem: (ctx: CommandContext, input: CompleteHouseholdItemInput): Result<HouseholdItemDto> =>
        authorize("household.complete", ctx) ??
        guarded("completeHouseholdItem", () =>
          transact(ctx, (s): Result<HouseholdItemDto> => {
            const current = s.household.findById(input.id);
            if (!current) return err("NOT_FOUND", "Household item not found");
            const done = completeHouseholdItem(current, clock.now());
            if (!done.ok) return err("CONFLICT_RELOAD", `${done.reason}; reload`);
            if (!s.household.completeIfActive(done.value))
              return err("CONFLICT_RELOAD", "Changed concurrently; reload");
            s.recordChange({
              commandType: "household.complete",
              entityType: "household",
              entityId: current.id,
              summary: "done",
            });
            return ok(toHouseholdItemDto(done.value));
          }),
        ),

      /** Universal `+`: the raw text is committed here, before any AI is involved (ARCHITECTURE §34). */
      createCapture: (ctx: CommandContext, input: SubmitCaptureInput): Result<CaptureDto> =>
        authorize("capture.create", ctx) ??
        guarded("createCapture", () =>
          transact(ctx, (s): Result<CaptureDto> => {
            const created = createCapture({ id: ids.next(), rawText: input.rawText, now: clock.now() });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            s.captures.insert(created.value);
            s.recordChange({
              commandType: "capture.create",
              entityType: "capture",
              entityId: created.value.id,
              summary: "saved",
            });
            return ok(toCaptureDtos(s, [created.value])[0] as CaptureDto);
          }),
        ),

      /** «Повторить»: a failed Capture waits for the AI again. */
      retryCapture: (ctx: CommandContext, input: RetryCaptureInput): Result<CaptureDto> =>
        authorize("capture.retry", ctx) ??
        guarded("retryCapture", () =>
          transact(ctx, (s): Result<CaptureDto> => {
            if (!s.captures.findById(input.id)) return err("NOT_FOUND", "Capture not found");
            if (!s.captures.requeue(input.id, clock.now())) {
              return err("CONFLICT_RELOAD", "Capture is not waiting for a retry; reload");
            }
            s.recordChange({
              commandType: "capture.retry",
              entityType: "capture",
              entityId: input.id,
              summary: "retry",
            });
            return ok(toCaptureDtos(s, [s.captures.findById(input.id) as Capture])[0] as CaptureDto);
          }),
        ),

      /** Desktop processor only: atomically takes the oldest pending Capture (pending → processing). */
      claimNextCapture: (ctx: CommandContext): Result<CaptureDto | null> =>
        authorize("capture.process", ctx) ??
        guarded("claimNextCapture", () =>
          transact(ctx, (s): Result<CaptureDto | null> => {
            const next = s.captures.findNextPending();
            if (!next || !s.captures.claim(next.id, clock.now())) return ok(null);
            s.recordChange({
              commandType: "capture.claim",
              entityType: "capture",
              entityId: next.id,
              summary: `attempt ${next.attempts + 1}`,
            });
            return ok(toCaptureDtos(s, [s.captures.findById(next.id) as Capture])[0] as CaptureDto);
          }),
        ),

      /**
       * Desktop processor only: records the AI outcome of a claimed Capture. The result is validated again
       * here (never trusted from the transport); an unknown proposal id is dropped, not linked.
       */
      finishCapture: (ctx: CommandContext, input: { id: string; outcome: AiRunOutcome }): Result<CaptureDto> =>
        authorize("capture.process", ctx) ??
        guarded("finishCapture", () =>
          transact(ctx, (s): Result<CaptureDto> => {
            let outcome: { result: unknown } | { lastError: string };
            if (input.outcome.ok) {
              const parsed = CaptureAiResultSchema.safeParse(input.outcome.result);
              // The recorded link wins over whatever id the AI reported.
              const proposalId =
                s.captures.findById(input.id)?.proposalId ?? (parsed.success && parsed.data.proposalId);
              const proposal = proposalId && s.proposals.findById(proposalId);
              outcome = parsed.success
                ? {
                    result: {
                      ...parsed.data,
                      proposalId: proposal && proposal.createdBy === "mcp-ai" ? proposal.id : null,
                    },
                  }
                : { lastError: "malformed" };
            } else {
              outcome = { lastError: AiFailureSchema.catch("failed").parse(input.outcome.failure) };
            }
            if (!s.captures.finish(input.id, outcome, clock.now())) {
              return err("CONFLICT_RELOAD", "Capture is not being processed");
            }
            s.recordChange({
              commandType: "result" in outcome ? "capture.processed" : "capture.failed",
              entityType: "capture",
              entityId: input.id,
              summary: "result" in outcome ? (outcome.result as { kind: string }).kind : outcome.lastError,
            });
            return ok(toCaptureDtos(s, [s.captures.findById(input.id) as Capture])[0] as CaptureDto);
          }),
        ),

      /** Desktop launch only: an interrupted `processing` and a not-yet-exhausted `failed` wait again. */
      recoverCaptures: (ctx: CommandContext): Result<number> =>
        authorize("capture.process", ctx) ??
        guarded("recoverCaptures", () =>
          transact(ctx, (s): Result<number> => {
            const changed = s.captures.recover(CAPTURE_AUTO_RETRY_ATTEMPTS, clock.now());
            if (changed > 0) {
              s.recordChange({
                commandType: "capture.recover",
                entityType: "capture",
                entityId: "all",
                summary: `${changed}`,
              });
            }
            return ok(changed);
          }),
        ),

      /** SAFE WRITE (mcp-ai): remember something. A second memory of the same type from the same Capture is a no-op. */
      saveMemory: (ctx: CommandContext, input: SaveMemoryInput): Result<MemoryDto> =>
        authorize("memory.save", ctx) ??
        guarded("saveMemory", () =>
          transact(ctx, (s): Result<MemoryDto> => {
            // The run's own Capture (from its trusted context) wins over the id the AI passed. Only
            // ctx.captureId proves this Memory came from that Capture's own processing job — an AI-
            // supplied captureId from any other session (e.g. interactive Desktop-chat, ADR-0004) is
            // still a real Stage-6 association, but not verified provenance for Pattern purposes (M-A).
            const captureId = ctx.captureId ?? input.captureId;
            const sourceCaptureVerified = ctx.captureId !== undefined;
            if (captureId && !s.captures.findById(captureId)) return err("NOT_FOUND", "Capture not found");
            const missing = input.linkedEntityIds.find(
              (id) =>
                !s.intentions.findById(id) &&
                !s.stages.findById(id) &&
                !s.actions.findById(id) &&
                !s.proposals.findById(id),
            );
            if (missing) return err("NOT_FOUND", `Linked entity ${missing} not found`);
            const created = createMemory({
              id: ids.next(),
              type: input.type,
              text: input.text,
              sourceCaptureId: captureId,
              sourceCaptureVerified,
              linkedEntityIds: input.linkedEntityIds,
              createdBy: ctx.actor,
              now: clock.now(),
            });
            if (!created.ok) return err("VALIDATION_ERROR", created.reason);
            // ponytail: one memory per type per Capture, so a retried run cannot store a reworded duplicate;
            // a Capture holding two ideas keeps the first — key by content if that ever matters.
            const same =
              captureId && s.memories.listBySourceCaptures([captureId]).find((m) => m.type === created.value.type);
            if (same) {
              // This run's own trusted context just vouched for exactly this Capture+type: upgrade the
              // existing (possibly untethered-session-created, unverified) row rather than silently
              // discarding the trusted job's provenance (M-A). Every row mutation must record a change
              // (ARCHITECTURE §44) — a distinct "memory.verify" type, not "memory.save", so this
              // bookkeeping-only upgrade never shows up as a second "AI saved a memory" in the user's
              // history feed (it is excluded the same way as capture.claim/review.claim etc., below).
              if (sourceCaptureVerified && !same.sourceCaptureVerified) {
                s.memories.verifySourceCapture(same.id);
                s.recordChange({
                  commandType: "memory.verify",
                  entityType: "memory",
                  entityId: same.id,
                  summary: same.type,
                });
              }
              return ok(toMemoryDto(same));
            }
            s.memories.insert(created.value);
            s.recordChange({
              commandType: "memory.save",
              entityType: "memory",
              entityId: created.value.id,
              summary: created.value.type,
            });
            return ok(toMemoryDto(created.value));
          }),
        ),

      /**
       * USER-only: forget a memory. Hard delete, so search, MCP and every future AI run lose it at once;
       * the source Capture (what the user actually typed) is left untouched.
       */
      forgetMemory: (ctx: CommandContext, input: ForgetMemoryInput): Result<null> =>
        authorize("memory.forget", ctx) ??
        guarded("forgetMemory", () =>
          transact(ctx, (s): Result<null> => {
            if (!s.memories.remove(input.id)) return err("NOT_FOUND", "Memory not found");
            s.recordChange({ commandType: "memory.forget", entityType: "memory", entityId: input.id, summary: "" });
            return ok(null);
          }),
        ),

      /**
       * Desktop launch/scheduler only (system): creates a `needs_ai` Review row for every currently
       * due period (this stage's prompt §9/§10) that does not already have one. Cheap date math + row
       * inserts — the potentially slow part (AI processing) happens later, one Review at a time, via
       * claimNextReview/finishReview, exactly like the Capture queue.
       */
      scheduleDueReviews: (ctx: CommandContext, input: { timeZone: string }): Result<number> =>
        authorize("review.schedule", ctx) ??
        guarded("scheduleDueReviews", () =>
          transact(ctx, (s): Result<number> => {
            const now = clock.now();
            const due = computeDueReviews(s, now, input.timeZone).filter(
              (p) => !s.reviews.existsForPeriod(p.type, p.periodStart, p.periodEnd),
            );
            for (const period of due) {
              const created = createReview({ id: ids.next(), timeZone: input.timeZone, now, ...period });
              if (!created.ok) continue; // defensive; the scheduler never produces an invalid period
              s.reviews.insert(created.value);
              s.recordChange({
                commandType: "review.due",
                entityType: "review",
                entityId: created.value.id,
                summary: created.value.type,
              });
            }
            return ok(due.length);
          }),
        ),

      /** Desktop processor only: atomically takes the oldest `needs_ai` Review (needs_ai → processing). */
      claimNextReview: (ctx: CommandContext): Result<ReviewDto | null> =>
        authorize("review.process", ctx) ??
        guarded("claimNextReview", () =>
          transact(ctx, (s): Result<ReviewDto | null> => {
            const next = s.reviews.findNextPending();
            if (!next || !s.reviews.claim(next.id, clock.now())) return ok(null);
            s.recordChange({
              commandType: "review.claim",
              entityType: "review",
              entityId: next.id,
              summary: `attempt ${next.attempts + 1}`,
            });
            return ok(toReviewDto(s.reviews.findById(next.id) as Review));
          }),
        ),

      /**
       * Desktop processor only: records the AI outcome of a claimed Review. Evidence is re-validated
       * against a freshly rebuilt pack (never trusted from the AI) — any evidenceRef outside that
       * closed set, or any other malformed shape, fails the whole result: no partial findings are
       * ever written (this stage's prompt §20/§21).
       */
      finishReview: (
        ctx: CommandContext,
        input: { id: string; outcome: ReviewRunOutcome },
      ): Result<ReviewWithFindingsDto> =>
        authorize("review.process", ctx) ??
        guarded("finishReview", () =>
          transact(ctx, (s): Result<ReviewWithFindingsDto> => {
            const review = s.reviews.findById(input.id);
            if (!review) return err("NOT_FOUND", "Review not found");
            const now = clock.now();

            const fail = (lastError: string): Result<ReviewWithFindingsDto> => {
              if (!s.reviews.finish(input.id, { lastError }, now))
                return err("CONFLICT_RELOAD", "Review is not being processed");
              s.recordChange({
                commandType: "review.failed",
                entityType: "review",
                entityId: input.id,
                summary: lastError,
              });
              return ok(toReviewWithFindingsDto(s, s.reviews.findById(input.id) as Review));
            };

            if (!input.outcome.ok) return fail(AiFailureSchema.catch("failed").parse(input.outcome.failure));

            const parsed = ReviewAiResultSchema.safeParse(input.outcome.result);
            if (!parsed.success) return fail("malformed");

            if (parsed.data.kind === "no_useful_change") {
              if (!s.reviews.finish(input.id, { status: "no_useful_change" }, now)) {
                return err("CONFLICT_RELOAD", "Review is not being processed");
              }
              s.recordChange({
                commandType: "review.processed",
                entityType: "review",
                entityId: input.id,
                summary: "no_useful_change",
              });
              return ok(toReviewWithFindingsDto(s, s.reviews.findById(input.id) as Review));
            }

            const evidenceItems = buildReviewEvidence(s, review).items;
            const validIds = new Set(evidenceItems.map((i) => i.id));
            const factIdsByRef = new Map(evidenceItems.map((i) => [i.id, i.factIds]));
            const built: ReviewFinding[] = [];
            for (const draft of parsed.data.findings) {
              if (draft.evidenceRefs.some((ref) => !validIds.has(ref))) return fail("malformed"); // fabricated/nonexistent reference
              const created = createReviewFinding({
                id: ids.next(),
                reviewId: review.id,
                text: draft.text,
                evidenceRefs: draft.evidenceRefs,
                // Canonical underlying-fact identity behind the cited refs (H2 fix) — resolved here,
                // once, from the same pack evidenceRefs were just validated against; never trusted from
                // the AI, which never sees factIds at all.
                evidenceFactIds: draft.evidenceRefs.flatMap((ref) => factIdsByRef.get(ref) ?? []),
                suggestion: draft.suggestion,
                patternKey: draft.patternKey,
                now,
              });
              if (!created.ok) return fail("malformed");
              built.push(created.value);
            }
            for (const finding of built) {
              s.reviewFindings.insert(finding);
              s.recordChange({
                commandType: "review.findingCreated",
                entityType: "review_finding",
                entityId: finding.id,
                summary: finding.patternKey ?? "",
              });
            }
            if (!s.reviews.finish(input.id, { status: "ready" }, now)) {
              return err("CONFLICT_RELOAD", "Review is not being processed");
            }
            s.recordChange({
              commandType: "review.processed",
              entityType: "review",
              entityId: input.id,
              summary: "ready",
            });
            return ok(toReviewWithFindingsDto(s, s.reviews.findById(input.id) as Review));
          }),
        ),

      /** Desktop launch only: an interrupted `processing` and a not-yet-exhausted `failed` wait again. */
      recoverReviews: (ctx: CommandContext): Result<number> =>
        authorize("review.process", ctx) ??
        guarded("recoverReviews", () =>
          transact(ctx, (s): Result<number> => {
            const changed = s.reviews.recover(REVIEW_AUTO_RETRY_ATTEMPTS, clock.now());
            if (changed > 0) {
              s.recordChange({
                commandType: "review.recover",
                entityType: "review",
                entityId: "all",
                summary: `${changed}`,
              });
            }
            return ok(changed);
          }),
        ),

      /** «Повторить»: a failed Review waits for the AI again. */
      retryReview: (ctx: CommandContext, input: RetryReviewInput): Result<ReviewDto> =>
        authorize("review.retry", ctx) ??
        guarded("retryReview", () =>
          transact(ctx, (s): Result<ReviewDto> => {
            if (!s.reviews.findById(input.id)) return err("NOT_FOUND", "Review not found");
            if (!s.reviews.requeue(input.id, clock.now()))
              return err("CONFLICT_RELOAD", "Review is not waiting for a retry; reload");
            s.recordChange({ commandType: "review.retry", entityType: "review", entityId: input.id, summary: "retry" });
            return ok(toReviewDto(s.reviews.findById(input.id) as Review));
          }),
        ),

      /** «Всё верно»: the AI's draft finding is accepted as is. */
      acceptReviewFinding: (ctx: CommandContext, input: AcceptReviewFindingInput): Result<ReviewFindingDto> =>
        authorize("reviewFinding.accept", ctx) ??
        guarded("acceptReviewFinding", () =>
          transact(ctx, (s): Result<ReviewFindingDto> => {
            const current = s.reviewFindings.findById(input.id);
            if (!current) return err("NOT_FOUND", "Finding not found");
            const accepted = acceptFinding(current, clock.now());
            if (!accepted.ok) return err("CONFLICT_RELOAD", `${accepted.reason}; reload`);
            if (!s.reviewFindings.resolveIfProposed(accepted.value)) {
              return err("CONFLICT_RELOAD", "Finding changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "reviewFinding.accept",
              entityType: "review_finding",
              entityId: current.id,
              summary: "",
            });
            maybeSurfacePatternCandidate(s, accepted.value);
            return ok(toReviewFindingDto(s, accepted.value));
          }),
        ),

      /** The user's correction becomes the accepted learning; the AI's original draft stays intact. */
      correctReviewFinding: (ctx: CommandContext, input: CorrectReviewFindingInput): Result<ReviewFindingDto> =>
        authorize("reviewFinding.correct", ctx) ??
        guarded("correctReviewFinding", () =>
          transact(ctx, (s): Result<ReviewFindingDto> => {
            const current = s.reviewFindings.findById(input.id);
            if (!current) return err("NOT_FOUND", "Finding not found");
            const corrected = correctFinding(current, input.text, input.keepPattern, clock.now());
            if (!corrected.ok)
              return err(
                corrected.reason.includes("already") ? "CONFLICT_RELOAD" : "VALIDATION_ERROR",
                corrected.reason,
              );
            if (!s.reviewFindings.resolveIfProposed(corrected.value)) {
              return err("CONFLICT_RELOAD", "Finding changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "reviewFinding.correct",
              entityType: "review_finding",
              entityId: current.id,
              summary: input.keepPattern ? "keepPattern" : "",
            });
            maybeSurfacePatternCandidate(s, corrected.value);
            return ok(toReviewFindingDto(s, corrected.value));
          }),
        ),

      /** Ignore: never becomes Pattern evidence. */
      rejectReviewFinding: (ctx: CommandContext, input: RejectReviewFindingInput): Result<ReviewFindingDto> =>
        authorize("reviewFinding.reject", ctx) ??
        guarded("rejectReviewFinding", () =>
          transact(ctx, (s): Result<ReviewFindingDto> => {
            const current = s.reviewFindings.findById(input.id);
            if (!current) return err("NOT_FOUND", "Finding not found");
            const rejected = rejectFinding(current, clock.now());
            if (!rejected.ok) return err("CONFLICT_RELOAD", `${rejected.reason}; reload`);
            if (!s.reviewFindings.resolveIfProposed(rejected.value)) {
              return err("CONFLICT_RELOAD", "Finding changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "reviewFinding.reject",
              entityType: "review_finding",
              entityId: current.id,
              summary: "",
            });
            return ok(toReviewFindingDto(s, rejected.value));
          }),
        ),

      /** «Сделать правилом»: confirms the candidate AND activates its PlanningRule, atomically. AI/MCP has no path here. */
      confirmPattern: (ctx: CommandContext, input: ConfirmPatternInput): Result<PatternDto> =>
        authorize("pattern.confirm", ctx) ??
        guarded("confirmPattern", () =>
          transact(ctx, (s): Result<PatternDto> => {
            const current = s.patterns.findById(input.id);
            if (!current) return err("NOT_FOUND", "Pattern not found");
            const confirmed = confirmPattern(current, ctx.actor, clock.now());
            if (!confirmed.ok) return err("CONFLICT_RELOAD", `${confirmed.reason}; reload`);
            if (!s.patterns.resolveIfCandidate(confirmed.value)) {
              return err("CONFLICT_RELOAD", "Pattern changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "pattern.confirm",
              entityType: "pattern",
              entityId: current.id,
              summary: "",
            });
            const rule = createPlanningRule({
              id: ids.next(),
              text: confirmed.value.text,
              sourcePatternId: confirmed.value.id,
              now: clock.now(),
            });
            s.planningRules.insert(rule);
            s.recordChange({
              commandType: "planningRule.activate",
              entityType: "planning_rule",
              entityId: rule.id,
              summary: "",
            });
            return ok(toPatternDto(s, confirmed.value));
          }),
        ),

      /** «Не считать правилом». New later evidence may still justify a fresh candidate. */
      rejectPattern: (ctx: CommandContext, input: RejectPatternInput): Result<PatternDto> =>
        authorize("pattern.reject", ctx) ??
        guarded("rejectPattern", () =>
          transact(ctx, (s): Result<PatternDto> => {
            const current = s.patterns.findById(input.id);
            if (!current) return err("NOT_FOUND", "Pattern not found");
            const rejected = rejectPattern(current, ctx.actor, clock.now());
            if (!rejected.ok) return err("CONFLICT_RELOAD", `${rejected.reason}; reload`);
            if (!s.patterns.resolveIfCandidate(rejected.value)) {
              return err("CONFLICT_RELOAD", "Pattern changed concurrently; reload and retry");
            }
            s.recordChange({ commandType: "pattern.reject", entityType: "pattern", entityId: current.id, summary: "" });
            return ok(toPatternDto(s, rejected.value));
          }),
        ),

      /** The user can deactivate an active rule at any time; excluded from planning context from then on. */
      deactivatePlanningRule: (ctx: CommandContext, input: DeactivatePlanningRuleInput): Result<PlanningRuleDto> =>
        authorize("planningRule.deactivate", ctx) ??
        guarded("deactivatePlanningRule", () =>
          transact(ctx, (s): Result<PlanningRuleDto> => {
            const current = s.planningRules.findById(input.id);
            if (!current) return err("NOT_FOUND", "Planning rule not found");
            const deactivated = deactivatePlanningRule(current, clock.now());
            if (!deactivated.ok) return err("CONFLICT_RELOAD", `${deactivated.reason}; reload`);
            if (!s.planningRules.deactivateIfActive(deactivated.value)) {
              return err("CONFLICT_RELOAD", "Planning rule changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "planningRule.deactivate",
              entityType: "planning_rule",
              entityId: current.id,
              summary: "",
            });
            return ok(toPlanningRuleDto(deactivated.value));
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
