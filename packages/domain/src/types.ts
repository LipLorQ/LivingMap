/** Stable, locally generated UUID. Never an autoincrement row id (ARCHITECTURE §18). */
export type EntityId = string;

/** Absolute timestamp, ISO-8601 in UTC (ARCHITECTURE §18). */
export type Instant = string;

/** Optimistic concurrency version of an aggregate (ARCHITECTURE §13). */
export type Version = number;

export type DomainResult<T> = { ok: true; value: T } | { ok: false; reason: string };
