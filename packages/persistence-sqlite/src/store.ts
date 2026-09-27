import {
  type IdGenerator,
  type ProbeReader,
  type ProbeRepository,
  SchemaConflictError,
  type Store,
} from "@living-map/application";
import type { Probe } from "@living-map/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, SqliteHandle } from "./connection";
import { EXPECTED_SCHEMA_VERSION } from "./migrate";
import { changeLog, meta, probes } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function probeReader(q: Tx): ProbeReader {
  return {
    findById: (id) => q.select().from(probes).where(eq(probes.id, id)).get(),
    list: () => q.select().from(probes).orderBy(asc(probes.createdAt), asc(probes.id)).all(),
  };
}

function probeRepository(q: Tx): ProbeRepository {
  return {
    ...probeReader(q),
    insert: (probe: Probe) => {
      q.insert(probes).values(probe).run();
    },
    updateIfVersion: (probe, expectedVersion) =>
      q
        .update(probes)
        .set({ title: probe.title, version: probe.version, updatedAt: probe.updatedAt })
        .where(and(eq(probes.id, probe.id), eq(probes.version, expectedVersion)))
        .run().changes === 1,
  };
}

function readRevision(q: Tx): number {
  const row = q.select({ r: meta.stateRevision }).from(meta).where(eq(meta.id, 1)).get();
  if (!row) throw new Error("meta row missing");
  return row.r;
}

export function createSqliteStore(handle: SqliteHandle, ids: IdGenerator): Store {
  const { db, sqlite } = handle;
  // Reused across writes rather than re-prepared each time; total_changes() is a scalar function,
  // not tied to any particular transaction, so one statement per connection is enough.
  const totalChangesStmt = sqlite.prepare("select total_changes() as n");
  const totalChanges = (): number => (totalChangesStmt.get() as { n: number }).n;

  return {
    // DEFERRED: a consistent WAL snapshot for multi-statement reads, never blocks writers.
    read: (work) =>
      db.transaction((tx) => work({ probes: probeReader(tx), stateRevision: () => readRevision(tx) }), {
        behavior: "deferred",
      }),

    // IMMEDIATE: take the write lock up front (waiting up to busy_timeout). A deferred
    // read→write upgrade in WAL fails instantly with SQLITE_BUSY when another process committed.
    write: (ctx, work) =>
      db.transaction(
        (tx) => {
          // Re-checked on every write, not just at open (ADR-0003): desktop is the sole migration
          // owner and should always be current, but this also catches a second/older desktop
          // instance or a long-lived MCP process outliving a migration, uniformly for both.
          const current = sqlite.pragma("user_version", { simple: true }) as number;
          if (current !== EXPECTED_SCHEMA_VERSION) throw new SchemaConflictError();

          const changesBefore = totalChanges();
          let recorded = false;
          const result = work({
            probes: probeRepository(tx),
            recordChange: (change) => {
              recorded = true;
              const row = tx
                .update(meta)
                .set({ stateRevision: sql`${meta.stateRevision} + 1` })
                .where(eq(meta.id, 1))
                .returning({ stateRevision: meta.stateRevision })
                .get();
              if (!row) throw new Error("meta row missing");
              tx.insert(changeLog)
                .values({
                  id: ids.next(),
                  timestamp: ctx.timestamp,
                  actor: ctx.actor,
                  correlationId: ctx.correlationId,
                  stateRevision: row.stateRevision,
                  ...change,
                })
                .run();
              return row.stateRevision;
            },
          });
          // Structural guarantee (ARCHITECTURE §44): a command must not depend on remembering to
          // call recordChange. If it mutated rows without recording the change, roll back instead
          // of silently breaking the change log / MCP→UI revision watch. Note: SQLite's
          // total_changes() counts a same-value UPDATE (`SET x = x`) as a change too, so a future
          // idempotent no-op command would also need to call recordChange — no command does today.
          if (!recorded && totalChanges() !== changesBefore) {
            throw new Error("Write transaction changed rows without calling recordChange()");
          }
          return result;
        },
        { behavior: "immediate" },
      ),
  };
}
