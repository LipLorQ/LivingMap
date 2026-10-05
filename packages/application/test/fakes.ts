import type { CalendarSnapshotDto } from "@living-map/contracts";
import type {
  Action,
  CourseChange,
  DecadePlanItem,
  GoodLifeCondition,
  HouseholdItem,
  Instant,
  Intention,
  OrderedActionPlan,
  Pattern,
  PlanningRule,
  Proposal,
  Review,
  ReviewFinding,
  RoutineItem,
  Season,
  SeasonHistoryEntry,
  Stage,
  ThreeYearHorizon,
  YearDirection,
} from "@living-map/domain";
import type { IdGenerator, Store } from "../src";

// In-memory Store fake: exercises application logic without any storage technology.
export function memoryStore(): Store & { revision: number; changes: string[]; rollbacks: number } {
  let seasonRow: Season | undefined;
  const glc = new Map<string, GoodLifeCondition>();
  const intentionRows = new Map<string, Intention>();
  const stageRows = new Map<string, Stage>();
  const actionRows = new Map<string, Action>();
  // Stage 3 aggregates are exercised against real SQLite (persistence-sqlite/test/planning.test.ts);
  // here they only need to exist so the fake satisfies the scope ports.
  const planRows = new Map<string, OrderedActionPlan>();
  const proposalRows = new Map<string, Proposal>();
  const reviewRows = new Map<string, Review>();
  const reviewFindingRows = new Map<string, ReviewFinding>();
  const patternRows = new Map<string, Pattern>();
  const planningRuleRows = new Map<string, PlanningRule>();
  // Stage 8 aggregates (the real SQLite behaviour is exercised in persistence-sqlite/test/map.test.ts).
  const seasonHistoryRows: SeasonHistoryEntry[] = [];
  const decadeRows = new Map<string, DecadePlanItem>();
  let horizonRow: ThreeYearHorizon | undefined;
  let yearRow: YearDirection | undefined;
  const routineRows = new Map<string, RoutineItem>();
  const courseChangeRows = new Map<string, CourseChange>();
  let calendarRow: CalendarSnapshotDto = {
    connected: false,
    syncedAt: null,
    source: null,
    timeZone: null,
    events: [],
    lastError: null,
  };
  const calendarReader = { get: () => calendarRow };
  // Execution (Stage 5) is exercised against real SQLite (persistence-sqlite/test/execution.test.ts).
  const workReader = { findRunning: () => undefined, listByAction: () => [], listEndedSince: () => [] };
  let selectedIntentionId: string | null = null;
  const settingsReader = { dailyWorkTargetMinutes: () => 360, selectedIntentionId: () => selectedIntentionId };
  // Stages archived by an owner-approved plan replacement (Stage 9): history, never returned as live.
  const archivedStageIds = new Set<string>();
  const liveStage = (id: string) => (archivedStageIds.has(id) ? undefined : stageRows.get(id));
  const liveStagesOf = (iid: string) =>
    byPosition([...stageRows.values()].filter((st) => st.intentionId === iid && !archivedStageIds.has(st.id)));
  const householdRows = new Map<string, HouseholdItem>();
  const householdReader = {
    findById: (id: string) => householdRows.get(id),
    listActive: () => [...householdRows.values()].filter((h) => h.status === "active"),
    listRecentlyDone: (limit: number) =>
      [...householdRows.values()]
        .filter((h) => h.status === "done")
        .reverse()
        .slice(0, limit),
    listBySourceCaptures: (ids: readonly string[]) =>
      [...householdRows.values()].filter((h) => h.sourceCaptureId !== null && ids.includes(h.sourceCaptureId)),
  };
  // Captures / Memory (Stage 6) are exercised against real SQLite (persistence-sqlite/test/capture.test.ts).
  const capturesReader = {
    findById: () => undefined,
    listRecent: () => [],
    findNextPending: () => undefined,
    findByProposalId: () => undefined,
  };
  const memoriesReader = { list: () => [], listBySourceCaptures: () => [] };
  const seasonHistoryReader = { list: () => [...seasonHistoryRows].reverse() };
  const decadesReader = {
    findById: (id: string) => decadeRows.get(id),
    list: () => [...decadeRows.values()].sort((a, b) => a.startYear - b.startYear),
  };
  const routinesReader = {
    findById: (id: string) => routineRows.get(id),
    list: () =>
      [...routineRows.values()].sort(
        (a, b) => (a.kind === b.kind ? 0 : a.kind === "morning" ? -1 : 1) || a.position - b.position,
      ),
    listByKind: (kind: RoutineItem["kind"]) =>
      [...routineRows.values()].filter((r) => r.kind === kind).sort((a, b) => a.position - b.position),
  };
  const courseChangesReader = {
    findById: (id: string) => courseChangeRows.get(id),
    listOpen: () => [...courseChangeRows.values()].filter((c) => c.resolvedAt === null),
    listAll: () => [...courseChangeRows.values()],
  };
  const plansReader = { findByIntention: (iid: string) => [...planRows.values()].find((p) => p.intentionId === iid) };
  const proposalsReader = {
    findById: (id: string) => proposalRows.get(id),
    listPending: () => [...proposalRows.values()].filter((p) => p.status === "pending"),
    listResolvedBetween: (from: Instant, to: Instant) =>
      [...proposalRows.values()].filter((p) => p.resolvedAt !== null && p.resolvedAt >= from && p.resolvedAt < to),
  };
  const reviewsReader = {
    findById: (id: string) => reviewRows.get(id),
    findLatestByType: (type: Review["type"]) =>
      [...reviewRows.values()].filter((r) => r.type === type).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    listRecent: (limit: number) =>
      [...reviewRows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
    findNextPending: () =>
      [...reviewRows.values()]
        .filter((r) => r.status === "needs_ai")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0],
    existsForPeriod: (type: Review["type"], periodStart: Instant, periodEnd: Instant) =>
      [...reviewRows.values()].some(
        (r) => r.type === type && r.periodStart === periodStart && r.periodEnd === periodEnd,
      ),
  };
  const reviewFindingsReader = {
    findById: (id: string) => reviewFindingRows.get(id),
    listByReview: (reviewId: string) => [...reviewFindingRows.values()].filter((f) => f.reviewId === reviewId),
    listAcceptedByPatternKey: (key: string) =>
      [...reviewFindingRows.values()].filter(
        (f) => f.patternKey === key && (f.status === "accepted" || f.status === "corrected"),
      ),
    listDistinctPatternThemes: (limit: number) => {
      const seen = new Map<string, string>();
      const newestFirst = [...reviewFindingRows.values()]
        .filter((f) => f.patternKey !== null && (f.status === "accepted" || f.status === "corrected"))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const f of newestFirst) {
        const key = f.patternKey as string;
        if (!seen.has(key)) seen.set(key, f.status === "corrected" ? (f.correctedText as string) : f.text);
        if (seen.size >= limit) break;
      }
      return [...seen.entries()].map(([patternKey, text]) => ({ patternKey, text }));
    },
  };
  const patternsReader = {
    findById: (id: string) => patternRows.get(id),
    listCandidates: (limit: number) =>
      [...patternRows.values()].filter((p) => p.status === "candidate").slice(0, limit),
    findByKey: (patternKey: string) => {
      const rows = [...patternRows.values()].filter((p) => p.patternKey === patternKey);
      return (
        rows.find((p) => p.status !== "rejected") ?? rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      );
    },
  };
  const planningRulesReader = {
    findById: (id: string) => planningRuleRows.get(id),
    listActive: () => [...planningRuleRows.values()].filter((r) => r.status === "active"),
    listAll: (limit: number) => [...planningRuleRows.values()].slice(0, limit),
  };
  const changeLogRows: Array<{
    id: string;
    timestamp: Instant;
    actor: string;
    correlationId: string;
    stateRevision: number;
    commandType: string;
    entityType: string;
    entityId: string;
    summary: string;
  }> = [];

  const byPosition = <T extends { position: number }>(items: T[]) => items.sort((a, b) => a.position - b.position);

  const state = {
    revision: 0,
    changes: [] as string[],
    rollbacks: 0,
    read: <T>(work: Parameters<Store["read"]>[0]) =>
      work({
        season: { get: () => seasonRow },
        seasonHistory: seasonHistoryReader,
        decades: decadesReader,
        horizon: { get: () => horizonRow },
        year: { get: () => yearRow },
        routines: routinesReader,
        courseChanges: courseChangesReader,
        goodLifeConditions: { findById: (id) => glc.get(id), list: () => byPosition([...glc.values()]) },
        intentions: {
          findById: (id) => intentionRows.get(id),
          list: () => [...intentionRows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        },
        stages: { findById: liveStage, listByIntention: liveStagesOf },
        actions: {
          findById: (id) => actionRows.get(id),
          listByStage: (sid) => byPosition([...actionRows.values()].filter((a) => a.stageId === sid)),
          listByStages: (sids) => byPosition([...actionRows.values()].filter((a) => sids.includes(a.stageId))),
          listCompletedBetween: (from, to) =>
            [...actionRows.values()].filter(
              (a) => a.completedAt !== null && a.completedAt >= from && a.completedAt < to,
            ),
        },
        plans: plansReader,
        proposals: proposalsReader,
        changeLog: {
          listRecent: (limit) => changeLogRows.slice().reverse().slice(0, limit),
          listBetween: (from, to) => changeLogRows.filter((c) => c.timestamp >= from && c.timestamp < to),
          listByCommandTypes: (types) => changeLogRows.filter((c) => types.includes(c.commandType)),
        },
        calendar: calendarReader,
        work: workReader,
        settings: settingsReader,
        household: householdReader,
        captures: { ...capturesReader, listCreatedBetween: () => [] },
        memories: { ...memoriesReader, listCreatedBetween: () => [] },
        reviews: reviewsReader,
        reviewFindings: reviewFindingsReader,
        patterns: patternsReader,
        planningRules: planningRulesReader,
        stateRevision: () => state.revision,
      }) as T,
    touchWorkHeartbeat: () => {},
    write: <T>(ctx: Parameters<Store["write"]>[0], work: Parameters<Store["write"]>[1]) => {
      const snapshot = {
        season: seasonRow,
        glc: new Map(glc),
        intentionRows: new Map(intentionRows),
        stageRows: new Map(stageRows),
        actionRows: new Map(actionRows),
        planRows: new Map(planRows),
        proposalRows: new Map(proposalRows),
        reviewRows: new Map(reviewRows),
        reviewFindingRows: new Map(reviewFindingRows),
        patternRows: new Map(patternRows),
        planningRuleRows: new Map(planningRuleRows),
        seasonHistoryRows: [...seasonHistoryRows],
        decadeRows: new Map(decadeRows),
        horizonRow,
        yearRow,
        routineRows: new Map(routineRows),
        courseChangeRows: new Map(courseChangeRows),
        calendarRow,
        revision: state.revision,
        changes: [...state.changes],
        changeLogRows: [...changeLogRows],
      };
      try {
        return runWork(work);
      } catch (error) {
        seasonRow = snapshot.season;
        calendarRow = snapshot.calendarRow;
        glc.clear();
        for (const [k, v] of snapshot.glc) glc.set(k, v);
        intentionRows.clear();
        for (const [k, v] of snapshot.intentionRows) intentionRows.set(k, v);
        stageRows.clear();
        for (const [k, v] of snapshot.stageRows) stageRows.set(k, v);
        actionRows.clear();
        for (const [k, v] of snapshot.actionRows) actionRows.set(k, v);
        planRows.clear();
        for (const [k, v] of snapshot.planRows) planRows.set(k, v);
        proposalRows.clear();
        for (const [k, v] of snapshot.proposalRows) proposalRows.set(k, v);
        reviewRows.clear();
        for (const [k, v] of snapshot.reviewRows) reviewRows.set(k, v);
        reviewFindingRows.clear();
        for (const [k, v] of snapshot.reviewFindingRows) reviewFindingRows.set(k, v);
        patternRows.clear();
        for (const [k, v] of snapshot.patternRows) patternRows.set(k, v);
        planningRuleRows.clear();
        for (const [k, v] of snapshot.planningRuleRows) planningRuleRows.set(k, v);
        seasonHistoryRows.length = 0;
        seasonHistoryRows.push(...snapshot.seasonHistoryRows);
        decadeRows.clear();
        for (const [k, v] of snapshot.decadeRows) decadeRows.set(k, v);
        horizonRow = snapshot.horizonRow;
        yearRow = snapshot.yearRow;
        routineRows.clear();
        for (const [k, v] of snapshot.routineRows) routineRows.set(k, v);
        courseChangeRows.clear();
        for (const [k, v] of snapshot.courseChangeRows) courseChangeRows.set(k, v);
        state.revision = snapshot.revision;
        state.changes = snapshot.changes;
        changeLogRows.length = 0;
        changeLogRows.push(...snapshot.changeLogRows);
        state.rollbacks++;
        throw error;
      }
      function runWork(w: Parameters<Store["write"]>[1]): T {
        const startRevision = state.revision;
        return w({
          season: {
            get: () => seasonRow,
            insert: (s) => {
              seasonRow = s;
            },
            updateIfVersion: (s, expected) => {
              if (seasonRow?.version !== expected) return false;
              seasonRow = s;
              return true;
            },
          },
          seasonHistory: { ...seasonHistoryReader, insert: (e) => void seasonHistoryRows.push(e) },
          decades: {
            ...decadesReader,
            insert: (d) => void decadeRows.set(d.id, d),
            updateIfVersion: (d, expected) => {
              if (decadeRows.get(d.id)?.version !== expected) return false;
              decadeRows.set(d.id, d);
              return true;
            },
            removeIfVersion: (id, expected) => {
              if (decadeRows.get(id)?.version !== expected) return false;
              decadeRows.delete(id);
              return true;
            },
          },
          horizon: {
            get: () => horizonRow,
            insert: (h) => {
              horizonRow = h;
            },
            updateIfVersion: (h, expected) => {
              if (horizonRow?.version !== expected) return false;
              horizonRow = h;
              return true;
            },
          },
          year: {
            get: () => yearRow,
            insert: (y) => {
              yearRow = y;
            },
            updateIfVersion: (y, expected) => {
              if (yearRow?.version !== expected) return false;
              yearRow = y;
              return true;
            },
          },
          routines: {
            ...routinesReader,
            insert: (r) => void routineRows.set(r.id, r),
            updateIfVersion: (r, expected) => {
              if (routineRows.get(r.id)?.version !== expected) return false;
              routineRows.set(r.id, r);
              return true;
            },
            removeIfVersion: (id, expected) => {
              if (routineRows.get(id)?.version !== expected) return false;
              routineRows.delete(id);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = routineRows.get(id);
                if (cur) routineRows.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
          },
          courseChanges: {
            ...courseChangesReader,
            insert: (c) => void courseChangeRows.set(c.id, c),
            resolveIfOpen: (c) => {
              if (courseChangeRows.get(c.id)?.resolvedAt !== null) return false;
              courseChangeRows.set(c.id, c);
              return true;
            },
          },
          goodLifeConditions: {
            findById: (id) => glc.get(id),
            list: () => byPosition([...glc.values()]),
            insert: (c) => void glc.set(c.id, c),
            updateIfVersion: (c, expected) => {
              if (glc.get(c.id)?.version !== expected) return false;
              glc.set(c.id, c);
              return true;
            },
            removeIfVersion: (id, expected) => {
              if (glc.get(id)?.version !== expected) return false;
              glc.delete(id);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = glc.get(id);
                if (cur) glc.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
          },
          intentions: {
            findById: (id) => intentionRows.get(id),
            list: () => [...intentionRows.values()],
            insert: (i) => void intentionRows.set(i.id, i),
            updateIfVersion: (i, expected) => {
              if (intentionRows.get(i.id)?.version !== expected) return false;
              intentionRows.set(i.id, i);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = intentionRows.get(id);
                if (cur) intentionRows.set(id, { ...cur, position, updatedAt: now });
              }
            },
          },
          stages: {
            findById: liveStage,
            listByIntention: liveStagesOf,
            insert: (s) => void stageRows.set(s.id, s),
            updateIfVersion: (s, expected) => {
              if (stageRows.get(s.id)?.version !== expected) return false;
              stageRows.set(s.id, s);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = stageRows.get(id);
                if (cur) stageRows.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
            setCurrent: (intentionId, stageId, now) => {
              for (const [id, s] of stageRows) {
                if (s.intentionId !== intentionId || s.isCurrent === (id === stageId)) continue;
                stageRows.set(id, { ...s, isCurrent: id === stageId, version: s.version + 1, updatedAt: now });
              }
            },
            archive: (ids, now) => {
              for (const id of ids) {
                const cur = liveStage(id);
                if (!cur) continue;
                stageRows.set(id, { ...cur, isCurrent: false, version: cur.version + 1, updatedAt: now });
                archivedStageIds.add(id);
              }
            },
          },
          actions: {
            findById: (id) => actionRows.get(id),
            listByStage: (sid) => byPosition([...actionRows.values()].filter((a) => a.stageId === sid)),
            listByStages: (sids) => byPosition([...actionRows.values()].filter((a) => sids.includes(a.stageId))),
            listCompletedBetween: (from, to) =>
              [...actionRows.values()].filter(
                (a) => a.completedAt !== null && a.completedAt >= from && a.completedAt < to,
              ),
            insert: (a) => void actionRows.set(a.id, a),
            updateIfVersion: (a, expected) => {
              if (actionRows.get(a.id)?.version !== expected) return false;
              actionRows.set(a.id, a);
              return true;
            },
            relocateIfVersion: (a, expected) => {
              if (actionRows.get(a.id)?.version !== expected) return false;
              actionRows.set(a.id, a);
              return true;
            },
            reorder: (positions, now) => {
              for (const [id, position] of positions) {
                const cur = actionRows.get(id);
                if (cur) actionRows.set(id, { ...cur, position, version: cur.version + 1, updatedAt: now });
              }
            },
          },
          plans: {
            ...plansReader,
            insert: (p) => void planRows.set(p.id, p),
            updateIfVersion: (p, expected) => {
              if (planRows.get(p.id)?.version !== expected) return false;
              planRows.set(p.id, p);
              return true;
            },
          },
          proposals: {
            ...proposalsReader,
            insert: (p) => void proposalRows.set(p.id, p),
            resolveIfPending: (p) => {
              if (proposalRows.get(p.id)?.status !== "pending") return false;
              proposalRows.set(p.id, p);
              return true;
            },
          },
          calendar: {
            get: () => calendarRow,
            save: (snapshot) => {
              calendarRow = snapshot;
            },
          },
          work: { ...workReader, insert: () => {}, closeIfRunning: () => false },
          settings: {
            ...settingsReader,
            setDailyWorkTargetMinutes: () => {},
            setSelectedIntentionId: (id) => {
              selectedIntentionId = id;
            },
          },
          household: {
            ...householdReader,
            insert: (h) => void householdRows.set(h.id, h),
            completeIfActive: (h) => {
              if (householdRows.get(h.id)?.status !== "active") return false;
              householdRows.set(h.id, h);
              return true;
            },
          },
          captures: {
            ...capturesReader,
            listCreatedBetween: () => [],
            insert: () => {},
            claim: () => false,
            finish: () => false,
            requeue: () => false,
            linkProposal: () => false,
            recover: () => 0,
          },
          memories: {
            ...memoriesReader,
            listCreatedBetween: () => [],
            insert: () => {},
            remove: () => false,
            verifySourceCapture: () => {},
          },
          reviews: {
            ...reviewsReader,
            insert: (r) => void reviewRows.set(r.id, r),
            claim: (id, now) => {
              const cur = reviewRows.get(id);
              if (cur?.status !== "needs_ai") return false;
              reviewRows.set(id, { ...cur, status: "processing", attempts: cur.attempts + 1, updatedAt: now });
              return true;
            },
            finish: (id, outcome, now) => {
              const cur = reviewRows.get(id);
              if (cur?.status !== "processing") return false;
              reviewRows.set(id, {
                ...cur,
                status: "status" in outcome ? outcome.status : "failed",
                lastError: "lastError" in outcome ? outcome.lastError : null,
                updatedAt: now,
              });
              return true;
            },
            requeue: (id, now) => {
              const cur = reviewRows.get(id);
              if (cur?.status !== "failed") return false;
              reviewRows.set(id, { ...cur, status: "needs_ai", updatedAt: now });
              return true;
            },
            recover: (maxAttempts, now) => {
              let n = 0;
              for (const [id, r] of reviewRows) {
                if (r.status === "processing" && r.attempts >= maxAttempts) {
                  reviewRows.set(id, { ...r, status: "failed", lastError: "failed", updatedAt: now });
                  n++;
                } else if (r.status === "processing" || (r.status === "failed" && r.attempts < maxAttempts)) {
                  reviewRows.set(id, { ...r, status: "needs_ai", updatedAt: now });
                  n++;
                }
              }
              return n;
            },
          },
          reviewFindings: {
            ...reviewFindingsReader,
            insert: (f) => void reviewFindingRows.set(f.id, f),
            resolveIfProposed: (f) => {
              if (reviewFindingRows.get(f.id)?.status !== "proposed") return false;
              reviewFindingRows.set(f.id, f);
              return true;
            },
          },
          patterns: {
            ...patternsReader,
            insert: (p) => void patternRows.set(p.id, p),
            resolveIfCandidate: (p) => {
              if (patternRows.get(p.id)?.status !== "candidate") return false;
              patternRows.set(p.id, p);
              return true;
            },
            growIfCandidate: (p) => {
              if (patternRows.get(p.id)?.status !== "candidate") return false;
              patternRows.set(p.id, p);
              return true;
            },
          },
          planningRules: {
            ...planningRulesReader,
            insert: (r) => void planningRuleRows.set(r.id, r),
            deactivateIfActive: (r) => {
              if (planningRuleRows.get(r.id)?.status !== "active") return false;
              planningRuleRows.set(r.id, r);
              return true;
            },
          },
          changeLog: {
            listRecent: (limit) => changeLogRows.slice().reverse().slice(0, limit),
            listBetween: (from, to) => changeLogRows.filter((c) => c.timestamp >= from && c.timestamp < to),
            listByCommandTypes: (types) => changeLogRows.filter((c) => types.includes(c.commandType)),
          },
          stateRevision: () => startRevision,
          recordChange: (c) => {
            state.changes.push(c.commandType);
            if (state.revision === startRevision) state.revision++;
            changeLogRows.push({
              id: `cl-${state.revision}`,
              timestamp: ctx.timestamp,
              actor: ctx.actor,
              correlationId: ctx.correlationId,
              stateRevision: state.revision,
              ...c,
            });
            return state.revision;
          },
        }) as T;
      }
    },
  };
  return state;
}

export function sequentialIds(): IdGenerator {
  let n = 0;
  return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}
