import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, type Clock, createAiSurface, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import type { Instant } from "@living-map/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStore, databaseFile, openDesktopDatabase, type SqliteHandle, uuidGenerator } from "../src";

const TZ = "Europe/Moscow";

function mutableClock(initial: Instant): Clock & { set: (now: Instant) => void } {
  let now = initial;
  return {
    now: () => now,
    set: (n) => {
      now = n;
    },
  };
}

let home: string;
let handle: SqliteHandle;
let app: Application;
let clock: ReturnType<typeof mutableClock>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-review-"));
  handle = openDesktopDatabase(databaseFile(home));
  clock = mutableClock("2026-09-25T08:00:00.000Z");
  app = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock,
    ids: uuidGenerator,
    timeZone: () => TZ,
  });
});
afterEach(() => {
  if (handle.sqlite.open) handle.close();
  rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ui = () => app.newContext("user-ui", "test");
const sys = () => app.newContext("system", "test");

function recordFact(at: Instant): void {
  clock.set(at);
  const season = app.queries.getSeason();
  if (season.ok && season.value) {
    app.commands.updateSeasonFocus(ui(), {
      expectedVersion: season.value.version,
      focus: `focus @ ${at}`,
      startsNewSeason: false,
    });
  } else {
    app.commands.createSeason(ui(), { focus: `focus @ ${at}` });
  }
}

function claimFreshDaily(rollTo: Instant) {
  clock.set(rollTo);
  unwrap(app.commands.scheduleDueReviews(sys(), { timeZone: TZ }));
  const due = unwrap(app.queries.listReviews({ limit: 50 })).find((r) => r.type === "daily" && r.status === "needs_ai");
  if (!due) throw new Error("no due daily review");
  for (let i = 0; i < 10; i++) {
    const claimed = unwrap(app.commands.claimNextReview(sys()));
    if (!claimed) throw new Error("nothing to claim");
    if (claimed.id === due.id) return due;
    unwrap(
      app.commands.finishReview(sys(), { id: claimed.id, outcome: { ok: true, result: { kind: "no_useful_change" } } }),
    );
  }
  throw new Error("daily review never got claimed");
}

/** Rolls the clock forward and claims the freshest due Review of `type`, draining any other type first. */
function claimFreshOfType(rollTo: Instant, type: "daily" | "weekly") {
  clock.set(rollTo);
  unwrap(app.commands.scheduleDueReviews(sys(), { timeZone: TZ }));
  const candidates = unwrap(app.queries.listReviews({ limit: 200 })).filter(
    (r) => r.type === type && r.status === "needs_ai",
  );
  const due = candidates.sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
  if (!due) throw new Error(`no due ${type} review`);
  for (let i = 0; i < 30; i++) {
    const claimed = unwrap(app.commands.claimNextReview(sys()));
    if (!claimed) throw new Error(`nothing to claim for ${type}`);
    if (claimed.id === due.id) return due;
    unwrap(
      app.commands.finishReview(sys(), { id: claimed.id, outcome: { ok: true, result: { kind: "no_useful_change" } } }),
    );
  }
  throw new Error(`${type} review never got claimed`);
}

/** One real Intention/Stage/Action, made the current action through a real accepted route proposal. */
function seedAction(): string {
  const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
  const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Build" }));
  const action = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "Work", doneWhen: "" }));
  const proposal = unwrap(
    app.commands.createRouteProposal(app.newContext("mcp-ai", "test"), {
      intentionId: intention.id,
      expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
      summary: "Order",
      rationale: "Order",
      newStages: [],
      stageEdits: [],
      newActions: [],
      actionEdits: [],
      actionOrder: [action.id],
    }),
  );
  unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
  return action.id;
}

/** Finishes a claimed Review with one finding citing `refs` under `patternKey`, then accepts it. */
function finishAndAcceptRefs(reviewId: string, refs: readonly string[], patternKey: string, text = "x"): void {
  const finished = unwrap(
    app.commands.finishReview(sys(), {
      id: reviewId,
      outcome: {
        ok: true,
        result: { kind: "findings", findings: [{ text, evidenceRefs: [...refs], suggestion: null, patternKey }] },
      },
    }),
  );
  const findingId = finished.findings[0]?.id as string;
  unwrap(app.commands.acceptReviewFinding(ui(), { id: findingId }));
}

/** Finishes a claimed Review with one finding citing `ref` under `patternKey`, then accepts it. */
function finishAndAccept(reviewId: string, ref: string, patternKey: string, text = "x"): void {
  finishAndAcceptRefs(reviewId, [ref], patternKey, text);
}

describe("Review persistence (real SQLite)", () => {
  it("the unique (type, period) index makes a duplicate Review impossible even bypassing the app-level check", () => {
    recordFact("2026-09-25T10:00:00.000Z");
    claimFreshDaily("2026-09-26T07:00:00.000Z");
    const row = handle.sqlite
      .prepare("select id, type, period_start, period_end from reviews where type = 'daily'")
      .get() as {
      id: string;
      type: string;
      period_start: string;
      period_end: string;
    };
    expect(() =>
      handle.sqlite
        .prepare(
          "insert into reviews (id, type, period_start, period_end, time_zone, status, attempts, last_error, created_at, updated_at) values (?, ?, ?, ?, ?, 'needs_ai', 0, NULL, ?, ?)",
        )
        .run(
          "duplicate-id",
          row.type,
          row.period_start,
          row.period_end,
          TZ,
          "2026-09-26T07:00:00.000Z",
          "2026-09-26T07:00:00.000Z",
        ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("evidenceRefs and evidenceFindingIds round-trip through JSON exactly, including order", () => {
    recordFact("2026-09-25T10:00:00.000Z");
    recordFact("2026-09-25T10:05:00.000Z");
    const daily = claimFreshDaily("2026-09-26T07:00:00.000Z");
    const evidence = unwrap(app.queries.getReviewEvidence({ id: daily.id }));
    expect(evidence.items.length).toBeGreaterThanOrEqual(2);
    const refs = evidence.items.slice(0, 2).map((i) => i.id);
    const finished = unwrap(
      app.commands.finishReview(sys(), {
        id: daily.id,
        outcome: {
          ok: true,
          result: {
            kind: "findings",
            findings: [{ text: "Test", evidenceRefs: refs, suggestion: null, patternKey: null }],
          },
        },
      }),
    );
    expect(finished.findings[0]?.evidenceRefs).toEqual(refs);

    // Re-read through a fresh connection/query to prove it was actually persisted, not just cached in memory.
    const reread = unwrap(app.queries.getReview({ id: daily.id }));
    expect(reread.findings[0]?.evidenceRefs).toEqual(refs);
  });

  it("full pipeline against real SQLite: schedule → process → accept twice → candidate → confirm → active rule in planning context", () => {
    recordFact("2026-09-24T10:00:00.000Z");
    const day1 = claimFreshDaily("2026-09-25T07:00:00.000Z");
    const ev1 = unwrap(app.queries.getReviewEvidence({ id: day1.id })).items[0]?.id as string;
    const f1 = unwrap(
      app.commands.finishReview(sys(), {
        id: day1.id,
        outcome: {
          ok: true,
          result: {
            kind: "findings",
            findings: [{ text: "A", evidenceRefs: [ev1], suggestion: null, patternKey: "doctor-visits" }],
          },
        },
      }),
    ).findings[0]?.id as string;
    unwrap(app.commands.acceptReviewFinding(ui(), { id: f1 }));
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);

    recordFact("2026-09-25T10:00:00.000Z");
    const day2 = claimFreshDaily("2026-09-26T07:00:00.000Z");
    const ev2 = unwrap(app.queries.getReviewEvidence({ id: day2.id })).items[0]?.id as string;
    const f2 = unwrap(
      app.commands.finishReview(sys(), {
        id: day2.id,
        outcome: {
          ok: true,
          result: {
            kind: "findings",
            findings: [{ text: "B", evidenceRefs: [ev2], suggestion: null, patternKey: "doctor-visits" }],
          },
        },
      }),
    ).findings[0]?.id as string;
    unwrap(app.commands.acceptReviewFinding(ui(), { id: f2 }));

    const candidates = unwrap(app.queries.listPatternCandidates({ limit: 20 }));
    expect(candidates).toHaveLength(1);
    unwrap(app.commands.confirmPattern(ui(), { id: candidates[0]?.id as string }));

    const context = unwrap(app.queries.getPlanningContext());
    expect(context.activePlanningRules).toHaveLength(1);

    // Persists across a fresh open of the same file (not just an in-memory artifact of this connection).
    handle.close();
    const reopened = openDesktopDatabase(databaseFile(home));
    const app2 = createApplication({
      store: createSqliteStore(reopened, uuidGenerator),
      clock,
      ids: uuidGenerator,
      timeZone: () => TZ,
    });
    expect(unwrap(app2.queries.getPlanningContext()).activePlanningRules).toHaveLength(1);
    reopened.close();
    handle = openDesktopDatabase(databaseFile(home)); // afterEach expects `handle` to be a live, closable connection
  });

  /**
   * Owner decision (Gate B, second pass): the mechanical learning loop is validated deterministically
   * on this disposable temp-file database rather than by pausing development for days waiting for a
   * second naturally occurring real-life episode. A deterministic test actor stands in for the owner's
   * confirmation clicks — it never claims a real-life judgment was made, only that the mechanism works.
   *
   * The chosen lesson is one that could actually change a future planning decision (not a placeholder
   * observation): two genuinely separate short, interrupted work windows on two different Actions are
   * each too short to make real progress. Their evidence is two different work intervals — disjoint
   * `factIds` by construction, a real independent repetition, not two spellings of one event.
   */
  it("planning-relevant lesson: two independent short-work-window episodes → Pattern candidate → confirm → active rule visible to future planning, without touching CurrentActionSelector", () => {
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
    const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Build" }));
    const actionA = unwrap(
      app.commands.addAction(ui(), { stageId: stage.id, title: "Глубокая задача A", doneWhen: "" }),
    );
    const actionB = unwrap(
      app.commands.addAction(ui(), { stageId: stage.id, title: "Глубокая задача B", doneWhen: "" }),
    );
    const proposal = unwrap(
      app.commands.createRouteProposal(app.newContext("mcp-ai", "test"), {
        intentionId: intention.id,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        summary: "Order",
        rationale: "Order",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [actionA.id, actionB.id],
      }),
    );
    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));

    // Episode A (day 1): a 12-minute window on actionA — too short, and it's what completes the Action.
    clock.set("2026-09-24T09:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId: actionA.id }));
    clock.set("2026-09-24T09:12:00.000Z");
    unwrap(app.commands.completeAction(ui(), { id: actionA.id, expectedVersion: actionA.version }));
    const dayA = claimFreshDaily("2026-09-25T07:00:00.000Z");
    const evA = unwrap(app.queries.getReviewEvidence({ id: dayA.id })).items.find((i) =>
      i.id.startsWith("worksession:"),
    )?.id as string;
    expect(evA).toBeTruthy();
    finishAndAccept(
      dayA.id,
      evA,
      "short-window-misfit",
      "Для «Глубокая задача A» было только 12 минут между делами — начать по-настоящему не успела.",
    );
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);

    // Episode B (day 2, actionB now current since actionA completed): a different, 10-minute window.
    clock.set("2026-09-25T09:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId: actionB.id }));
    clock.set("2026-09-25T09:10:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId: actionB.id }));
    const dayB = claimFreshDaily("2026-09-26T07:00:00.000Z");
    const evB = unwrap(app.queries.getReviewEvidence({ id: dayB.id })).items.find((i) =>
      i.id.startsWith("worksession:"),
    )?.id as string;
    expect(evB).toBeTruthy();
    finishAndAccept(
      dayB.id,
      evB,
      "short-window-misfit",
      "Задачам такого типа стабильно не хватает короткого окна — им нужно больше времени без перерыва.",
    );

    const candidates = unwrap(app.queries.listPatternCandidates({ limit: 20 }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.supportingFindings).toHaveLength(2);
    expect(new Set(candidates[0]?.supportingFindings.map((f) => f.reviewId))).toEqual(new Set([dayA.id, dayB.id]));

    const confirmed = unwrap(app.commands.confirmPattern(ui(), { id: candidates[0]?.id as string }));
    expect(confirmed.text).toBe(
      "Задачам такого типа стабильно не хватает короткого окна — им нужно больше времени без перерыва.",
    );

    const context = unwrap(app.queries.getPlanningContext());
    expect(context.activePlanningRules).toHaveLength(1);
    expect(context.activePlanningRules[0]?.text).toBe(confirmed.text);

    // No second local planner: `computeCurrentAction`/`selectCurrentAction` (packages/domain/src/
    // current-action.ts) take no PlanningRule parameter at all — a structural guarantee, not something
    // one assertion here can prove on its own. This is just a sanity check that confirming the Pattern
    // didn't otherwise disturb the ordered plan's own selection.
    const view = unwrap(app.queries.getCurrentView());
    expect(view.currentAction?.actionId).toBe(actionB.id);

    // Persists across a fresh open of the same file.
    handle.close();
    const reopened = openDesktopDatabase(databaseFile(home));
    const app2 = createApplication({
      store: createSqliteStore(reopened, uuidGenerator),
      clock,
      ids: uuidGenerator,
      timeZone: () => TZ,
    });
    expect(unwrap(app2.queries.getPlanningContext()).activePlanningRules).toHaveLength(1);
    reopened.close();
    handle = openDesktopDatabase(databaseFile(home)); // afterEach expects `handle` to be a live, closable connection
  });

  it("negative counterpart: the same underlying work interval cited by a daily finding and its weekly worktotal aggregate never forms a Pattern candidate on its own", () => {
    recordFact("2026-09-21T09:00:00.000Z"); // any change_log entry before the window so the week isn't empty
    const action = seedAction();

    clock.set("2026-09-24T09:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId: action }));
    clock.set("2026-09-24T09:12:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId: action }));

    const daily = claimFreshDaily("2026-09-25T07:00:00.000Z");
    const dailyRef = unwrap(app.queries.getReviewEvidence({ id: daily.id })).items.find((i) =>
      i.id.startsWith("worksession:"),
    )?.id as string;
    finishAndAccept(daily.id, dailyRef, "short-window-misfit-2", "Короткое окно на этом действии.");

    const weekly = claimFreshOfType("2026-09-28T07:00:00.000Z", "weekly");
    const weeklyRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find((i) =>
      i.id.startsWith("worktotal:"),
    )?.id as string;
    finishAndAccept(weekly.id, weeklyRef, "short-window-misfit-2", "То же самое за неделю.");

    // Same underlying interval, two representations (per-interval vs aggregated) — not independent.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });
});

/** Re-claims an already-existing `needs_ai` Review by id, draining anything else due first. */
function reclaim(id: string): void {
  for (let i = 0; i < 10; i++) {
    const claimed = unwrap(app.commands.claimNextReview(sys()));
    if (!claimed) throw new Error("nothing to claim");
    if (claimed.id === id) return;
    unwrap(
      app.commands.finishReview(sys(), { id: claimed.id, outcome: { ok: true, result: { kind: "no_useful_change" } } }),
    );
  }
  throw new Error(`review ${id} never got reclaimed`);
}

describe("H2: canonical underlying-fact identity (real work/capture/memory data)", () => {
  it("CASE 1/4: a work interval cited directly by a daily finding and aggregated into a weekly worktotal are NOT independent evidence; a genuinely separate interval elsewhere still is", () => {
    const actionId = seedAction();

    // One real work interval, entirely within Friday 2026-09-25.
    clock.set("2026-09-25T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-09-25T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));

    const daily = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const dailyEvidence = unwrap(app.queries.getReviewEvidence({ id: daily.id }));
    const worksessionRef = dailyEvidence.items.find((i) => i.id.startsWith("worksession:"))?.id;
    if (!worksessionRef) throw new Error("expected a worksession evidence item");
    finishAndAccept(daily.id, worksessionRef, "overworked");

    // The same week's weekly Review aggregates that very interval into a `worktotal:` item instead.
    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const weeklyEvidence = unwrap(app.queries.getReviewEvidence({ id: weekly.id }));
    const worktotalRef = weeklyEvidence.items.find((i) => i.id.startsWith("worktotal:"))?.id;
    if (!worktotalRef) throw new Error("expected a worktotal evidence item");
    finishAndAccept(weekly.id, worktotalRef, "overworked");

    // Same underlying work, two different evidence-ref spellings — must not manufacture a pattern.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);

    // Two genuinely separate work intervals, on unrelated days never reviewed above, DO count.
    clock.set("2026-10-02T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-10-02T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));
    const daily2 = claimFreshOfType("2026-10-03T07:00:00.000Z", "daily");
    const ref2 = unwrap(app.queries.getReviewEvidence({ id: daily2.id })).items.find((i) =>
      i.id.startsWith("worksession:"),
    )?.id;
    if (!ref2) throw new Error("expected a worksession evidence item");
    finishAndAccept(daily2.id, ref2, "overworked");

    clock.set("2026-10-05T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-10-05T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));
    const daily3 = claimFreshOfType("2026-10-06T07:00:00.000Z", "daily");
    const ref3 = unwrap(app.queries.getReviewEvidence({ id: daily3.id })).items.find((i) =>
      i.id.startsWith("worksession:"),
    )?.id;
    if (!ref3) throw new Error("expected a worksession evidence item");
    finishAndAccept(daily3.id, ref3, "overworked");

    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(1);
  });

  it("CASE 3: a Capture and a Memory the AI derived from it inside that Capture's own trusted processing job (ctx.captureId) are NOT independent evidence; a genuinely unrelated Capture still is", () => {
    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Приём у врача съел половину дня" }));
    const r1 = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily"); // covers the day c1 was created
    const r1Ref = unwrap(app.queries.getReviewEvidence({ id: r1.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!r1Ref) throw new Error("expected the capture evidence item");
    finishAndAccept(r1.id, r1Ref, "doctor-visits");

    // The AI explicitly derives a Memory from that same Capture inside c1's own processing job
    // (ctx.captureId, exactly like the real CaptureProcessor/MCP child — M-A: this is what makes the
    // link VERIFIED provenance, not just the AI's own say-so), on the civil day this daily Review's
    // own clock is now sitting on (2026-09-26).
    const m1 = unwrap(
      createAiSurface(app, c1.id).saveMemory({
        type: "fact",
        text: "Врач съедает половину дня",
        captureId: null,
        linkedEntityIds: [],
      }),
    );

    const r2 = claimFreshOfType("2026-09-27T07:00:00.000Z", "daily"); // covers the day m1 was created
    const r2Ref = unwrap(app.queries.getReviewEvidence({ id: r2.id })).items.find(
      (i) => i.id === `memory:${m1.id}`,
    )?.id;
    if (!r2Ref) throw new Error("expected the memory evidence item");
    finishAndAccept(r2.id, r2Ref, "doctor-visits");

    // Same lived fact (Capture → its own derived Memory) cited under two different id schemes.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);

    // A genuinely unrelated, undecorated Capture from a later day IS independent evidence.
    const c2 = unwrap(app.commands.createCapture(ui(), { rawText: "Ещё один приём у врача" }));
    const r3 = claimFreshOfType("2026-09-28T07:00:00.000Z", "daily");
    const r3Ref = unwrap(app.queries.getReviewEvidence({ id: r3.id })).items.find(
      (i) => i.id === `capture:${c2.id}`,
    )?.id;
    if (!r3Ref) throw new Error("expected the second capture evidence item");
    finishAndAccept(r3.id, r3Ref, "doctor-visits");

    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(1);
  });

  it("M-A: an AI-supplied captureId from an untethered session (no ctx.captureId — e.g. interactive Desktop-chat, ADR-0004) preserves the Stage-6 association but is NOT verified provenance, so the pair still counts as independent evidence", () => {
    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Приём у врача съел половину дня" }));
    const r1 = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const r1Ref = unwrap(app.queries.getReviewEvidence({ id: r1.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!r1Ref) throw new Error("expected the capture evidence item");
    finishAndAccept(r1.id, r1Ref, "doctor-visits");

    // No ctx.captureId (createAiSurface(app) with no id — exactly what the local MCP entry point gives
    // an interactive session, apps/mcp/src/main.ts, when LIVING_MAP_CAPTURE_ID is unset): only the
    // AI's own claim links this Memory to c1.
    const m1 = unwrap(
      createAiSurface(app).saveMemory({
        type: "fact",
        text: "Врач съедает половину дня",
        captureId: c1.id,
        linkedEntityIds: [],
      }),
    );
    // The Stage-6 association itself is still made — visible to the user under c1.
    expect(unwrap(app.queries.listCaptures({ limit: 5 }))[0]?.memories.map((m) => m.id)).toEqual([m1.id]);

    const r2 = claimFreshOfType("2026-09-27T07:00:00.000Z", "daily");
    const r2Ref = unwrap(app.queries.getReviewEvidence({ id: r2.id })).items.find(
      (i) => i.id === `memory:${m1.id}`,
    )?.id;
    if (!r2Ref) throw new Error("expected the memory evidence item");
    finishAndAccept(r2.id, r2Ref, "doctor-visits");

    // Unverified: the AI's claim alone does not prove same-fact identity, so the pattern engine treats
    // this as real independent evidence rather than silently trusting an unauthenticated assertion.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(1);
  });

  it("M-A: a Memory genuinely created independently of any Capture remains independent evidence", () => {
    const m1 = unwrap(
      createAiSurface(app).saveMemory({
        type: "idea",
        text: "Видео про сон",
        captureId: null,
        linkedEntityIds: [],
      }),
    );
    const r1 = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const r1Ref = unwrap(app.queries.getReviewEvidence({ id: r1.id })).items.find(
      (i) => i.id === `memory:${m1.id}`,
    )?.id;
    if (!r1Ref) throw new Error("expected the memory evidence item");
    finishAndAccept(r1.id, r1Ref, "sleep-videos");

    const m2 = unwrap(
      createAiSurface(app).saveMemory({
        type: "idea",
        text: "Ещё видео про сон",
        captureId: null,
        linkedEntityIds: [],
      }),
    );
    const r2 = claimFreshOfType("2026-09-27T07:00:00.000Z", "daily");
    const r2Ref = unwrap(app.queries.getReviewEvidence({ id: r2.id })).items.find(
      (i) => i.id === `memory:${m2.id}`,
    )?.id;
    if (!r2Ref) throw new Error("expected the second memory evidence item");
    finishAndAccept(r2.id, r2Ref, "sleep-videos");

    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(1);
  });

  it("M-A: verified vs unverified Capture provenance survives a fresh open of the same file", () => {
    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Приём у врача" }));
    const verified = unwrap(
      createAiSurface(app, c1.id).saveMemory({ type: "fact", text: "Врач", captureId: null, linkedEntityIds: [] }),
    );
    const c2 = unwrap(app.commands.createCapture(ui(), { rawText: "Ещё один приём" }));
    const unverified = unwrap(
      createAiSurface(app).saveMemory({ type: "fact", text: "Ещё врач", captureId: c2.id, linkedEntityIds: [] }),
    );

    handle.close();
    const reopened = openDesktopDatabase(databaseFile(home));
    const app2 = createApplication({
      store: createSqliteStore(reopened, uuidGenerator),
      clock,
      ids: uuidGenerator,
      timeZone: () => TZ,
    });
    const row = (id: string) =>
      reopened.sqlite
        .prepare("select source_capture_id, source_capture_verified from memories where id = ?")
        .get(id) as {
        source_capture_id: string | null;
        source_capture_verified: number;
      };
    expect(row(verified.id)).toMatchObject({ source_capture_id: c1.id, source_capture_verified: 1 });
    expect(row(unverified.id)).toMatchObject({ source_capture_id: c2.id, source_capture_verified: 0 });
    reopened.close();
    handle = openDesktopDatabase(databaseFile(home)); // afterEach expects `handle` to be a live, closable connection
    void app2;
  });

  it("CASE 5: retrying a failed Review after a malformed AI result never creates duplicate findings or inflates repetition", () => {
    recordFact("2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily("2026-09-26T07:00:00.000Z");
    const failed = unwrap(
      app.commands.finishReview(sys(), { id: daily.id, outcome: { ok: false, failure: "failed" } }),
    );
    expect(failed).toMatchObject({ status: "failed", findings: [] });

    unwrap(app.commands.retryReview(ui(), { id: daily.id }));
    reclaim(daily.id);
    const evidence = unwrap(app.queries.getReviewEvidence({ id: daily.id }));
    const ref = evidence.items[0]?.id as string;
    finishAndAccept(daily.id, ref, "retry-theme");

    const reread = unwrap(app.queries.getReview({ id: daily.id }));
    // Exactly one finding survives, despite the earlier failed attempt: fail-closed writes nothing,
    // so retrying can never leave two findings citing the same fact behind.
    expect(reread.findings).toHaveLength(1);
  });

  it("M5 persists: «Исправить» with keepPattern:false clears patternKey in the database, not just the command's own returned DTO", () => {
    recordFact("2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily("2026-09-26T07:00:00.000Z");
    const ref = unwrap(app.queries.getReviewEvidence({ id: daily.id })).items[0]?.id as string;
    const finished = unwrap(
      app.commands.finishReview(sys(), {
        id: daily.id,
        outcome: {
          ok: true,
          result: {
            kind: "findings",
            findings: [{ text: "x", evidenceRefs: [ref], suggestion: null, patternKey: "doctor-visits" }],
          },
        },
      }),
    );
    const findingId = finished.findings[0]?.id as string;
    unwrap(
      app.commands.correctReviewFinding(ui(), {
        id: findingId,
        text: "На самом деле дело не в этом",
        keepPattern: false,
      }),
    );

    // Re-read through a fresh query, not the command's own returned DTO — proves it was actually persisted.
    const reread = unwrap(app.queries.getReview({ id: daily.id }));
    expect(reread.findings[0]?.patternKey).toBeNull();

    // A second, independent accepted finding under the SAME key must not form a candidate: the
    // corrected finding's theme was really cleared in the database, not only in memory.
    recordFact("2026-09-26T10:00:00.000Z");
    const daily2 = claimFreshDaily("2026-09-27T07:00:00.000Z");
    const ref2 = unwrap(app.queries.getReviewEvidence({ id: daily2.id })).items[0]?.id as string;
    finishAndAccept(daily2.id, ref2, "doctor-visits");
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });

  it("pairwise-disjoint independence: a daily and a weekly review that both cite the true shared episode fact are NOT independent merely because each ALSO cites something unrelated", () => {
    const actionId = seedAction();

    // Friday: the real episode — one work interval, plus an unrelated Capture cited by the same finding.
    clock.set("2026-09-25T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-09-25T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));
    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Засиделась допоздна" }));

    const daily = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const dailyEvidence = unwrap(app.queries.getReviewEvidence({ id: daily.id }));
    const worksessionRef = dailyEvidence.items.find((i) => i.id.startsWith("worksession:"))?.id;
    const captureRef = dailyEvidence.items.find((i) => i.id === `capture:${c1.id}`)?.id;
    if (!worksessionRef || !captureRef) throw new Error("expected worksession and capture evidence items");
    finishAndAcceptRefs(daily.id, [worksessionRef, captureRef], "late-work");

    // Saturday, same week: an ordinary, unrelated interval on the same action.
    clock.set("2026-09-26T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-09-26T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));

    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const worktotalRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find((i) =>
      i.id.startsWith("worktotal:"),
    )?.id;
    if (!worktotalRef) throw new Error("expected a worktotal evidence item");
    finishAndAccept(weekly.id, worktotalRef, "late-work");

    // The daily's "unique" fact (the Capture) and the weekly's "unique" fact (Saturday's interval,
    // folded into the same-action worktotal aggregate) are both irrelevant to the real shared episode
    // (Friday's interval) — neither review is truly independent of the other's core fact.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });

  it("Capture → Proposal provenance: a Capture and the route Proposal explicitly created from it are NOT independent evidence; an unrelated Proposal still is", () => {
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
    const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Build" }));
    const action = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "Work", doneWhen: "" }));

    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Перестрой порядок, я закончила этап." }));
    // `linkProposal` only links while the Capture is actually mid-processing (`processing`/`failed`),
    // matching the real AI-run lifecycle (ADR-0007) — claim it first, like the real capture queue would.
    unwrap(app.commands.claimNextCapture(sys()));
    const aiCtxFromCapture = { ...app.newContext("mcp-ai", "test"), captureId: c1.id };
    const proposal = unwrap(
      app.commands.createRouteProposal(aiCtxFromCapture, {
        intentionId: intention.id,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        summary: "Order",
        rationale: "Order",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [action.id],
      }),
    );

    const r1 = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily"); // covers the day c1 was created
    const r1Ref = unwrap(app.queries.getReviewEvidence({ id: r1.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!r1Ref) throw new Error("expected the capture evidence item");
    finishAndAccept(r1.id, r1Ref, "route-changes");

    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id })); // resolves today (2026-09-26)

    const r2 = claimFreshOfType("2026-09-27T07:00:00.000Z", "daily"); // covers the day the proposal resolved
    const r2Ref = unwrap(app.queries.getReviewEvidence({ id: r2.id })).items.find(
      (i) => i.id === `proposal:${proposal.id}`,
    )?.id;
    if (!r2Ref) throw new Error("expected the proposal evidence item");
    finishAndAccept(r2.id, r2Ref, "route-changes");

    // Same lived episode (Capture → the route Proposal it produced) cited under two id schemes.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);

    // An unrelated Proposal (no Capture behind it) resolved on a later day IS independent evidence.
    const proposal2 = unwrap(
      app.commands.createRouteProposal(app.newContext("mcp-ai", "test"), {
        intentionId: intention.id,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        summary: "Order 2",
        rationale: "Order 2",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [action.id],
      }),
    );
    unwrap(app.commands.acceptProposal(ui(), { id: proposal2.id }));
    const r3 = claimFreshOfType("2026-09-28T07:00:00.000Z", "daily");
    const r3Ref = unwrap(app.queries.getReviewEvidence({ id: r3.id })).items.find(
      (i) => i.id === `proposal:${proposal2.id}`,
    )?.id;
    if (!r3Ref) throw new Error("expected the second proposal evidence item");
    finishAndAccept(r3.id, r3Ref, "route-changes");

    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(1);
  });
});

/** Current version of an Action, for `completeAction`'s optimistic-concurrency check. */
function versionOf(id: string): number {
  const action = unwrap(app.queries.getCurrentView())
    .stages.flatMap((s) => s.actions)
    .find((a) => a.id === id);
  if (!action) throw new Error("no action");
  return action.version;
}

describe("5th-pass fixes: fresh independent post-4th-pass review found the invariant still breakable", () => {
  it("H-B fix: a pre-H2 row with empty evidenceFactIds (unknown provenance) is never treated as independent from a real fact", () => {
    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Один и тот же эпизод" }));
    const daily = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const dailyRef = unwrap(app.queries.getReviewEvidence({ id: daily.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!dailyRef) throw new Error("expected the capture evidence item");
    finishAndAccept(daily.id, dailyRef, "one-episode");

    // Simulate a row written before migration 0014 (DEFAULT '[]') — conservative, not fabricated, but an
    // empty set must never "prove" independence from anything else.
    handle.sqlite.prepare("update review_findings set evidence_fact_ids = '[]'").run();

    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const weeklyRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!weeklyRef) throw new Error("expected the same capture evidence item in the weekly pack");
    finishAndAccept(weekly.id, weeklyRef, "one-episode");

    // Same underlying Capture cited by both; the daily's row now (artificially) has zero known facts —
    // that must not read as "disjoint from everything", or this becomes a false single-episode pattern.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });

  it("H-C fix: a rejected Pattern is not resurrected by a Review that only re-cites an already-rejected fact under a new reviewId", () => {
    clock.set("2026-09-21T10:00:00.000Z"); // Monday, same week as B below
    const cA = unwrap(app.commands.createCapture(ui(), { rawText: "Приём А" }));
    const rA = claimFreshOfType("2026-09-22T07:00:00.000Z", "daily");
    const refA = unwrap(app.queries.getReviewEvidence({ id: rA.id })).items.find(
      (i) => i.id === `capture:${cA.id}`,
    )?.id;
    if (!refA) throw new Error("expected capture A evidence item");
    finishAndAccept(rA.id, refA, "doctor-visits");

    clock.set("2026-09-24T10:00:00.000Z"); // Thursday, same week
    const cB = unwrap(app.commands.createCapture(ui(), { rawText: "Приём Б" }));
    const rB = claimFreshOfType("2026-09-25T07:00:00.000Z", "daily");
    const refB = unwrap(app.queries.getReviewEvidence({ id: rB.id })).items.find(
      (i) => i.id === `capture:${cB.id}`,
    )?.id;
    if (!refB) throw new Error("expected capture B evidence item");
    finishAndAccept(rB.id, refB, "doctor-visits");

    const candidates = unwrap(app.queries.listPatternCandidates({ limit: 20 }));
    expect(candidates).toHaveLength(1);
    unwrap(app.commands.rejectPattern(ui(), { id: candidates[0]?.id as string }));

    // The same week's weekly Review re-cites the EXACT SAME fact (capture B) that was already part of
    // the rejected evidence — a new reviewId, zero new lived facts.
    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const weeklyRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find(
      (i) => i.id === `capture:${cB.id}`,
    )?.id;
    if (!weeklyRef) throw new Error("expected capture B evidence item in the weekly pack");
    finishAndAccept(weekly.id, weeklyRef, "doctor-visits");

    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });

  it("H-A fix: a Capture and the plan.reorder its own AI run performed are NOT independent evidence", () => {
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
    const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Build" }));
    const a1 = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "A1", doneWhen: "" }));
    const a2 = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "A2", doneWhen: "" }));
    const proposal = unwrap(
      app.commands.createRouteProposal(app.newContext("mcp-ai", "test"), {
        intentionId: intention.id,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        summary: "Order",
        rationale: "Order",
        newStages: [],
        stageEdits: [],
        newActions: [],
        actionEdits: [],
        actionOrder: [a1.id, a2.id],
      }),
    );
    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
    const plan = unwrap(app.queries.getPlanningContext()).orderedActionPlan;
    if (!plan) throw new Error("expected an approved plan");

    const c1 = unwrap(app.commands.createCapture(ui(), { rawText: "Сначала A2 — перестрой порядок" }));
    unwrap(app.commands.claimNextCapture(sys()));
    const aiCtxFromCapture = { ...app.newContext("mcp-ai", "test"), captureId: c1.id };
    unwrap(
      app.commands.reorderExistingActions(aiCtxFromCapture, {
        intentionId: intention.id,
        expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
        expectedPlanVersion: plan.version,
        orderedActionIds: [a2.id, a1.id],
        rationale: "Новость из записи меняет порядок",
      }),
    );

    const daily = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily"); // covers the day c1/reorder happened
    const captureRef = unwrap(app.queries.getReviewEvidence({ id: daily.id })).items.find(
      (i) => i.id === `capture:${c1.id}`,
    )?.id;
    if (!captureRef) throw new Error("expected the capture evidence item");
    finishAndAccept(daily.id, captureRef, "replanning");

    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const reorderRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find(
      (i) => i.id.startsWith("changelog:") && i.text.includes("plan.reorder"),
    )?.id;
    if (!reorderRef) throw new Error("expected the plan.reorder changelog evidence item");
    finishAndAccept(weekly.id, reorderRef, "replanning");

    // Same lived episode (the Capture and the reorder its own AI run performed) under two unrelated ids.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });

  it("M-B fix: completing an Action and its own work interval (worked on it, then pressed «Готово») are NOT independent evidence", () => {
    const actionId = seedAction();

    clock.set("2026-09-25T08:00:00.000Z");
    unwrap(app.commands.startWork(ui(), { actionId }));
    clock.set("2026-09-25T08:02:00.000Z");
    unwrap(app.commands.pauseWork(ui(), { actionId }));
    unwrap(app.commands.completeAction(ui(), { id: actionId, expectedVersion: versionOf(actionId) }));

    const daily = claimFreshOfType("2026-09-26T07:00:00.000Z", "daily");
    const actionRef = unwrap(app.queries.getReviewEvidence({ id: daily.id })).items.find(
      (i) => i.id === `action:${actionId}`,
    )?.id;
    if (!actionRef) throw new Error("expected the action-completed evidence item");
    finishAndAccept(daily.id, actionRef, "tasks-overrun");

    const weekly = claimFreshOfType("2026-09-29T07:00:00.000Z", "weekly");
    const worktotalRef = unwrap(app.queries.getReviewEvidence({ id: weekly.id })).items.find((i) =>
      i.id.startsWith("worktotal:"),
    )?.id;
    if (!worktotalRef) throw new Error("expected a worktotal evidence item");
    finishAndAccept(weekly.id, worktotalRef, "tasks-overrun");

    // Same lived episode (doing the work, then finishing it) under `action:`/`worktotal:` respectively.
    expect(unwrap(app.queries.listPatternCandidates({ limit: 20 }))).toHaveLength(0);
  });
});
