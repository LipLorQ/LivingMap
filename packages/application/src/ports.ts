import type { AiFailure, CalendarSnapshotDto, CaptureAiResult, ReviewAiResult } from "@living-map/contracts";
import type {
  Action,
  Capture,
  CaptureState,
  CourseChange,
  DecadePlanItem,
  EntityId,
  GoodLifeCondition,
  HouseholdItem,
  Instant,
  Intention,
  Memory,
  OrderedActionPlan,
  Pattern,
  PlanningRule,
  Proposal,
  Review,
  ReviewFinding,
  ReviewType,
  RoutineItem,
  RoutineKind,
  Season,
  SeasonHistoryEntry,
  Stage,
  ThreeYearHorizon,
  Version,
  WorkInterval,
  YearDirection,
} from "@living-map/domain";

export interface Clock {
  now(): Instant;
}

export interface IdGenerator {
  next(): EntityId;
}

export interface SeasonReader {
  get(): Season | undefined;
}

export interface SeasonRepository extends SeasonReader {
  insert(season: Season): void;
  /** Persists only if the stored version still equals `expectedVersion`; false otherwise. */
  updateIfVersion(season: Season, expectedVersion: Version): boolean;
}

/** Past seasons (Stage 8): written once, when a season really turns; never edited. */
export interface SeasonHistoryReader {
  /** Newest first. */
  list(): SeasonHistoryEntry[];
}

export interface SeasonHistoryRepository extends SeasonHistoryReader {
  insert(entry: SeasonHistoryEntry): void;
}

export interface DecadePlanReader {
  findById(id: EntityId): DecadePlanItem | undefined;
  /** Ordered by start year. */
  list(): DecadePlanItem[];
}

export interface DecadePlanRepository extends DecadePlanReader {
  insert(item: DecadePlanItem): void;
  updateIfVersion(item: DecadePlanItem, expectedVersion: Version): boolean;
  removeIfVersion(id: EntityId, expectedVersion: Version): boolean;
}

/** At most one row exists — "one current 3-year horizon" is also a database fact. */
export interface HorizonReader {
  get(): ThreeYearHorizon | undefined;
}

export interface HorizonRepository extends HorizonReader {
  insert(horizon: ThreeYearHorizon): void;
  updateIfVersion(horizon: ThreeYearHorizon, expectedVersion: Version): boolean;
}

/** At most one row exists — "one current year direction". */
export interface YearDirectionReader {
  get(): YearDirection | undefined;
}

export interface YearDirectionRepository extends YearDirectionReader {
  insert(year: YearDirection): void;
  updateIfVersion(year: YearDirection, expectedVersion: Version): boolean;
}

export interface RoutineReader {
  findById(id: EntityId): RoutineItem | undefined;
  /** Morning items first, then evening, each by position. */
  list(): RoutineItem[];
  listByKind(kind: RoutineKind): RoutineItem[];
}

export interface RoutineRepository extends RoutineReader {
  insert(item: RoutineItem): void;
  updateIfVersion(item: RoutineItem, expectedVersion: Version): boolean;
  removeIfVersion(id: EntityId, expectedVersion: Version): boolean;
  reorder(positions: ReadonlyMap<EntityId, number>, now: Instant): void;
}

export interface CourseChangeReader {
  findById(id: EntityId): CourseChange | undefined;
  /** Not yet resolved by the owner, oldest first. */
  listOpen(): CourseChange[];
  /** Every one ever recorded: their ids are part of the planning fingerprint, so a change of course stales pending proposals. */
  listAll(): CourseChange[];
}

export interface CourseChangeRepository extends CourseChangeReader {
  insert(change: CourseChange): void;
  /** Persists `resolvedAt` only if the stored row is still open; false otherwise. */
  resolveIfOpen(change: CourseChange): boolean;
}

export interface GoodLifeConditionReader {
  findById(id: EntityId): GoodLifeCondition | undefined;
  list(): GoodLifeCondition[];
}

export interface GoodLifeConditionRepository extends GoodLifeConditionReader {
  insert(condition: GoodLifeCondition): void;
  updateIfVersion(condition: GoodLifeCondition, expectedVersion: Version): boolean;
  removeIfVersion(id: EntityId, expectedVersion: Version): boolean;
  /** Manual reorder (this stage's prompt §13): a full-list position replace, not a strategic plan. */
  reorder(positions: ReadonlyMap<EntityId, number>, now: Instant): void;
}

export interface IntentionReader {
  findById(id: EntityId): Intention | undefined;
  /** Every Intention in every lifecycle state, oldest first. */
  list(): Intention[];
}

export interface IntentionRepository extends IntentionReader {
  insert(intention: Intention): void;
  /** Persists title, result, why, status, position and closedAt. */
  updateIfVersion(intention: Intention, expectedVersion: Version): boolean;
  /** Manual order of the active projects: a full position replace (no version bump — order is not content). */
  reorder(positions: ReadonlyMap<EntityId, number>, now: Instant): void;
}

/**
 * Live Stages only: a Stage archived by an owner-approved plan replacement (Stage 9) is history — it is
 * never returned here, so no command, order, `Сейчас` or proposal can reach it or its Actions again.
 */
export interface StageReader {
  findById(id: EntityId): Stage | undefined;
  listByIntention(intentionId: EntityId): Stage[];
}

export interface StageRepository extends StageReader {
  insert(stage: Stage): void;
  /** Persists title and position (a route proposal may change both). */
  updateIfVersion(stage: Stage, expectedVersion: Version): boolean;
  reorder(positions: ReadonlyMap<EntityId, number>, now: Instant): void;
  /**
   * Sets exactly one Stage of `intentionId` current, atomically, keeping the invariant unambiguous.
   * Bumps version/updatedAt only on the rows whose `isCurrent` flag actually changes — this is a
   * selection, not a content edit, so it does not require an `expectedVersion` from the caller.
   */
  setCurrent(intentionId: EntityId, stageId: EntityId, now: Instant): void;
  /** Takes these Stages out of the route (owner-approved plan replacement); rows and their Actions stay. */
  archive(stageIds: readonly EntityId[], now: Instant): void;
}

export interface ActionReader {
  findById(id: EntityId): Action | undefined;
  listByStage(stageId: EntityId): Action[];
  /** Batched form of `listByStage` for views spanning every Stage of an Intention (avoids N+1). */
  listByStages(stageIds: readonly EntityId[]): Action[];
  /** Completed in [from, to) — Review evidence (Stage 7 §5/§6). */
  listCompletedBetween(from: Instant, to: Instant): Action[];
}

export interface ActionRepository extends ActionReader {
  insert(action: Action): void;
  updateIfVersion(action: Action, expectedVersion: Version): boolean;
  /** Like updateIfVersion, and also moves the Action to `action.stageId`/`action.position` (plan replacement). */
  relocateIfVersion(action: Action, expectedVersion: Version): boolean;
  reorder(positions: ReadonlyMap<EntityId, number>, now: Instant): void;
}

export interface OrderedActionPlanReader {
  /** At most one plan per Intention. */
  findByIntention(intentionId: EntityId): OrderedActionPlan | undefined;
}

export interface OrderedActionPlanRepository extends OrderedActionPlanReader {
  insert(plan: OrderedActionPlan): void;
  updateIfVersion(plan: OrderedActionPlan, expectedVersion: Version): boolean;
}

/**
 * The LivingMap-owned calendar read model (ARCHITECTURE §32). Always returns a value — there is
 * exactly one row, seeded disconnected — so callers never have to special-case "no snapshot yet".
 */
export interface CalendarSnapshotReader {
  get(): CalendarSnapshotDto;
}

export interface CalendarSnapshotRepository extends CalendarSnapshotReader {
  /** Wholesale replace (ARCHITECTURE §32): never edited piecemeal, no optimistic concurrency. */
  save(snapshot: CalendarSnapshotDto): void;
}

export interface WorkIntervalReader {
  /** The one globally running interval, if any. */
  findRunning(): WorkInterval | undefined;
  listByAction(actionId: EntityId): WorkInterval[];
  /** Intervals still running or that ended at/after `since` (enough for today/week totals). */
  listEndedSince(since: Instant): WorkInterval[];
}

export interface WorkIntervalRepository extends WorkIntervalReader {
  insert(interval: WorkInterval): void;
  /** Closes the interval only if it is still running; false otherwise. */
  closeIfRunning(id: EntityId, endedAt: Instant): boolean;
}

export interface SettingsReader {
  dailyWorkTargetMinutes(): number;
  /** The project the owner chose to work on (may be stale — the read model checks it is still usable). */
  selectedIntentionId(): EntityId | null;
}

export interface SettingsRepository extends SettingsReader {
  setDailyWorkTargetMinutes(minutes: number): void;
  setSelectedIntentionId(id: EntityId | null): void;
}

/** «Быт» (Stage 9): small one-off errands, never project work. */
export interface HouseholdReader {
  findById(id: EntityId): HouseholdItem | undefined;
  /** Oldest first — the order they were written down. */
  listActive(): HouseholdItem[];
  /** Newest first. */
  listRecentlyDone(limit: number): HouseholdItem[];
  listBySourceCaptures(captureIds: readonly EntityId[]): HouseholdItem[];
}

export interface HouseholdRepository extends HouseholdReader {
  insert(item: HouseholdItem): void;
  /** Persists only if the stored row is still active; false otherwise. */
  completeIfActive(item: HouseholdItem): boolean;
}

export interface ProposalReader {
  findById(id: EntityId): Proposal | undefined;
  listPending(): Proposal[];
  /** Resolved (accepted/rejected/stale) in [from, to) — Review evidence (Stage 7 §5). */
  listResolvedBetween(from: Instant, to: Instant): Proposal[];
}

export interface ProposalRepository extends ProposalReader {
  insert(proposal: Proposal): void;
  /** Persists status/resolvedAt/resolvedBy only if the stored row is still pending; false otherwise. */
  resolveIfPending(proposal: Proposal): boolean;
}

export interface CaptureReader {
  findById(id: EntityId): Capture | undefined;
  /** Newest first. */
  listRecent(limit: number, state?: CaptureState): Capture[];
  /** The oldest `pending` Capture, if any. */
  findNextPending(): Capture | undefined;
  /** Created in [from, to) — Review evidence (Stage 7 §5). */
  listCreatedBetween(from: Instant, to: Instant): Capture[];
  /** The Capture this Proposal was created from, if any — Review evidence provenance (Stage 7 H2 fix). */
  findByProposalId(proposalId: EntityId): Capture | undefined;
}

/** State changes are conditional single-row updates: a stale caller changes nothing and gets false. */
export interface CaptureRepository extends CaptureReader {
  insert(capture: Capture): void;
  /** pending → processing, attempts + 1. */
  claim(id: EntityId, now: Instant): boolean;
  /** processing → processed (with result) | failed (with lastError). */
  finish(id: EntityId, outcome: { result: unknown } | { lastError: string }, now: Instant): boolean;
  /** failed → pending. */
  requeue(id: EntityId, now: Instant): boolean;
  /** Links the Proposal made while this Capture is `processing`; only once. */
  linkProposal(id: EntityId, proposalId: EntityId): boolean;
  /** Launch recovery: processing → pending, and failed with attempts < `maxAttempts` → pending. Returns rows changed. */
  recover(maxAttempts: number, now: Instant): number;
}

export interface MemoryReader {
  list(): Memory[];
  listBySourceCaptures(captureIds: readonly EntityId[]): Memory[];
  /** Created in [from, to) — Review evidence (Stage 7 §5). */
  listCreatedBetween(from: Instant, to: Instant): Memory[];
}

export interface MemoryRepository extends MemoryReader {
  insert(memory: Memory): void;
  /** Hard delete; false when no such memory. */
  remove(id: EntityId): boolean;
  /**
   * M-A: upgrades an existing Memory's `sourceCaptureVerified` to true. The only caller is `saveMemory`
   * when its own trusted `ctx.captureId` hits the "one memory per type per Capture" dedup no-op against
   * a Memory an earlier, untethered call already created for the same Capture+type — without this, the
   * trusted job's own vouching would be silently discarded and the pair would stay disjoint forever.
   */
  verifySourceCapture(id: EntityId): void;
}

/**
 * One closed period being learned from (Stage 7). Transitions mirror {@link CaptureRepository}:
 * every one names the state it may leave, so a stale caller changes nothing.
 */
export interface ReviewReader {
  findById(id: EntityId): Review | undefined;
  /** The most recently created Review of this type, if any — the scheduler's catch-up cursor. */
  findLatestByType(type: ReviewType): Review | undefined;
  /** Newest first. */
  listRecent(limit: number): Review[];
  /** The oldest `needs_ai` Review, if any. */
  findNextPending(): Review | undefined;
  existsForPeriod(type: ReviewType, periodStart: Instant, periodEnd: Instant): boolean;
}

export interface ReviewRepository extends ReviewReader {
  insert(review: Review): void;
  /** needs_ai → processing, attempts + 1. */
  claim(id: EntityId, now: Instant): boolean;
  /** processing → ready | no_useful_change (outcome) | failed (with lastError). */
  finish(
    id: EntityId,
    outcome: { status: "ready" | "no_useful_change" } | { lastError: string },
    now: Instant,
  ): boolean;
  /** failed → needs_ai. */
  requeue(id: EntityId, now: Instant): boolean;
  /** Launch recovery: processing → needs_ai, and failed with attempts < `maxAttempts` → needs_ai. Returns rows changed. */
  recover(maxAttempts: number, now: Instant): number;
}

export interface ReviewFindingReader {
  findById(id: EntityId): ReviewFinding | undefined;
  listByReview(reviewId: EntityId): ReviewFinding[];
  /** accepted/corrected findings sharing `patternKey`, across every Review — Pattern candidate detection. */
  listAcceptedByPatternKey(patternKey: string): ReviewFinding[];
  /**
   * One example (newest) accepted/corrected finding per distinct non-null `patternKey`, newest keys
   * first. A Review job is stateless and gets no tool access (§21), so this is how it learns which
   * theme slugs already exist to reuse — without it, two independent runs would almost never invent
   * the exact same slug and recurrence would practically never surface.
   */
  listDistinctPatternThemes(limit: number): { patternKey: string; text: string }[];
}

export interface ReviewFindingRepository extends ReviewFindingReader {
  insert(finding: ReviewFinding): void;
  /** Persists only if the stored row is still `proposed`; false otherwise (mirrors `resolveIfPending`). */
  resolveIfProposed(finding: ReviewFinding): boolean;
}

export interface PatternReader {
  findById(id: EntityId): Pattern | undefined;
  listCandidates(limit: number): Pattern[];
  /**
   * The most relevant Pattern for this theme, if any: the one non-rejected (candidate/confirmed) row
   * when one exists — at most one is ever created per key — otherwise the newest rejected one. Drives
   * "grow the existing candidate instead of duplicating" and "confirmed themes stay confirmed".
   */
  findByKey(patternKey: string): Pattern | undefined;
}

export interface PatternRepository extends PatternReader {
  insert(pattern: Pattern): void;
  /** Persists only if the stored row is still `candidate`; false otherwise. */
  resolveIfCandidate(pattern: Pattern): boolean;
  /** Persists a grown evidence set only if the stored row is still `candidate`; false otherwise. */
  growIfCandidate(pattern: Pattern): boolean;
}

export interface PlanningRuleReader {
  findById(id: EntityId): PlanningRule | undefined;
  listActive(): PlanningRule[];
  listAll(limit: number): PlanningRule[];
}

export interface PlanningRuleRepository extends PlanningRuleReader {
  insert(rule: PlanningRule): void;
  /** Persists only if the stored row is still `active`; false otherwise. */
  deactivateIfActive(rule: PlanningRule): boolean;
}

/**
 * Replaceable AI transport (ADR-0007): what LivingMap needs from any AI host to interpret one Capture.
 * Never throws and never touches storage itself — the AI acts only through the MCP AiSurface; every
 * failure comes back as a vendor-neutral kind so the Capture stays saved and retryable.
 */
export type AiRunInput = { captureId: EntityId; rawText: string; createdAt: Instant };
export type AiRunOutcome = { ok: true; result: CaptureAiResult } | { ok: false; failure: AiFailure };
/** The part of a platform `AbortSignal` a runner needs (this package has no DOM/Node typings). */
export type CancelSignal = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};
/**
 * One fact/record the review's evidence pack hands the AI; `id` is the only valid `evidenceRefs` value.
 * `factIds` is the item's canonical underlying-fact identity — never shown to the AI, used only by
 * `finishReview` to resolve a finding's `evidenceFactIds` (H2 fix). A primary fact's own `id` doubles as
 * its one factId; a derived item (an aggregated work total, a Memory explicitly linked to its source
 * Capture) additionally carries the factIds of whatever it was built from, so two items describing the
 * same underlying reality overlap here even when their display `id`s differ.
 */
export type ReviewEvidenceItem = { readonly id: string; readonly text: string; readonly factIds: readonly string[] };

export type ReviewEvidencePack = {
  readonly reviewId: EntityId;
  readonly type: ReviewType;
  readonly periodStart: Instant;
  readonly periodEnd: Instant;
  readonly timeZone: string;
  readonly items: readonly ReviewEvidenceItem[];
  /** True if real evidence exists beyond `items` (bound reached) — told to the AI so it never treats a cut list as complete. */
  readonly truncated: boolean;
  /** Existing recurring-theme slugs (with an example) so the AI can reuse one instead of inventing a near-duplicate. */
  readonly knownPatternThemes: readonly { readonly patternKey: string; readonly text: string }[];
};

export type ReviewRunOutcome = { ok: true; result: ReviewAiResult } | { ok: false; failure: AiFailure };

export interface AiRunner {
  processCapture(input: AiRunInput, signal: CancelSignal): Promise<AiRunOutcome>;
  /**
   * A second job kind through the same replaceable transport (ADR-0007): the AI never queries
   * LivingMap itself for this job — every fact it may cite is already in `evidence.items`, so
   * evidence validation is a closed-set membership check, never trust in a model-invented id.
   */
  processReview(evidence: ReviewEvidencePack, signal: CancelSignal): Promise<ReviewRunOutcome>;
}

/** Lightweight change-log entry (ARCHITECTURE §20); actor / correlation come from the command context. */
export type ChangeRecord = {
  commandType: string;
  entityType: string;
  entityId: EntityId;
  summary: string;
  /**
   * The Capture this entry was produced from, when the command ran inside a Capture's AI job
   * (`ctx.captureId`) — lets Review evidence (`review-evidence.ts`) see through to the same underlying
   * lived fact as the Capture itself, the same provenance link `Memory.sourceCaptureId` already gives
   * Memory. Omitted/null for entries not produced from a Capture.
   */
  sourceCaptureId?: EntityId | null;
};

/** A stored change-log row, as read back for the product-facing history query. */
export type ChangeLogEntry = ChangeRecord & {
  id: EntityId;
  timestamp: Instant;
  actor: string;
  stateRevision: number;
};

export interface ChangeLogReader {
  listRecent(limit: number): ChangeLogEntry[];
  /** Every entry (unfiltered, including technical ones `listRecent` hides) in [from, to), oldest first — Review evidence. */
  listBetween(from: Instant, to: Instant): ChangeLogEntry[];
  /** Every entry of these command types, ever, oldest first — season-boundary detection (Stage 7 §7). */
  listByCommandTypes(commandTypes: readonly string[]): ChangeLogEntry[];
}

export interface ReadScope {
  season: SeasonReader;
  seasonHistory: SeasonHistoryReader;
  decades: DecadePlanReader;
  horizon: HorizonReader;
  year: YearDirectionReader;
  routines: RoutineReader;
  courseChanges: CourseChangeReader;
  goodLifeConditions: GoodLifeConditionReader;
  intentions: IntentionReader;
  stages: StageReader;
  actions: ActionReader;
  plans: OrderedActionPlanReader;
  proposals: ProposalReader;
  changeLog: ChangeLogReader;
  calendar: CalendarSnapshotReader;
  work: WorkIntervalReader;
  settings: SettingsReader;
  household: HouseholdReader;
  captures: CaptureReader;
  memories: MemoryReader;
  reviews: ReviewReader;
  reviewFindings: ReviewFindingReader;
  patterns: PatternReader;
  planningRules: PlanningRuleReader;
  stateRevision(): number;
}

export interface WriteScope {
  season: SeasonRepository;
  seasonHistory: SeasonHistoryRepository;
  decades: DecadePlanRepository;
  horizon: HorizonRepository;
  year: YearDirectionRepository;
  routines: RoutineRepository;
  courseChanges: CourseChangeRepository;
  goodLifeConditions: GoodLifeConditionRepository;
  intentions: IntentionRepository;
  stages: StageRepository;
  actions: ActionRepository;
  plans: OrderedActionPlanRepository;
  proposals: ProposalRepository;
  calendar: CalendarSnapshotRepository;
  work: WorkIntervalRepository;
  settings: SettingsRepository;
  household: HouseholdRepository;
  captures: CaptureRepository;
  memories: MemoryRepository;
  reviews: ReviewRepository;
  reviewFindings: ReviewFindingRepository;
  patterns: PatternRepository;
  planningRules: PlanningRuleRepository;
  /** Read-only: Review evidence-gathering needs to read change_log from inside a write transaction too. */
  changeLog: ChangeLogReader;
  /** The committed revision this transaction started from — still the pre-bump value after recordChange. */
  stateRevision(): number;
  /**
   * Appends to the change log. The first call in a transaction increments `state_revision`;
   * later calls in the same transaction share that revision (one command = one revision bump).
   * The store's structural guard only detects "rows changed but recordChange never called": writes
   * made after the first recordChange are not checked, so log each meaningful entity change explicitly.
   */
  recordChange(change: ChangeRecord): number;
}

/**
 * Transaction boundary (ARCHITECTURE §44). One command = at most one atomic write transaction.
 * `work` is deliberately synchronous: no I/O or awaits inside a write transaction keeps it short
 * while two processes share the database (ARCHITECTURE §12). Throwing rolls back.
 */
export interface Store {
  read<T>(work: (scope: ReadScope) => T): T;
  write<T>(context: WriteContextMeta, work: (scope: WriteScope) => T): T;
  /**
   * Crash-recovery checkpoint of the running work interval. Deliberately outside write(): it is
   * technical metadata, so it neither bumps state_revision nor touches the change log/history.
   */
  touchWorkHeartbeat(intervalId: EntityId, at: Instant): void;
}

export type WriteContextMeta = {
  actor: string;
  correlationId: EntityId;
  timestamp: Instant;
};

/**
 * Thrown by a `Store` implementation when the on-disk schema no longer matches the one this
 * process opened with (ADR-0003: MCP checks this on every write, not just at open). Caught by
 * `createApplication` and mapped to the stable `SCHEMA_INCOMPATIBLE` error code.
 */
export class SchemaConflictError extends Error {
  constructor(message = "Database schema changed since this process opened it") {
    super(message);
    this.name = "SchemaConflictError";
  }
}
