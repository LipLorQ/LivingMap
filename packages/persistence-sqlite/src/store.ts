import type {
  ActionReader,
  ActionRepository,
  CalendarSnapshotReader,
  CalendarSnapshotRepository,
  ChangeLogReader,
  GoodLifeConditionReader,
  GoodLifeConditionRepository,
  IdGenerator,
  IntentionReader,
  IntentionRepository,
  OrderedActionPlanReader,
  OrderedActionPlanRepository,
  ProposalReader,
  ProposalRepository,
  SeasonReader,
  SeasonRepository,
  SettingsReader,
  SettingsRepository,
  StageReader,
  StageRepository,
  Store,
  WorkIntervalReader,
  WorkIntervalRepository,
} from "@living-map/application";
import { SchemaConflictError } from "@living-map/application";
import type { CalendarSnapshotDto } from "@living-map/contracts";
import type {
  Action,
  ActionStatus,
  GoodLifeCondition,
  Instant,
  Intention,
  Proposal,
  ProposalKind,
  ProposalStatus,
  Season,
  Stage,
} from "@living-map/domain";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db, SqliteHandle } from "./connection";
import { EXPECTED_SCHEMA_VERSION } from "./migrate";
import {
  actions,
  calendarSnapshot,
  changeLog,
  goodLifeConditions,
  intentions,
  meta,
  orderedActionPlans,
  proposals,
  season,
  settings,
  stages,
  workIntervals,
} from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ActionRow = typeof actions.$inferSelect;

function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    stageId: row.stageId,
    title: row.title,
    doneWhen: row.doneWhen,
    position: row.position,
    status: row.status as ActionStatus,
    blocker:
      row.status === "blocked" ? { reason: row.blockerReason as string, blockedAt: row.blockedAt as Instant } : null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function actionToRow(action: Action): ActionRow {
  return {
    id: action.id,
    stageId: action.stageId,
    title: action.title,
    doneWhen: action.doneWhen,
    position: action.position,
    status: action.status,
    blockerReason: action.blocker?.reason ?? null,
    blockedAt: action.blocker?.blockedAt ?? null,
    completedAt: action.completedAt,
    version: action.version,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function seasonReader(q: Tx): SeasonReader {
  return { get: () => q.select().from(season).limit(1).get() };
}

function seasonRepository(q: Tx): SeasonRepository {
  return {
    ...seasonReader(q),
    insert: (s: Season) => void q.insert(season).values(s).run(),
    updateIfVersion: (s, expectedVersion) =>
      q
        .update(season)
        .set({ focus: s.focus, version: s.version, updatedAt: s.updatedAt })
        .where(and(eq(season.id, s.id), eq(season.version, expectedVersion)))
        .run().changes === 1,
  };
}

function goodLifeConditionReader(q: Tx): GoodLifeConditionReader {
  return {
    findById: (id) => q.select().from(goodLifeConditions).where(eq(goodLifeConditions.id, id)).get(),
    list: () => q.select().from(goodLifeConditions).orderBy(asc(goodLifeConditions.position)).all(),
  };
}

function goodLifeConditionRepository(q: Tx): GoodLifeConditionRepository {
  return {
    ...goodLifeConditionReader(q),
    insert: (c: GoodLifeCondition) => void q.insert(goodLifeConditions).values(c).run(),
    updateIfVersion: (c, expectedVersion) =>
      q
        .update(goodLifeConditions)
        .set({ text: c.text, version: c.version, updatedAt: c.updatedAt })
        .where(and(eq(goodLifeConditions.id, c.id), eq(goodLifeConditions.version, expectedVersion)))
        .run().changes === 1,
    removeIfVersion: (id, expectedVersion) =>
      q
        .delete(goodLifeConditions)
        .where(and(eq(goodLifeConditions.id, id), eq(goodLifeConditions.version, expectedVersion)))
        .run().changes === 1,
    // ponytail: one UPDATE per item (shared by all three reorder() implementations below); O(n)
    // round trips per reorder, fine for realistic list sizes (dozens). Switch to a single
    // batched/CASE-based statement if reordering becomes hot on large lists.
    reorder: (positions, now) => {
      for (const [id, position] of positions) {
        q.update(goodLifeConditions)
          .set({ position, version: sql`${goodLifeConditions.version} + 1`, updatedAt: now })
          .where(eq(goodLifeConditions.id, id))
          .run();
      }
    },
  };
}

function intentionReader(q: Tx): IntentionReader {
  return {
    findById: (id) => q.select().from(intentions).where(eq(intentions.id, id)).get(),
    list: () => q.select().from(intentions).orderBy(asc(intentions.createdAt)).all(),
  };
}

function intentionRepository(q: Tx): IntentionRepository {
  return {
    ...intentionReader(q),
    insert: (i: Intention) => void q.insert(intentions).values(i).run(),
    updateIfVersion: (i, expectedVersion) =>
      q
        .update(intentions)
        .set({ title: i.title, desiredResult: i.desiredResult, version: i.version, updatedAt: i.updatedAt })
        .where(and(eq(intentions.id, i.id), eq(intentions.version, expectedVersion)))
        .run().changes === 1,
  };
}

function stageReader(q: Tx): StageReader {
  return {
    findById: (id) => q.select().from(stages).where(eq(stages.id, id)).get(),
    listByIntention: (intentionId) =>
      q.select().from(stages).where(eq(stages.intentionId, intentionId)).orderBy(asc(stages.position)).all(),
  };
}

function stageRepository(q: Tx): StageRepository {
  return {
    ...stageReader(q),
    insert: (stage: Stage) => void q.insert(stages).values(stage).run(),
    updateIfVersion: (stage, expectedVersion) =>
      q
        .update(stages)
        .set({ title: stage.title, position: stage.position, version: stage.version, updatedAt: stage.updatedAt })
        .where(and(eq(stages.id, stage.id), eq(stages.version, expectedVersion)))
        .run().changes === 1,
    reorder: (positions, now) => {
      for (const [id, position] of positions) {
        q.update(stages)
          .set({ position, version: sql`${stages.version} + 1`, updatedAt: now })
          .where(eq(stages.id, id))
          .run();
      }
    },
    setCurrent: (intentionId, stageId, now) => {
      // Two statements, each touching only the rows whose flag actually flips, so version/updatedAt
      // bump exactly where something changed (ARCHITECTURE §13) instead of a blind overwrite.
      q.update(stages)
        .set({ isCurrent: false, version: sql`${stages.version} + 1`, updatedAt: now })
        .where(and(eq(stages.intentionId, intentionId), eq(stages.isCurrent, true), sql`${stages.id} != ${stageId}`))
        .run();
      q.update(stages)
        .set({ isCurrent: true, version: sql`${stages.version} + 1`, updatedAt: now })
        .where(and(eq(stages.id, stageId), eq(stages.isCurrent, false)))
        .run();
    },
  };
}

function actionReader(q: Tx): ActionReader {
  return {
    findById: (id) => {
      const row = q.select().from(actions).where(eq(actions.id, id)).get();
      return row ? rowToAction(row) : undefined;
    },
    listByStage: (stageId) =>
      q
        .select()
        .from(actions)
        .where(eq(actions.stageId, stageId))
        .orderBy(asc(actions.position))
        .all()
        .map(rowToAction),
    listByStages: (stageIds) =>
      stageIds.length === 0
        ? []
        : q
            .select()
            .from(actions)
            .where(inArray(actions.stageId, stageIds as string[]))
            .orderBy(asc(actions.position))
            .all()
            .map(rowToAction),
  };
}

function actionRepository(q: Tx): ActionRepository {
  return {
    ...actionReader(q),
    insert: (action: Action) => void q.insert(actions).values(actionToRow(action)).run(),
    updateIfVersion: (action, expectedVersion) => {
      const row = actionToRow(action);
      return (
        q
          .update(actions)
          .set({
            title: row.title,
            doneWhen: row.doneWhen,
            status: row.status,
            blockerReason: row.blockerReason,
            blockedAt: row.blockedAt,
            completedAt: row.completedAt,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(and(eq(actions.id, action.id), eq(actions.version, expectedVersion)))
          .run().changes === 1
      );
    },
    reorder: (positions, now) => {
      for (const [id, position] of positions) {
        q.update(actions)
          .set({ position, version: sql`${actions.version} + 1`, updatedAt: now })
          .where(eq(actions.id, id))
          .run();
      }
    },
  };
}

function planReader(q: Tx): OrderedActionPlanReader {
  return {
    findByIntention: (intentionId) =>
      q.select().from(orderedActionPlans).where(eq(orderedActionPlans.intentionId, intentionId)).get(),
  };
}

function planRepository(q: Tx): OrderedActionPlanRepository {
  return {
    ...planReader(q),
    insert: (plan) =>
      void q
        .insert(orderedActionPlans)
        .values({ ...plan, orderedActionIds: [...plan.orderedActionIds] })
        .run(),
    updateIfVersion: (plan, expectedVersion) =>
      q
        .update(orderedActionPlans)
        .set({
          orderedActionIds: [...plan.orderedActionIds],
          rationale: plan.rationale,
          createdBy: plan.createdBy,
          updatedAt: plan.updatedAt,
          version: plan.version,
          sourceRevision: plan.sourceRevision,
        })
        .where(and(eq(orderedActionPlans.id, plan.id), eq(orderedActionPlans.version, expectedVersion)))
        .run().changes === 1,
  };
}

type ProposalRow = typeof proposals.$inferSelect;
const rowToProposal = (row: ProposalRow): Proposal => ({
  ...row,
  kind: row.kind as ProposalKind,
  status: row.status as ProposalStatus,
});

function proposalReader(q: Tx): ProposalReader {
  return {
    findById: (id) => {
      const row = q.select().from(proposals).where(eq(proposals.id, id)).get();
      return row ? rowToProposal(row) : undefined;
    },
    listPending: () =>
      q
        .select()
        .from(proposals)
        .where(eq(proposals.status, "pending"))
        .orderBy(asc(proposals.createdAt))
        .all()
        .map(rowToProposal),
  };
}

function proposalRepository(q: Tx): ProposalRepository {
  return {
    ...proposalReader(q),
    insert: (p) =>
      void q
        .insert(proposals)
        .values({ ...p, affectedEntityIds: [...p.affectedEntityIds] })
        .run(),
    resolveIfPending: (p) =>
      q
        .update(proposals)
        .set({ status: p.status, resolvedAt: p.resolvedAt, resolvedBy: p.resolvedBy })
        .where(and(eq(proposals.id, p.id), eq(proposals.status, "pending")))
        .run().changes === 1,
  };
}

function calendarSnapshotReader(q: Tx): CalendarSnapshotReader {
  return {
    get: (): CalendarSnapshotDto => {
      const row = q.select().from(calendarSnapshot).where(eq(calendarSnapshot.id, 1)).get();
      if (!row) throw new Error("calendar_snapshot row missing");
      return {
        connected: row.connected,
        syncedAt: row.syncedAt,
        source: row.source as CalendarSnapshotDto["source"],
        timeZone: row.timeZone,
        events: row.events,
        lastError: row.lastError,
      };
    },
  };
}

function calendarSnapshotRepository(q: Tx): CalendarSnapshotRepository {
  return {
    ...calendarSnapshotReader(q),
    save: (snapshot: CalendarSnapshotDto) => {
      q.update(calendarSnapshot)
        .set({
          connected: snapshot.connected,
          syncedAt: snapshot.syncedAt,
          source: snapshot.source,
          timeZone: snapshot.timeZone,
          events: [...snapshot.events],
          lastError: snapshot.lastError,
        })
        .where(eq(calendarSnapshot.id, 1))
        .run();
    },
  };
}

function workReader(q: Tx): WorkIntervalReader {
  return {
    findRunning: () => q.select().from(workIntervals).where(isNull(workIntervals.endedAt)).get(),
    listByAction: (actionId) =>
      q
        .select()
        .from(workIntervals)
        .where(eq(workIntervals.actionId, actionId))
        .orderBy(asc(workIntervals.startedAt))
        .all(),
    listEndedSince: (since) =>
      q
        .select()
        .from(workIntervals)
        .where(or(isNull(workIntervals.endedAt), gte(workIntervals.endedAt, since)))
        .orderBy(asc(workIntervals.startedAt))
        .all(),
  };
}

function workRepository(q: Tx): WorkIntervalRepository {
  return {
    ...workReader(q),
    insert: (interval) => void q.insert(workIntervals).values(interval).run(),
    closeIfRunning: (id, endedAt) =>
      q
        .update(workIntervals)
        .set({ endedAt })
        .where(and(eq(workIntervals.id, id), isNull(workIntervals.endedAt)))
        .run().changes === 1,
  };
}

function settingsReader(q: Tx): SettingsReader {
  return {
    dailyWorkTargetMinutes: () => {
      const row = q.select().from(settings).where(eq(settings.id, 1)).get();
      if (!row) throw new Error("settings row missing");
      return row.dailyWorkTargetMinutes;
    },
  };
}

function settingsRepository(q: Tx): SettingsRepository {
  return {
    ...settingsReader(q),
    setDailyWorkTargetMinutes: (minutes) =>
      void q.update(settings).set({ dailyWorkTargetMinutes: minutes }).where(eq(settings.id, 1)).run(),
  };
}

function changeLogReader(q: Tx): ChangeLogReader {
  return {
    // One command may log several entries under one revision; rowid keeps their insertion order.
    // `calendar.save` fires on every launch and every manual refresh — routine, not a "meaningful
    // change" (ARCHITECTURE §20) — so it is excluded here rather than flooding the AI's
    // `recentHistory` context and the user-facing history feed; it is still recorded in the table for
    // the state-revision bump and direct inspection.
    listRecent: (limit) =>
      q
        .select()
        .from(changeLog)
        .where(ne(changeLog.commandType, "calendar.save"))
        .orderBy(desc(changeLog.stateRevision), desc(sql`rowid`))
        .limit(limit)
        .all(),
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
      db.transaction(
        (tx) =>
          work({
            season: seasonReader(tx),
            goodLifeConditions: goodLifeConditionReader(tx),
            intentions: intentionReader(tx),
            stages: stageReader(tx),
            actions: actionReader(tx),
            plans: planReader(tx),
            proposals: proposalReader(tx),
            changeLog: changeLogReader(tx),
            calendar: calendarSnapshotReader(tx),
            work: workReader(tx),
            settings: settingsReader(tx),
            stateRevision: () => readRevision(tx),
          }),
        { behavior: "deferred" },
      ),

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
          const startRevision = readRevision(tx);
          // One command = one revision bump (ARCHITECTURE §14/§44), however many entries it logs.
          let revision: number | undefined;
          const result = work({
            season: seasonRepository(tx),
            goodLifeConditions: goodLifeConditionRepository(tx),
            intentions: intentionRepository(tx),
            stages: stageRepository(tx),
            actions: actionRepository(tx),
            plans: planRepository(tx),
            proposals: proposalRepository(tx),
            calendar: calendarSnapshotRepository(tx),
            work: workRepository(tx),
            settings: settingsRepository(tx),
            stateRevision: () => startRevision,
            recordChange: (change) => {
              if (revision === undefined) {
                const row = tx
                  .update(meta)
                  .set({ stateRevision: sql`${meta.stateRevision} + 1` })
                  .where(eq(meta.id, 1))
                  .returning({ stateRevision: meta.stateRevision })
                  .get();
                if (!row) throw new Error("meta row missing");
                revision = row.stateRevision;
              }
              tx.insert(changeLog)
                .values({
                  id: ids.next(),
                  timestamp: ctx.timestamp,
                  actor: ctx.actor,
                  correlationId: ctx.correlationId,
                  stateRevision: revision,
                  ...change,
                })
                .run();
              return revision;
            },
          });
          // Structural guarantee (ARCHITECTURE §44): a command must not depend on remembering to
          // call recordChange. If it mutated rows without recording the change, roll back instead
          // of silently breaking the change log / MCP→UI revision watch. Note: SQLite's
          // total_changes() counts a same-value UPDATE (`SET x = x`) as a change too, so a future
          // idempotent no-op command would also need to call recordChange — no command does today.
          if (revision === undefined && totalChanges() !== changesBefore) {
            throw new Error("Write transaction changed rows without calling recordChange()");
          }
          return result;
        },
        { behavior: "immediate" },
      ),

    // A single-row UPDATE is atomic on its own; schema drift is harmless here (worst case it no-ops).
    touchWorkHeartbeat: (intervalId, at) =>
      void db
        .update(workIntervals)
        .set({ lastHeartbeatAt: at })
        .where(and(eq(workIntervals.id, intervalId), isNull(workIntervals.endedAt)))
        .run(),
  };
}
