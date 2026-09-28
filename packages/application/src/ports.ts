import type {
  Action,
  EntityId,
  GoodLifeCondition,
  Instant,
  Intention,
  OrderedActionPlan,
  Proposal,
  Season,
  Stage,
  Version,
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
  /** At most one row exists in this stage; multi-Intention UX is future work (ARCHITECTURE-approved). */
  list(): Intention[];
}

export interface IntentionRepository extends IntentionReader {
  insert(intention: Intention): void;
  updateIfVersion(intention: Intention, expectedVersion: Version): boolean;
}

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
}

export interface ActionReader {
  findById(id: EntityId): Action | undefined;
  listByStage(stageId: EntityId): Action[];
  /** Batched form of `listByStage` for views spanning every Stage of an Intention (avoids N+1). */
  listByStages(stageIds: readonly EntityId[]): Action[];
}

export interface ActionRepository extends ActionReader {
  insert(action: Action): void;
  updateIfVersion(action: Action, expectedVersion: Version): boolean;
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

export interface ProposalReader {
  findById(id: EntityId): Proposal | undefined;
  listPending(): Proposal[];
}

export interface ProposalRepository extends ProposalReader {
  insert(proposal: Proposal): void;
  /** Persists status/resolvedAt/resolvedBy only if the stored row is still pending; false otherwise. */
  resolveIfPending(proposal: Proposal): boolean;
}

/** Lightweight change-log entry (ARCHITECTURE §20); actor / correlation come from the command context. */
export type ChangeRecord = {
  commandType: string;
  entityType: string;
  entityId: EntityId;
  summary: string;
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
}

export interface ReadScope {
  season: SeasonReader;
  goodLifeConditions: GoodLifeConditionReader;
  intentions: IntentionReader;
  stages: StageReader;
  actions: ActionReader;
  plans: OrderedActionPlanReader;
  proposals: ProposalReader;
  changeLog: ChangeLogReader;
  stateRevision(): number;
}

export interface WriteScope {
  season: SeasonRepository;
  goodLifeConditions: GoodLifeConditionRepository;
  intentions: IntentionRepository;
  stages: StageRepository;
  actions: ActionRepository;
  plans: OrderedActionPlanRepository;
  proposals: ProposalRepository;
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
