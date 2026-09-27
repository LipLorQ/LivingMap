import type { EntityId, Instant, Probe, Version } from "@living-map/domain";

export interface Clock {
  now(): Instant;
}

export interface IdGenerator {
  next(): EntityId;
}

export interface ProbeReader {
  findById(id: EntityId): Probe | undefined;
  list(): Probe[];
}

export interface ProbeRepository extends ProbeReader {
  insert(probe: Probe): void;
  /**
   * Persists `probe` only if the stored version still equals `expectedVersion`.
   * Returns false (and writes nothing) otherwise — the storage-level guard against lost updates.
   */
  updateIfVersion(probe: Probe, expectedVersion: Version): boolean;
}

/** Lightweight change-log entry (ARCHITECTURE §20); actor / correlation come from the command context. */
export type ChangeRecord = {
  commandType: string;
  entityType: string;
  entityId: EntityId;
  summary: string;
};

export interface ReadScope {
  probes: ProbeReader;
  stateRevision(): number;
}

export interface WriteScope {
  probes: ProbeRepository;
  /** Increments `state_revision`, appends to change log, returns the new revision. */
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
