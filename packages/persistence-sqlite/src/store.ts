import type {
  ActionReader,
  ActionRepository,
  CalendarSnapshotReader,
  CalendarSnapshotRepository,
  CaptureReader,
  CaptureRepository,
  ChangeLogReader,
  CourseChangeReader,
  CourseChangeRepository,
  DecadePlanReader,
  DecadePlanRepository,
  GoodLifeConditionReader,
  GoodLifeConditionRepository,
  HorizonReader,
  HorizonRepository,
  IdGenerator,
  IntentionReader,
  IntentionRepository,
  MemoryReader,
  MemoryRepository,
  OrderedActionPlanReader,
  OrderedActionPlanRepository,
  PatternReader,
  PatternRepository,
  PlanningRuleReader,
  PlanningRuleRepository,
  ProposalReader,
  ProposalRepository,
  ReviewFindingReader,
  ReviewFindingRepository,
  ReviewReader,
  ReviewRepository,
  RoutineReader,
  RoutineRepository,
  SeasonHistoryReader,
  SeasonHistoryRepository,
  SeasonReader,
  SeasonRepository,
  SettingsReader,
  SettingsRepository,
  StageReader,
  StageRepository,
  Store,
  WorkIntervalReader,
  WorkIntervalRepository,
  YearDirectionReader,
  YearDirectionRepository,
} from "@living-map/application";
import { SchemaConflictError } from "@living-map/application";
import type { CalendarSnapshotDto } from "@living-map/contracts";
import {
  type Action,
  type ActionStatus,
  acceptedFindingText,
  type Capture,
  type CaptureState,
  type CourseChange,
  type CourseLevel,
  type DecadePlanItem,
  type GoodLifeCondition,
  type Instant,
  type Intention,
  type IntentionStatus,
  type Memory,
  type MemoryType,
  type Pattern,
  type PatternStatus,
  type PlanningRule,
  type PlanningRuleStatus,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type Review,
  type ReviewFinding,
  type ReviewFindingStatus,
  type ReviewStatus,
  type ReviewType,
  type RoutineItem,
  type RoutineKind,
  type Season,
  type SeasonHistoryEntry,
  type Stage,
  type ThreeYearHorizon,
  type YearDirection,
} from "@living-map/domain";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { Db, SqliteHandle } from "./connection";
import { EXPECTED_SCHEMA_VERSION } from "./migrate";
import {
  actions,
  calendarSnapshot,
  captures,
  changeLog,
  courseChanges,
  decadePlanItems,
  goodLifeConditions,
  intentions,
  memories,
  meta,
  orderedActionPlans,
  patterns,
  planningRules,
  proposals,
  reviewFindings,
  reviews,
  routineItems,
  season,
  seasonHistory,
  settings,
  stages,
  threeYearHorizon,
  workIntervals,
  yearDirection,
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
        .set({
          focus: s.focus,
          whyItMatters: s.whyItMatters,
          startedAt: s.startedAt,
          version: s.version,
          updatedAt: s.updatedAt,
        })
        .where(and(eq(season.id, s.id), eq(season.version, expectedVersion)))
        .run().changes === 1,
  };
}

function seasonHistoryReader(q: Tx): SeasonHistoryReader {
  return { list: () => q.select().from(seasonHistory).orderBy(desc(seasonHistory.endedAt), desc(sql`rowid`)).all() };
}

function seasonHistoryRepository(q: Tx): SeasonHistoryRepository {
  return { ...seasonHistoryReader(q), insert: (e: SeasonHistoryEntry) => void q.insert(seasonHistory).values(e).run() };
}

function decadePlanReader(q: Tx): DecadePlanReader {
  return {
    findById: (id) => q.select().from(decadePlanItems).where(eq(decadePlanItems.id, id)).get(),
    list: () => q.select().from(decadePlanItems).orderBy(asc(decadePlanItems.startYear)).all(),
  };
}

function decadePlanRepository(q: Tx): DecadePlanRepository {
  return {
    ...decadePlanReader(q),
    insert: (item: DecadePlanItem) => void q.insert(decadePlanItems).values(item).run(),
    updateIfVersion: (item, expectedVersion) =>
      q
        .update(decadePlanItems)
        .set({
          startYear: item.startYear,
          endYear: item.endYear,
          statement: item.statement,
          version: item.version,
          updatedAt: item.updatedAt,
        })
        .where(and(eq(decadePlanItems.id, item.id), eq(decadePlanItems.version, expectedVersion)))
        .run().changes === 1,
    removeIfVersion: (id, expectedVersion) =>
      q
        .delete(decadePlanItems)
        .where(and(eq(decadePlanItems.id, id), eq(decadePlanItems.version, expectedVersion)))
        .run().changes === 1,
  };
}

function horizonReader(q: Tx): HorizonReader {
  return { get: () => q.select().from(threeYearHorizon).limit(1).get() };
}

function horizonRepository(q: Tx): HorizonRepository {
  return {
    ...horizonReader(q),
    insert: (h: ThreeYearHorizon) => void q.insert(threeYearHorizon).values(h).run(),
    updateIfVersion: (h, expectedVersion) =>
      q
        .update(threeYearHorizon)
        .set({
          startYear: h.startYear,
          endYear: h.endYear,
          direction: h.direction,
          whyItMatters: h.whyItMatters,
          version: h.version,
          updatedAt: h.updatedAt,
        })
        .where(and(eq(threeYearHorizon.id, h.id), eq(threeYearHorizon.version, expectedVersion)))
        .run().changes === 1,
  };
}

function yearDirectionReader(q: Tx): YearDirectionReader {
  return { get: () => q.select().from(yearDirection).limit(1).get() };
}

function yearDirectionRepository(q: Tx): YearDirectionRepository {
  return {
    ...yearDirectionReader(q),
    insert: (y: YearDirection) => void q.insert(yearDirection).values(y).run(),
    updateIfVersion: (y, expectedVersion) =>
      q
        .update(yearDirection)
        .set({
          year: y.year,
          direction: y.direction,
          whyItMatters: y.whyItMatters,
          version: y.version,
          updatedAt: y.updatedAt,
        })
        .where(and(eq(yearDirection.id, y.id), eq(yearDirection.version, expectedVersion)))
        .run().changes === 1,
  };
}

type RoutineRow = typeof routineItems.$inferSelect;
const rowToRoutine = (row: RoutineRow): RoutineItem => ({ ...row, kind: row.kind as RoutineKind });

function routineReader(q: Tx): RoutineReader {
  return {
    findById: (id) => {
      const row = q.select().from(routineItems).where(eq(routineItems.id, id)).get();
      return row ? rowToRoutine(row) : undefined;
    },
    // 'evening' sorts before 'morning' alphabetically, so the order of the day is spelled out.
    list: () =>
      q
        .select()
        .from(routineItems)
        .orderBy(sql`CASE ${routineItems.kind} WHEN 'morning' THEN 0 ELSE 1 END`, asc(routineItems.position))
        .all()
        .map(rowToRoutine),
    listByKind: (kind) =>
      q
        .select()
        .from(routineItems)
        .where(eq(routineItems.kind, kind))
        .orderBy(asc(routineItems.position))
        .all()
        .map(rowToRoutine),
  };
}

function routineRepository(q: Tx): RoutineRepository {
  return {
    ...routineReader(q),
    insert: (item: RoutineItem) => void q.insert(routineItems).values(item).run(),
    updateIfVersion: (item, expectedVersion) =>
      q
        .update(routineItems)
        .set({ text: item.text, active: item.active, version: item.version, updatedAt: item.updatedAt })
        .where(and(eq(routineItems.id, item.id), eq(routineItems.version, expectedVersion)))
        .run().changes === 1,
    removeIfVersion: (id, expectedVersion) =>
      q
        .delete(routineItems)
        .where(and(eq(routineItems.id, id), eq(routineItems.version, expectedVersion)))
        .run().changes === 1,
    reorder: (positions, now) => {
      for (const [id, position] of positions) {
        q.update(routineItems)
          .set({ position, version: sql`${routineItems.version} + 1`, updatedAt: now })
          .where(eq(routineItems.id, id))
          .run();
      }
    },
  };
}

type CourseChangeRow = typeof courseChanges.$inferSelect;
const rowToCourseChange = (row: CourseChangeRow): CourseChange => ({ ...row, level: row.level as CourseLevel });

function courseChangeReader(q: Tx): CourseChangeReader {
  return {
    findById: (id) => {
      const row = q.select().from(courseChanges).where(eq(courseChanges.id, id)).get();
      return row ? rowToCourseChange(row) : undefined;
    },
    listOpen: () =>
      q
        .select()
        .from(courseChanges)
        .where(isNull(courseChanges.resolvedAt))
        .orderBy(asc(courseChanges.changedAt), asc(sql`rowid`))
        .all()
        .map(rowToCourseChange),
    listAll: () =>
      q
        .select()
        .from(courseChanges)
        .orderBy(asc(courseChanges.changedAt), asc(sql`rowid`))
        .all()
        .map(rowToCourseChange),
  };
}

function courseChangeRepository(q: Tx): CourseChangeRepository {
  return {
    ...courseChangeReader(q),
    insert: (c: CourseChange) => void q.insert(courseChanges).values(c).run(),
    resolveIfOpen: (c) =>
      q
        .update(courseChanges)
        .set({ resolvedAt: c.resolvedAt })
        .where(and(eq(courseChanges.id, c.id), isNull(courseChanges.resolvedAt)))
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

type IntentionRow = typeof intentions.$inferSelect;
const rowToIntention = (row: IntentionRow): Intention => ({ ...row, status: row.status as IntentionStatus });

function intentionReader(q: Tx): IntentionReader {
  return {
    findById: (id) => {
      const row = q.select().from(intentions).where(eq(intentions.id, id)).get();
      return row ? rowToIntention(row) : undefined;
    },
    list: () =>
      q.select().from(intentions).orderBy(asc(intentions.createdAt), asc(sql`rowid`)).all().map(rowToIntention),
  };
}

function intentionRepository(q: Tx): IntentionRepository {
  return {
    ...intentionReader(q),
    insert: (i: Intention) => void q.insert(intentions).values(i).run(),
    updateIfVersion: (i, expectedVersion) =>
      q
        .update(intentions)
        .set({
          title: i.title,
          desiredResult: i.desiredResult,
          whyItMatters: i.whyItMatters,
          status: i.status,
          position: i.position,
          closedAt: i.closedAt,
          version: i.version,
          updatedAt: i.updatedAt,
        })
        .where(and(eq(intentions.id, i.id), eq(intentions.version, expectedVersion)))
        .run().changes === 1,
    // The order only decides which project is asked first: it is not content, so it leaves `version`
    // alone — reordering must not make a pending AI proposal about the project stale.
    reorder: (positions, now) => {
      for (const [id, position] of positions) {
        q.update(intentions).set({ position, updatedAt: now }).where(eq(intentions.id, id)).run();
      }
    },
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
      // bump exactly where something changed (ARCHITECTURE Â§13) instead of a blind overwrite.
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
    listCompletedBetween: (from, to) =>
      q
        .select()
        .from(actions)
        .where(and(gte(actions.completedAt, from), lt(actions.completedAt, to)))
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
    listResolvedBetween: (from, to) =>
      q
        .select()
        .from(proposals)
        .where(and(gte(proposals.resolvedAt, from), lt(proposals.resolvedAt, to)))
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

type CaptureRow = typeof captures.$inferSelect;
const rowToCapture = (row: CaptureRow): Capture => ({
  ...row,
  source: row.source as Capture["source"],
  state: row.state as CaptureState,
  result: row.result ?? null,
});

function captureReader(q: Tx): CaptureReader {
  return {
    findById: (id) => {
      const row = q.select().from(captures).where(eq(captures.id, id)).get();
      return row ? rowToCapture(row) : undefined;
    },
    listRecent: (limit, state) =>
      q
        .select()
        .from(captures)
        .where(state ? eq(captures.state, state) : undefined)
        .orderBy(desc(captures.createdAt), desc(sql`rowid`))
        .limit(limit)
        .all()
        .map(rowToCapture),
    findNextPending: () => {
      const row = q
        .select()
        .from(captures)
        .where(eq(captures.state, "pending"))
        .orderBy(asc(captures.createdAt), asc(sql`rowid`))
        .get();
      return row ? rowToCapture(row) : undefined;
    },
    listCreatedBetween: (from, to) =>
      q
        .select()
        .from(captures)
        .where(and(gte(captures.createdAt, from), lt(captures.createdAt, to)))
        .all()
        .map(rowToCapture),
    findByProposalId: (proposalId) => {
      const row = q.select().from(captures).where(eq(captures.proposalId, proposalId)).get();
      return row ? rowToCapture(row) : undefined;
    },
  };
}

function captureRepository(q: Tx): CaptureRepository {
  // Every transition names the states it may leave: a stale caller updates nothing (changes === 0).
  const move = (id: string, from: CaptureState, set: SQLiteUpdateSetSource<typeof captures>) =>
    q
      .update(captures)
      .set(set)
      .where(and(eq(captures.id, id), eq(captures.state, from)))
      .run().changes === 1;
  return {
    ...captureReader(q),
    insert: (c: Capture) => void q.insert(captures).values(c).run(),
    claim: (id, now) =>
      move(id, "pending", { state: "processing", attempts: sql`${captures.attempts} + 1`, updatedAt: now }),
    finish: (id, outcome, now) =>
      move(
        id,
        "processing",
        "result" in outcome
          ? { state: "processed", result: outcome.result, lastError: null, updatedAt: now }
          : { state: "failed", lastError: outcome.lastError, updatedAt: now },
      ),
    requeue: (id, now) => move(id, "failed", { state: "pending", updatedAt: now }),
    linkProposal: (id, proposalId) =>
      q
        .update(captures)
        .set({ proposalId })
        // A killed/timed-out run's MCP child may commit its Proposal after the Capture is marked failed:
        // still link it, so a retry answers ALREADY_PROPOSED instead of creating a second Proposal.
        .where(and(eq(captures.id, id), inArray(captures.state, ["processing", "failed"]), isNull(captures.proposalId)))
        .run().changes === 1,
    recover: (maxAttempts, now) =>
      // A run that crashed the app as often as the retry budget allows is given up, not re-run every launch.
      q
        .update(captures)
        .set({ state: "failed", lastError: "failed", updatedAt: now })
        .where(and(eq(captures.state, "processing"), sql`${captures.attempts} >= ${maxAttempts}`))
        .run().changes +
      q
        .update(captures)
        .set({ state: "pending", updatedAt: now })
        .where(
          or(
            eq(captures.state, "processing"),
            and(eq(captures.state, "failed"), sql`${captures.attempts} < ${maxAttempts}`),
          ),
        )
        .run().changes,
  };
}

type MemoryRow = typeof memories.$inferSelect;
const rowToMemory = (row: MemoryRow): Memory => ({ ...row, type: row.type as MemoryType });

function memoryReader(q: Tx): MemoryReader {
  return {
    // ponytail: whole table into memory for JS ranking (rankMemories); fine for one person's thousands
    // of memories â€” move filtering into SQL/FTS5 if it ever shows up in a profile.
    list: () => q.select().from(memories).orderBy(desc(memories.createdAt)).all().map(rowToMemory),
    listBySourceCaptures: (captureIds) =>
      captureIds.length === 0
        ? []
        : q
            .select()
            .from(memories)
            .where(inArray(memories.sourceCaptureId, captureIds as string[]))
            .orderBy(asc(memories.createdAt))
            .all()
            .map(rowToMemory),
    listCreatedBetween: (from, to) =>
      q
        .select()
        .from(memories)
        .where(and(gte(memories.createdAt, from), lt(memories.createdAt, to)))
        .all()
        .map(rowToMemory),
  };
}

function memoryRepository(q: Tx): MemoryRepository {
  return {
    ...memoryReader(q),
    insert: (m: Memory) =>
      void q
        .insert(memories)
        .values({ ...m, linkedEntityIds: [...m.linkedEntityIds] })
        .run(),
    remove: (id) => q.delete(memories).where(eq(memories.id, id)).run().changes > 0,
    verifySourceCapture: (id) =>
      void q.update(memories).set({ sourceCaptureVerified: true }).where(eq(memories.id, id)).run(),
  };
}

type ReviewRow = typeof reviews.$inferSelect;
const rowToReview = (row: ReviewRow): Review => ({
  ...row,
  type: row.type as ReviewType,
  status: row.status as ReviewStatus,
});

function reviewReader(q: Tx): ReviewReader {
  return {
    findById: (id) => {
      const row = q.select().from(reviews).where(eq(reviews.id, id)).get();
      return row ? rowToReview(row) : undefined;
    },
    findLatestByType: (type) => {
      const row = q
        .select()
        .from(reviews)
        .where(eq(reviews.type, type))
        .orderBy(desc(reviews.periodEnd))
        .limit(1)
        .get();
      return row ? rowToReview(row) : undefined;
    },
    listRecent: (limit) =>
      q.select().from(reviews).orderBy(desc(reviews.createdAt), desc(sql`rowid`)).limit(limit).all().map(rowToReview),
    findNextPending: () => {
      const row = q
        .select()
        .from(reviews)
        .where(eq(reviews.status, "needs_ai"))
        .orderBy(asc(reviews.createdAt), asc(sql`rowid`))
        .get();
      return row ? rowToReview(row) : undefined;
    },
    existsForPeriod: (type, periodStart, periodEnd) =>
      q
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.type, type), eq(reviews.periodStart, periodStart), eq(reviews.periodEnd, periodEnd)))
        .get() !== undefined,
  };
}

function reviewRepository(q: Tx): ReviewRepository {
  // Every transition names the state it may leave, mirroring captureRepository's `move` (a stale caller changes nothing).
  const move = (id: string, from: ReviewStatus, set: SQLiteUpdateSetSource<typeof reviews>) =>
    q
      .update(reviews)
      .set(set)
      .where(and(eq(reviews.id, id), eq(reviews.status, from)))
      .run().changes === 1;
  return {
    ...reviewReader(q),
    insert: (r) => void q.insert(reviews).values(r).run(),
    claim: (id, now) =>
      move(id, "needs_ai", { status: "processing", attempts: sql`${reviews.attempts} + 1`, updatedAt: now }),
    finish: (id, outcome, now) =>
      move(
        id,
        "processing",
        "status" in outcome
          ? { status: outcome.status, lastError: null, updatedAt: now }
          : { status: "failed", lastError: outcome.lastError, updatedAt: now },
      ),
    requeue: (id, now) => move(id, "failed", { status: "needs_ai", updatedAt: now }),
    recover: (maxAttempts, now) =>
      q
        .update(reviews)
        .set({ status: "failed", lastError: "failed", updatedAt: now })
        .where(and(eq(reviews.status, "processing"), sql`${reviews.attempts} >= ${maxAttempts}`))
        .run().changes +
      q
        .update(reviews)
        .set({ status: "needs_ai", updatedAt: now })
        .where(
          or(
            eq(reviews.status, "processing"),
            and(eq(reviews.status, "failed"), sql`${reviews.attempts} < ${maxAttempts}`),
          ),
        )
        .run().changes,
  };
}

type ReviewFindingRow = typeof reviewFindings.$inferSelect;
const rowToReviewFinding = (row: ReviewFindingRow): ReviewFinding => ({
  ...row,
  status: row.status as ReviewFindingStatus,
});

function reviewFindingReader(q: Tx): ReviewFindingReader {
  return {
    findById: (id) => {
      const row = q.select().from(reviewFindings).where(eq(reviewFindings.id, id)).get();
      return row ? rowToReviewFinding(row) : undefined;
    },
    listByReview: (reviewId) =>
      q
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.reviewId, reviewId))
        .orderBy(asc(reviewFindings.createdAt))
        .all()
        .map(rowToReviewFinding),
    listAcceptedByPatternKey: (key) =>
      q
        .select()
        .from(reviewFindings)
        .where(and(eq(reviewFindings.patternKey, key), inArray(reviewFindings.status, ["accepted", "corrected"])))
        .all()
        .map(rowToReviewFinding),
    listDistinctPatternThemes: (limit) => {
      // ponytail: dedupe-by-key in JS on a query already scoped to accepted/corrected+non-null
      // patternKey — fine for one person's Pattern themes, no window function needed.
      const seen = new Map<string, string>();
      for (const row of q
        .select()
        .from(reviewFindings)
        .where(and(isNotNull(reviewFindings.patternKey), inArray(reviewFindings.status, ["accepted", "corrected"])))
        .orderBy(desc(reviewFindings.createdAt))
        .all()
        .map(rowToReviewFinding)) {
        const key = row.patternKey as string;
        if (!seen.has(key)) seen.set(key, acceptedFindingText(row) ?? row.text);
        if (seen.size >= limit) break;
      }
      return [...seen.entries()].map(([patternKey, text]) => ({ patternKey, text }));
    },
  };
}

function reviewFindingRepository(q: Tx): ReviewFindingRepository {
  return {
    ...reviewFindingReader(q),
    insert: (f) =>
      void q
        .insert(reviewFindings)
        .values({ ...f, evidenceRefs: [...f.evidenceRefs], evidenceFactIds: [...f.evidenceFactIds] })
        .run(),
    resolveIfProposed: (f) =>
      q
        .update(reviewFindings)
        .set({ status: f.status, correctedText: f.correctedText, patternKey: f.patternKey, updatedAt: f.updatedAt })
        .where(and(eq(reviewFindings.id, f.id), eq(reviewFindings.status, "proposed")))
        .run().changes === 1,
  };
}

type PatternRow = typeof patterns.$inferSelect;
const rowToPattern = (row: PatternRow): Pattern => ({ ...row, status: row.status as PatternStatus });

function patternReader(q: Tx): PatternReader {
  return {
    findById: (id) => {
      const row = q.select().from(patterns).where(eq(patterns.id, id)).get();
      return row ? rowToPattern(row) : undefined;
    },
    listCandidates: (limit) =>
      q
        .select()
        .from(patterns)
        .where(eq(patterns.status, "candidate"))
        .orderBy(asc(patterns.createdAt))
        .limit(limit)
        .all()
        .map(rowToPattern),
    findByKey: (patternKey) => {
      const rows = q.select().from(patterns).where(eq(patterns.patternKey, patternKey)).all().map(rowToPattern);
      return (
        rows.find((p) => p.status !== "rejected") ?? rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      );
    },
  };
}

function patternRepository(q: Tx): PatternRepository {
  return {
    ...patternReader(q),
    insert: (p) =>
      void q
        .insert(patterns)
        .values({ ...p, evidenceFindingIds: [...p.evidenceFindingIds] })
        .run(),
    resolveIfCandidate: (p) =>
      q
        .update(patterns)
        .set({ status: p.status, resolvedAt: p.resolvedAt, resolvedBy: p.resolvedBy })
        .where(and(eq(patterns.id, p.id), eq(patterns.status, "candidate")))
        .run().changes === 1,
    growIfCandidate: (p) =>
      q
        .update(patterns)
        .set({ evidenceFindingIds: [...p.evidenceFindingIds], updatedAt: p.updatedAt })
        .where(and(eq(patterns.id, p.id), eq(patterns.status, "candidate")))
        .run().changes === 1,
  };
}

type PlanningRuleRow = typeof planningRules.$inferSelect;
const rowToPlanningRule = (row: PlanningRuleRow): PlanningRule => ({
  ...row,
  status: row.status as PlanningRuleStatus,
});

function planningRuleReader(q: Tx): PlanningRuleReader {
  return {
    findById: (id) => {
      const row = q.select().from(planningRules).where(eq(planningRules.id, id)).get();
      return row ? rowToPlanningRule(row) : undefined;
    },
    listActive: () =>
      q
        .select()
        .from(planningRules)
        .where(eq(planningRules.status, "active"))
        .orderBy(asc(planningRules.createdAt))
        .all()
        .map(rowToPlanningRule),
    listAll: (limit) =>
      q.select().from(planningRules).orderBy(desc(planningRules.createdAt)).limit(limit).all().map(rowToPlanningRule),
  };
}

function planningRuleRepository(q: Tx): PlanningRuleRepository {
  return {
    ...planningRuleReader(q),
    insert: (r) => void q.insert(planningRules).values(r).run(),
    deactivateIfActive: (r) =>
      q
        .update(planningRules)
        .set({ status: r.status, deactivatedAt: r.deactivatedAt })
        .where(and(eq(planningRules.id, r.id), eq(planningRules.status, "active")))
        .run().changes === 1,
  };
}

/**
 * Bookkeeping of AI processing (claim / failure / launch recovery) bumps the revision so the UI
 * refreshes, but is not a "meaningful change" (ARCHITECTURE Â§20): kept out of history and AI context.
 */
const UNLISTED_COMMANDS = [
  "calendar.save",
  "capture.claim",
  "capture.failed",
  "capture.recover",
  // M-A: upgrading an existing Memory's provenance from unverified to verified (a trusted Capture job
  // catching up to an earlier untethered-session claim) is bookkeeping on an already-saved Memory, not
  // a second "AI saved a memory" event.
  "memory.verify",
  "review.claim",
  "review.failed",
  "review.recover",
  // A launch catch-up can schedule and finish up to 101 due periods in one run (60 daily/26
  // weekly/10 seasonal/5 yearly) — routine scheduler bookkeeping, not a "meaningful change"
  // (ARCHITECTURE §20), so excluded here too, same as review.claim/failed/recover above, or it would
  // flood both the user-facing history feed and MCP's `recentHistory` planning context. Unlike these,
  // `review.retry` is the user's own deliberate «Повторить» click (mirrors `capture.retry`, also not
  // unlisted) and stays visible.
  "review.due",
  "review.processed",
  "review.findingCreated",
];

function changeLogReader(q: Tx): ChangeLogReader {
  return {
    // One command may log several entries under one revision; rowid keeps their insertion order.
    // `calendar.save` fires on every launch and every manual refresh â€” routine, not a "meaningful
    // change" (ARCHITECTURE Â§20) â€” so it is excluded here rather than flooding the AI's
    // `recentHistory` context and the user-facing history feed; it is still recorded in the table for
    // the state-revision bump and direct inspection.
    listRecent: (limit) =>
      q
        .select()
        .from(changeLog)
        .where(notInArray(changeLog.commandType, UNLISTED_COMMANDS))
        .orderBy(desc(changeLog.stateRevision), desc(sql`rowid`))
        .limit(limit)
        .all(),
    // Unfiltered (unlike listRecent above) — Review evidence needs the full picture, oldest first.
    listBetween: (from, to) =>
      q
        .select()
        .from(changeLog)
        .where(and(gte(changeLog.timestamp, from), lt(changeLog.timestamp, to)))
        .orderBy(asc(changeLog.stateRevision), asc(sql`rowid`))
        .all(),
    listByCommandTypes: (commandTypes) =>
      commandTypes.length === 0
        ? []
        : q
            .select()
            .from(changeLog)
            .where(inArray(changeLog.commandType, commandTypes as string[]))
            .orderBy(asc(changeLog.stateRevision), asc(sql`rowid`))
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
            seasonHistory: seasonHistoryReader(tx),
            decades: decadePlanReader(tx),
            horizon: horizonReader(tx),
            year: yearDirectionReader(tx),
            routines: routineReader(tx),
            courseChanges: courseChangeReader(tx),
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
            captures: captureReader(tx),
            memories: memoryReader(tx),
            reviews: reviewReader(tx),
            reviewFindings: reviewFindingReader(tx),
            patterns: patternReader(tx),
            planningRules: planningRuleReader(tx),
            stateRevision: () => readRevision(tx),
          }),
        { behavior: "deferred" },
      ),

    // IMMEDIATE: take the write lock up front (waiting up to busy_timeout). A deferred
    // readâ†’write upgrade in WAL fails instantly with SQLITE_BUSY when another process committed.
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
          // One command = one revision bump (ARCHITECTURE Â§14/Â§44), however many entries it logs.
          let revision: number | undefined;
          const result = work({
            season: seasonRepository(tx),
            seasonHistory: seasonHistoryRepository(tx),
            decades: decadePlanRepository(tx),
            horizon: horizonRepository(tx),
            year: yearDirectionRepository(tx),
            routines: routineRepository(tx),
            courseChanges: courseChangeRepository(tx),
            goodLifeConditions: goodLifeConditionRepository(tx),
            intentions: intentionRepository(tx),
            stages: stageRepository(tx),
            actions: actionRepository(tx),
            plans: planRepository(tx),
            proposals: proposalRepository(tx),
            calendar: calendarSnapshotRepository(tx),
            work: workRepository(tx),
            settings: settingsRepository(tx),
            captures: captureRepository(tx),
            memories: memoryRepository(tx),
            reviews: reviewRepository(tx),
            reviewFindings: reviewFindingRepository(tx),
            patterns: patternRepository(tx),
            planningRules: planningRuleRepository(tx),
            changeLog: changeLogReader(tx),
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
          // Structural guarantee (ARCHITECTURE Â§44): a command must not depend on remembering to
          // call recordChange. If it mutated rows without recording the change, roll back instead
          // of silently breaking the change log / MCPâ†’UI revision watch. Note: SQLite's
          // total_changes() counts a same-value UPDATE (`SET x = x`) as a change too, so a future
          // idempotent no-op command would also need to call recordChange â€” no command does today.
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
