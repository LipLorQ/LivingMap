import type { IdGenerator, ProbeReader, ProbeRepository, Store } from "@living-map/application";
import type { Probe } from "@living-map/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, SqliteHandle } from "./connection";
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
  const { db } = handle;
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
        (tx) =>
          work({
            probes: probeRepository(tx),
            recordChange: (change) => {
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
          }),
        { behavior: "immediate" },
      ),
  };
}
