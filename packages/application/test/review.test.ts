import type { Instant } from "@living-map/domain";
import { describe, expect, it } from "vitest";
import { type Clock, createApplication } from "../src";
import { memoryStore, sequentialIds } from "./fakes";

function mutableClock(initial: Instant): Clock & { set: (now: Instant) => void } {
  let now = initial;
  return {
    now: () => now,
    set: (n) => {
      now = n;
    },
  };
}

const TZ = "Europe/Moscow";

function setup(initialNow: Instant = "2026-09-25T10:00:00.000Z") {
  const clock = mutableClock(initialNow);
  const store = memoryStore();
  const app = createApplication({ store, clock, ids: sequentialIds(), timeZone: () => TZ });
  return { app, store, clock, ui: app.newContext("user-ui", "test"), system: app.newContext("system", "test") };
}

type App = ReturnType<typeof setup>["app"];

/**
 * One real, repeatable changelog fact (creates the Season once, then edits its focus each time
 * after). Always a freshly created context — `ctx.timestamp` is fixed at creation, so reusing one
 * across simulated clock jumps would misdate the fact (real callers create a fresh context per
 * command too, e.g. `ipc.ts`'s `const ui = () => app.newContext(...)`).
 */
function recordFact(app: App, clock: ReturnType<typeof mutableClock>, at: Instant): void {
  clock.set(at);
  const ui = app.newContext("user-ui", "test");
  const season = app.queries.getSeason();
  if (season.ok && season.value) {
    app.commands.updateSeasonFocus(ui, {
      expectedVersion: season.value.version,
      focus: `focus @ ${at}`,
      startsNewSeason: false,
    });
  } else {
    app.commands.createSeason(ui, { focus: `focus @ ${at}` });
  }
}

describe("Review scheduler", () => {
  it("creates one Review per currently due period and is idempotent on a second run", () => {
    const { app, system } = setup();
    const first = app.commands.scheduleDueReviews(system, { timeZone: TZ });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toBeGreaterThan(0); // at least the first-ever daily/weekly/yearly periods

    const listed = app.queries.listReviews({ limit: 50 });
    if (!listed.ok) throw new Error("expected ok");
    const countAfterFirst = listed.value.length;

    const second = app.commands.scheduleDueReviews(system, { timeZone: TZ });
    expect(second).toMatchObject({ ok: true, value: 0 });
    const listedAgain = app.queries.listReviews({ limit: 50 });
    if (!listedAgain.ok) throw new Error("expected ok");
    expect(listedAgain.value.length).toBe(countAfterFirst);
  });

  it("mcp-ai has no policy entry for scheduling, processing, resolving findings, or patterns/rules", () => {
    const { app } = setup();
    const ai = app.newContext("mcp-ai", "test");
    expect(app.commands.scheduleDueReviews(ai, { timeZone: TZ })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.claimNextReview(ai)).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(app.commands.finishReview(ai, { id: "x", outcome: { ok: false, failure: "failed" } })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.acceptReviewFinding(ai, { id: "x" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.confirmPattern(ai, { id: "x" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.deactivatePlanningRule(ai, { id: "x" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
});

/**
 * Rolls the clock forward, schedules, and claims the freshest due Review of `type` — draining any
 * other queued type first, exactly like the real single-flight queue would.
 */
function claimFreshDueOfType(
  app: App,
  clock: ReturnType<typeof mutableClock>,
  rollTo: Instant,
  type: "daily" | "weekly",
) {
  clock.set(rollTo);
  app.commands.scheduleDueReviews(app.newContext("system", "test"), { timeZone: TZ });
  const reviews = app.queries.listReviews({ limit: 50 });
  if (!reviews.ok) throw new Error("expected ok");
  // Newest due period of this type: an earlier call for a different type can leave an older, now-stale
  // due period of THIS type sitting unclaimed too (e.g. a first-ever weekly period computed before the
  // clock advanced further) — the freshest one is always the one relevant to where the clock is now.
  const due = reviews.value
    .filter((r) => r.type === type && r.status === "needs_ai")
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
  if (!due) throw new Error(`no due ${type} review`);
  for (let i = 0; i < 20; i++) {
    const claimed = app.commands.claimNextReview(app.newContext("system", "test"));
    if (!claimed.ok || !claimed.value) throw new Error(`could not claim the due ${type} review`);
    if (claimed.value.id === due.id) return due;
    app.commands.finishReview(app.newContext("system", "test"), {
      id: claimed.value.id,
      outcome: { ok: true, result: { kind: "no_useful_change" } },
    });
  }
  throw new Error(`${type} review never got claimed`);
}

function claimFreshDaily(app: App, clock: ReturnType<typeof mutableClock>, rollTo: Instant) {
  return claimFreshDueOfType(app, clock, rollTo, "daily");
}

describe("Review processing", () => {
  it("full flow: claim → real evidence → finding created and readable", () => {
    const { app, clock, system } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");

    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    expect(evidence).toMatchObject({ ok: true });
    if (!evidence.ok) throw new Error("expected ok");
    expect(evidence.value.items.length).toBeGreaterThan(0);
    const evId = evidence.value.items[0]?.id as string;

    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "Тест находка", evidenceRefs: [evId], suggestion: null, patternKey: null }],
        },
      },
    });
    expect(finished).toMatchObject({
      ok: true,
      value: { status: "ready", findings: [{ text: "Тест находка", status: "proposed", evidenceRefs: [evId] }] },
    });
  });

  it("rejects a fabricated evidence reference: the whole result fails, no finding is written", () => {
    const { app, clock, system } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");

    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "x", evidenceRefs: ["fabricated:does-not-exist"], suggestion: null, patternKey: null }],
        },
      },
    });
    expect(finished).toMatchObject({ ok: true, value: { status: "failed", lastError: "malformed", findings: [] } });
  });

  it("no_useful_change needs no owner ritual", () => {
    const { app, clock, system } = setup("2026-09-25T08:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: { ok: true, result: { kind: "no_useful_change" } },
    });
    expect(finished).toMatchObject({ ok: true, value: { status: "no_useful_change", findings: [] } });
  });

  it("AI unavailable: Review survives as failed with a vendor-neutral code, and «Повторить» requeues it", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const failed = app.commands.finishReview(system, {
      id: daily.id,
      outcome: { ok: false, failure: "not_installed" },
    });
    expect(failed).toMatchObject({ ok: true, value: { status: "failed", lastError: "not_installed" } });

    const retried = app.commands.retryReview(ui, { id: daily.id });
    expect(retried).toMatchObject({ ok: true, value: { status: "needs_ai" } });
    // Not permanently blocked by the earlier failure: it can be claimed again.
    expect(app.commands.claimNextReview(system)).toMatchObject({
      ok: true,
      value: { id: daily.id, status: "processing" },
    });
  });

  it("recoverReviews requeues an interrupted `processing` row at launch, like the Capture queue", () => {
    const { app, clock, system } = setup("2026-09-25T08:00:00.000Z");
    claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z"); // left "processing", simulating a crash mid-run
    const recovered = app.commands.recoverReviews(system);
    expect(recovered).toMatchObject({ ok: true, value: 1 });
    const reviews = app.queries.listReviews({ limit: 50 });
    if (!reviews.ok) throw new Error("expected ok");
    expect(reviews.value.find((r) => r.type === "daily")?.status).toBe("needs_ai");
  });
});

/** Produces, processes and accepts one finding with `patternKey` for the currently due daily period. */
function processAndAcceptFinding(
  app: App,
  clock: ReturnType<typeof mutableClock>,
  factAt: Instant,
  rollTo: Instant,
  patternKey: string | null,
): { findingId: string } {
  recordFact(app, clock, factAt);
  const daily = claimFreshDaily(app, clock, rollTo);
  const evidence = app.queries.getReviewEvidence({ id: daily.id });
  if (!evidence.ok) throw new Error("expected ok");
  const evId = evidence.value.items[0]?.id as string;
  const finished = app.commands.finishReview(app.newContext("system", "test"), {
    id: daily.id,
    outcome: {
      ok: true,
      result: {
        kind: "findings",
        findings: [{ text: `Находка ${factAt}`, evidenceRefs: [evId], suggestion: null, patternKey }],
      },
    },
  });
  if (!finished.ok) throw new Error(finished.error.message);
  const findingId = finished.value.findings[0]?.id;
  if (!findingId) throw new Error("no finding created");
  const accepted = app.commands.acceptReviewFinding(app.newContext("user-ui", "test"), { id: findingId });
  if (!accepted.ok) throw new Error(accepted.error.message);
  return { findingId };
}

describe("ReviewFinding confirmation", () => {
  it("«Всё верно» accepts the AI's own draft, and cannot be resolved twice", () => {
    const { app, clock, ui } = setup("2026-09-25T08:00:00.000Z");
    const { findingId } = processAndAcceptFinding(
      app,
      clock,
      "2026-09-25T10:00:00.000Z",
      "2026-09-26T07:00:00.000Z",
      null,
    );
    expect(app.commands.acceptReviewFinding(ui, { id: findingId })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("a correction becomes the accepted learning; the AI draft text is kept auditable", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const evId = evidence.value.items[0]?.id as string;
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "Черновик ИИ", evidenceRefs: [evId], suggestion: null, patternKey: null }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    const findingId = finished.value.findings[0]?.id as string;
    const corrected = app.commands.correctReviewFinding(ui, {
      id: findingId,
      text: "На самом деле дело не в этом",
      keepPattern: false,
    });
    expect(corrected).toMatchObject({
      ok: true,
      value: { status: "corrected", text: "Черновик ИИ", correctedText: "На самом деле дело не в этом" },
    });
  });

  it("«Игнорировать» rejects and excludes it from Pattern evidence", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const evId = evidence.value.items[0]?.id as string;
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "x", evidenceRefs: [evId], suggestion: null, patternKey: null }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    const findingId = finished.value.findings[0]?.id as string;
    expect(app.commands.rejectReviewFinding(ui, { id: findingId })).toMatchObject({
      ok: true,
      value: { status: "rejected" },
    });
    // Rejected: never counted, even alone — listAcceptedByPatternKey only ever sees accepted/corrected.
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
  });
});

describe("Pattern pipeline", () => {
  it("a single episode never becomes a candidate, even with two accepted findings in the same review", () => {
    const { app, clock, system, ui } = setup("2026-09-24T08:00:00.000Z");
    recordFact(app, clock, "2026-09-24T09:00:00.000Z");
    recordFact(app, clock, "2026-09-24T09:30:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-25T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok || evidence.value.items.length < 2) throw new Error("need 2 evidence items");
    const e1 = evidence.value.items[0] as { id: string };
    const e2 = evidence.value.items[1] as { id: string };
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [
            { text: "A", evidenceRefs: [e1.id], suggestion: null, patternKey: "doctor-visits" },
            { text: "B", evidenceRefs: [e2.id], suggestion: null, patternKey: "doctor-visits" },
          ],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    for (const f of finished.value.findings) app.commands.acceptReviewFinding(ui, { id: f.id });
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
  });

  it("two accepted findings from distinct review periods surface a candidate; confirming activates a rule visible to planning", () => {
    const { app, clock, ui } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });

    processAndAcceptFinding(app, clock, "2026-09-25T10:00:00.000Z", "2026-09-26T07:00:00.000Z", "doctor-visits");
    const candidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!candidates.ok) throw new Error("expected ok");
    expect(candidates.value).toHaveLength(1);
    const candidate = candidates.value[0];
    if (!candidate) throw new Error("no candidate");
    expect(candidate.evidenceFindingIds).toHaveLength(2);

    const confirmed = app.commands.confirmPattern(ui, { id: candidate.id });
    expect(confirmed).toMatchObject({ ok: true, value: { status: "confirmed" } });
    expect(app.commands.confirmPattern(ui, { id: candidate.id })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });

    const rules = app.queries.listPlanningRules({ limit: 20 });
    if (!rules.ok) throw new Error("expected ok");
    expect(rules.value).toMatchObject([{ status: "active", sourcePatternId: candidate.id }]);

    const context = app.queries.getPlanningContext();
    if (!context.ok) throw new Error("expected ok");
    expect(context.value.activePlanningRules).toHaveLength(1);

    const ruleId = rules.value[0]?.id as string;
    const deactivated = app.commands.deactivatePlanningRule(ui, { id: ruleId });
    expect(deactivated).toMatchObject({ ok: true, value: { status: "inactive" } });
    const contextAfter = app.queries.getPlanningContext();
    if (!contextAfter.ok) throw new Error("expected ok");
    expect(contextAfter.value.activePlanningRules).toHaveLength(0);
    expect(app.commands.deactivatePlanningRule(ui, { id: ruleId })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("rejecting a candidate creates no rule, and the same evidence does not immediately recreate it", () => {
    const { app, clock, ui } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    processAndAcceptFinding(app, clock, "2026-09-25T10:00:00.000Z", "2026-09-26T07:00:00.000Z", "doctor-visits");
    const candidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!candidates.ok) throw new Error("expected ok");
    const candidate = candidates.value[0];
    if (!candidate) throw new Error("no candidate");

    const rejected = app.commands.rejectPattern(ui, { id: candidate.id });
    expect(rejected).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(app.queries.listPlanningRules({ limit: 20 })).toMatchObject({ ok: true, value: [] });
    // No fresh evidence arrived: the same set must not resurface as a new candidate.
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
  });

  it("two distinct Reviews citing the exact same underlying fact (overlapping periods) never count as 2 independent episodes", () => {
    const { app, clock, system, ui } = setup("2026-09-23T08:00:00.000Z");
    // One real fact on Wednesday 2026-09-23 — inside both that day's daily period and that week's weekly period.
    recordFact(app, clock, "2026-09-23T10:00:00.000Z");

    const daily = claimFreshDueOfType(app, clock, "2026-09-24T07:00:00.000Z", "daily");
    const dailyEvidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!dailyEvidence.ok) throw new Error("expected ok");
    const sharedEvId = dailyEvidence.value.items[0]?.id as string;
    const dailyFinished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "A", evidenceRefs: [sharedEvId], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!dailyFinished.ok) throw new Error(dailyFinished.error.message);
    app.commands.acceptReviewFinding(ui, { id: dailyFinished.value.findings[0]?.id as string });

    // Same week: the weekly period covering 2026-09-21..2026-09-28 contains the very same Wednesday fact.
    const weekly = claimFreshDueOfType(app, clock, "2026-09-28T07:00:00.000Z", "weekly");
    const weeklyEvidence = app.queries.getReviewEvidence({ id: weekly.id });
    if (!weeklyEvidence.ok) throw new Error("expected ok");
    expect(weeklyEvidence.value.items.some((i) => i.id === sharedEvId)).toBe(true); // proves the overlap is real
    const weeklyFinished = app.commands.finishReview(system, {
      id: weekly.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "B", evidenceRefs: [sharedEvId], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!weeklyFinished.ok) throw new Error(weeklyFinished.error.message);
    app.commands.acceptReviewFinding(ui, { id: weeklyFinished.value.findings[0]?.id as string });

    // 2 distinct reviewIds, but the exact same one underlying fact cited by both — not independent evidence.
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
  });

  it("2 distinct reviewIds and 2 distinct refs are still not enough when neither Review contributes anything the other doesn't also cite", () => {
    const { app, clock, system, ui } = setup("2026-09-23T08:00:00.000Z");
    // Two real facts on the same Wednesday — both land in that day's daily period AND that week's weekly period.
    recordFact(app, clock, "2026-09-23T09:00:00.000Z");
    recordFact(app, clock, "2026-09-23T10:00:00.000Z");

    const daily = claimFreshDueOfType(app, clock, "2026-09-24T07:00:00.000Z", "daily");
    const dailyEvidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!dailyEvidence.ok) throw new Error("expected ok");
    const [ev1, ev2] = dailyEvidence.value.items.map((i) => i.id) as [string, string];
    const dailyFinished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "A", evidenceRefs: [ev1, ev2], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!dailyFinished.ok) throw new Error(dailyFinished.error.message);
    app.commands.acceptReviewFinding(ui, { id: dailyFinished.value.findings[0]?.id as string });

    // The weekly finding cites the very same 2 facts, unchanged — old check saw "2 distinct reviewIds"
    // AND "2 distinct refs in the union" and wrongly passed; neither Review actually contributes
    // anything independent of the other.
    const weekly = claimFreshDueOfType(app, clock, "2026-09-28T07:00:00.000Z", "weekly");
    const weeklyFinished = app.commands.finishReview(system, {
      id: weekly.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "B", evidenceRefs: [ev1, ev2], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!weeklyFinished.ok) throw new Error(weeklyFinished.error.message);
    app.commands.acceptReviewFinding(ui, { id: weeklyFinished.value.findings[0]?.id as string });

    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
  });

  it("a rejected theme resurfaces once a genuinely new FACT contributes evidence, even from a sibling finding in an already-counted Review (H-C fix: the guard is per-fact, not per-Review)", () => {
    const { app, clock, system, ui } = setup("2026-09-23T08:00:00.000Z");
    // Day 1 (Review R1) has 2 facts; only one finding is accepted at first, the other stays proposed.
    recordFact(app, clock, "2026-09-23T09:00:00.000Z");
    recordFact(app, clock, "2026-09-23T10:00:00.000Z");
    const r1 = claimFreshDueOfType(app, clock, "2026-09-24T07:00:00.000Z", "daily");
    const r1Evidence = app.queries.getReviewEvidence({ id: r1.id });
    if (!r1Evidence.ok) throw new Error("expected ok");
    const [ev1, ev2] = r1Evidence.value.items.map((i) => i.id) as [string, string];
    const r1Finished = app.commands.finishReview(system, {
      id: r1.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [
            { text: "A", evidenceRefs: [ev1], suggestion: null, patternKey: "doctor-visits" },
            { text: "A2", evidenceRefs: [ev2], suggestion: null, patternKey: "doctor-visits" },
          ],
        },
      },
    });
    if (!r1Finished.ok) throw new Error(r1Finished.error.message);
    const findingA = r1Finished.value.findings[0]?.id as string;
    const findingA2 = r1Finished.value.findings[1]?.id as string;
    app.commands.acceptReviewFinding(ui, { id: findingA }); // A2 stays "proposed" for now

    // Day 2 (Review R2): a genuinely independent episode — the candidate surfaces and is rejected.
    recordFact(app, clock, "2026-09-24T10:00:00.000Z");
    const r2 = claimFreshDueOfType(app, clock, "2026-09-25T07:00:00.000Z", "daily");
    const r2Evidence = app.queries.getReviewEvidence({ id: r2.id });
    if (!r2Evidence.ok) throw new Error("expected ok");
    const ev3 = r2Evidence.value.items[0]?.id as string;
    const r2Finished = app.commands.finishReview(system, {
      id: r2.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "B", evidenceRefs: [ev3], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!r2Finished.ok) throw new Error(r2Finished.error.message);
    app.commands.acceptReviewFinding(ui, { id: r2Finished.value.findings[0]?.id as string });
    const candidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!candidates.ok) throw new Error("expected ok");
    const candidateId = candidates.value[0]?.id as string;
    app.commands.rejectPattern(ui, { id: candidateId });

    // Accepting A2 cites ev2 — a genuinely different real fact from ev1, never part of the rejected
    // decision (only ev1+ev3 were rejected), even though A2 happens to share R1's reviewId with the
    // already-counted A. The guard must key off which FACTS were rejected, not which Review ids were
    // involved — R1's real underlying facts here are {ev1, ev2}, and ev2 was never evaluated before.
    app.commands.acceptReviewFinding(ui, { id: findingA2 });
    const resurfaced = app.queries.listPatternCandidates({ limit: 20 });
    if (!resurfaced.ok) throw new Error("expected ok");
    expect(resurfaced.value).toMatchObject([{ status: "candidate" }]);
    app.commands.rejectPattern(ui, { id: resurfaced.value[0]?.id as string });

    // Day 3 (Review R3): a genuinely new, independent Review — this must be allowed to resurface it.
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const r3 = claimFreshDueOfType(app, clock, "2026-09-26T07:00:00.000Z", "daily");
    const r3Evidence = app.queries.getReviewEvidence({ id: r3.id });
    if (!r3Evidence.ok) throw new Error("expected ok");
    const ev4 = r3Evidence.value.items[0]?.id as string;
    const r3Finished = app.commands.finishReview(system, {
      id: r3.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "C", evidenceRefs: [ev4], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!r3Finished.ok) throw new Error(r3Finished.error.message);
    app.commands.acceptReviewFinding(ui, { id: r3Finished.value.findings[0]?.id as string });
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({
      ok: true,
      value: [{ status: "candidate" }],
    });
  });

  it("a growing candidate absorbs new matching evidence instead of duplicating; a confirmed theme stays confirmed", () => {
    const { app, clock, ui } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    processAndAcceptFinding(app, clock, "2026-09-25T10:00:00.000Z", "2026-09-26T07:00:00.000Z", "doctor-visits");
    const firstCandidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!firstCandidates.ok) throw new Error("expected ok");
    expect(firstCandidates.value).toHaveLength(1);
    const candidateId = firstCandidates.value[0]?.id;

    // A third matching finding grows the SAME candidate row rather than creating a second one.
    processAndAcceptFinding(app, clock, "2026-09-26T10:00:00.000Z", "2026-09-27T07:00:00.000Z", "doctor-visits");
    const afterThird = app.queries.listPatternCandidates({ limit: 20 });
    if (!afterThird.ok) throw new Error("expected ok");
    expect(afterThird.value).toHaveLength(1);
    expect(afterThird.value[0]?.id).toBe(candidateId);
    expect(afterThird.value[0]?.evidenceFindingIds).toHaveLength(3);

    // Confirming it, then a fourth matching finding must not spawn a second candidate/rule for the same theme.
    app.commands.confirmPattern(ui, { id: candidateId as string });
    processAndAcceptFinding(app, clock, "2026-09-27T10:00:00.000Z", "2026-09-28T07:00:00.000Z", "doctor-visits");
    expect(app.queries.listPatternCandidates({ limit: 20 })).toMatchObject({ ok: true, value: [] });
    const rules = app.queries.listPlanningRules({ limit: 20 });
    if (!rules.ok) throw new Error("expected ok");
    expect(rules.value).toHaveLength(1); // still exactly the one rule from confirming, no duplicate
  });

  it("evidence beyond a rejected pattern's own set does justify a fresh candidate", () => {
    const { app, clock, ui } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    processAndAcceptFinding(app, clock, "2026-09-25T10:00:00.000Z", "2026-09-26T07:00:00.000Z", "doctor-visits");
    const candidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!candidates.ok) throw new Error("expected ok");
    const candidateId = candidates.value[0]?.id as string;
    app.commands.rejectPattern(ui, { id: candidateId });

    // Genuinely new evidence beyond what was rejected: a fresh candidate is legitimate.
    processAndAcceptFinding(app, clock, "2026-09-26T10:00:00.000Z", "2026-09-27T07:00:00.000Z", "doctor-visits");
    const after = app.queries.listPatternCandidates({ limit: 20 });
    if (!after.ok) throw new Error("expected ok");
    expect(after.value).toHaveLength(1);
    expect(after.value[0]?.id).not.toBe(candidateId);
  });
});

describe("Review evidence: known pattern themes and self-referential bookkeeping", () => {
  it("passes existing accepted patternKey themes forward so the AI can reuse the exact slug", () => {
    const { app, clock } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    expect(evidence.value.knownPatternThemes).toMatchObject([{ patternKey: "doctor-visits" }]);
  });

  it("never cites Stage 7's own bookkeeping (review/pattern/rule/work events) as evidence of a life fact", () => {
    const { app, clock, system } = setup("2026-09-24T08:00:00.000Z");
    recordFact(app, clock, "2026-09-24T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-25T07:00:00.000Z");
    // Finish it (creating review.processed/reviewFinding.* bookkeeping in the change log) before reading
    // the NEXT day's evidence, to prove that bookkeeping never leaks into a later period's evidence pack.
    const evidence1 = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence1.ok) throw new Error("expected ok");
    app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [
            { text: "x", evidenceRefs: [evidence1.value.items[0]?.id as string], suggestion: null, patternKey: null },
          ],
        },
      },
    });

    const daily2 = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence2 = app.queries.getReviewEvidence({ id: daily2.id });
    if (!evidence2.ok) throw new Error("expected ok");
    for (const item of evidence2.value.items) {
      expect(item.text).not.toMatch(/review\.|reviewFinding\.|pattern\.|planningRule\./);
    }
  });
});

describe("reviewInbox badge", () => {
  it("counts a ready Review only while it still has an unresolved finding; clears once resolved", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const evId = evidence.value.items[0]?.id as string;
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "x", evidenceRefs: [evId], suggestion: null, patternKey: null }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);

    const before = app.queries.getCurrentView();
    if (!before.ok) throw new Error("expected ok");
    expect(before.value.reviewInbox.readyReviews).toBe(1);

    const findingId = finished.value.findings[0]?.id as string;
    app.commands.acceptReviewFinding(ui, { id: findingId });

    const after = app.queries.getCurrentView();
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.reviewInbox.readyReviews).toBe(0);
  });
});

describe("Season boundary vs wording edit (M2)", () => {
  it("a plain focus edit (startsNewSeason: false, the schema default) never closes a seasonal-Review boundary by itself", () => {
    const { app, clock } = setup("2026-09-01T08:00:00.000Z");
    const created = app.commands.createSeason(app.newContext("user-ui", "test"), { focus: "Строим фундамент" });
    if (!created.ok) throw new Error(created.error.message);
    clock.set("2026-09-10T08:00:00.000Z");
    // A fresh context per command (like `recordFact` above): `ctx.timestamp` is fixed at creation, so
    // reusing one across these simulated clock jumps would misdate the fact, same as a real caller
    // creating a fresh IPC context per command.
    const wording = app.commands.updateSeasonFocus(app.newContext("user-ui", "test"), {
      expectedVersion: created.value.version,
      focus: "Строим фундамент (уточнено)",
      startsNewSeason: false,
    });
    if (!wording.ok) throw new Error(wording.error.message);

    clock.set("2026-09-20T08:00:00.000Z");
    const scheduled = app.commands.scheduleDueReviews(app.newContext("system", "test"), { timeZone: TZ });
    if (!scheduled.ok) throw new Error(scheduled.error.message);
    const reviews = app.queries.listReviews({ limit: 50 });
    if (!reviews.ok) throw new Error("expected ok");
    // The season is still open (no boundary yet): there is nothing to close, so no seasonal Review exists.
    expect(reviews.value.filter((r) => r.type === "seasonal")).toHaveLength(0);
  });

  it("startsNewSeason: true is the boundary the seasonal Review scheduler actually reacts to", () => {
    const { app, clock } = setup("2026-09-01T08:00:00.000Z");
    const created = app.commands.createSeason(app.newContext("user-ui", "test"), { focus: "Строим фундамент" });
    if (!created.ok) throw new Error(created.error.message);

    clock.set("2026-09-10T08:00:00.000Z");
    // A wording edit in between still must not count as the boundary.
    const wording = app.commands.updateSeasonFocus(app.newContext("user-ui", "test"), {
      expectedVersion: created.value.version,
      focus: "Строим фундамент (уточнено)",
      startsNewSeason: false,
    });
    if (!wording.ok) throw new Error(wording.error.message);

    clock.set("2026-09-15T08:00:00.000Z");
    const changed = app.commands.updateSeasonFocus(app.newContext("user-ui", "test"), {
      expectedVersion: wording.value.version,
      focus: "Запускаем продукт",
      startsNewSeason: true,
    });
    if (!changed.ok) throw new Error(changed.error.message);

    clock.set("2026-09-20T08:00:00.000Z");
    const scheduled = app.commands.scheduleDueReviews(app.newContext("system", "test"), { timeZone: TZ });
    if (!scheduled.ok) throw new Error(scheduled.error.message);
    const reviews = app.queries.listReviews({ limit: 50 });
    if (!reviews.ok) throw new Error("expected ok");
    // Exactly one closed interval exists: season.create → season.changeSeason. The still-open second
    // season (after the change) is not due — there is no second boundary yet to close it.
    expect(reviews.value.filter((r) => r.type === "seasonal")).toHaveLength(1);
  });
});

describe("Evidence visibility (M4)", () => {
  it("a finding exposes the human-readable facts behind its evidenceRefs, not just a count", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const item = evidence.value.items[0] as { id: string; text: string };
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "x", evidenceRefs: [item.id], suggestion: null, patternKey: null }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    expect(finished.value.findings[0]?.evidenceItems).toEqual([{ id: item.id, text: item.text }]);

    // Re-read through getReview (the UI's own read path) sees the same evidence text, not a dangling ref.
    const reread = app.queries.getReview({ id: daily.id });
    if (!reread.ok) throw new Error("expected ok");
    expect(reread.value.findings[0]?.evidenceItems).toEqual([{ id: item.id, text: item.text }]);

    const findingId = finished.value.findings[0]?.id as string;
    app.commands.acceptReviewFinding(ui, { id: findingId });
  });

  it("a Pattern candidate exposes each supporting finding's own text and evidence, not just evidenceFindingIds", () => {
    const { app, clock } = setup("2026-09-24T08:00:00.000Z");
    processAndAcceptFinding(app, clock, "2026-09-24T10:00:00.000Z", "2026-09-25T07:00:00.000Z", "doctor-visits");
    processAndAcceptFinding(app, clock, "2026-09-25T10:00:00.000Z", "2026-09-26T07:00:00.000Z", "doctor-visits");
    const candidates = app.queries.listPatternCandidates({ limit: 20 });
    if (!candidates.ok) throw new Error("expected ok");
    const candidate = candidates.value[0];
    if (!candidate) throw new Error("no candidate");
    expect(candidate.supportingFindings).toHaveLength(2);
    for (const f of candidate.supportingFindings) {
      expect(f.text.length).toBeGreaterThan(0);
      expect(f.evidenceItems.length).toBeGreaterThan(0);
      expect(f.evidenceItems[0]?.text.length).toBeGreaterThan(0);
    }
  });
});

describe("Correction semantics (M5)", () => {
  it("keepPattern: true (explicit owner signal) preserves the AI's theme through the correctReviewFinding command", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const evId = evidence.value.items[0]?.id as string;
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "Черновик ИИ", evidenceRefs: [evId], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    const findingId = finished.value.findings[0]?.id as string;

    const corrected = app.commands.correctReviewFinding(ui, {
      id: findingId,
      text: "Черновик ИИ, чуть точнее сформулировано",
      keepPattern: true,
    });
    expect(corrected).toMatchObject({ ok: true, value: { status: "corrected", patternKey: "doctor-visits" } });
  });

  it("keepPattern: false (the conservative default, M5) drops the theme through the same command", () => {
    const { app, clock, system, ui } = setup("2026-09-25T08:00:00.000Z");
    recordFact(app, clock, "2026-09-25T10:00:00.000Z");
    const daily = claimFreshDaily(app, clock, "2026-09-26T07:00:00.000Z");
    const evidence = app.queries.getReviewEvidence({ id: daily.id });
    if (!evidence.ok) throw new Error("expected ok");
    const evId = evidence.value.items[0]?.id as string;
    const finished = app.commands.finishReview(system, {
      id: daily.id,
      outcome: {
        ok: true,
        result: {
          kind: "findings",
          findings: [{ text: "Черновик ИИ", evidenceRefs: [evId], suggestion: null, patternKey: "doctor-visits" }],
        },
      },
    });
    if (!finished.ok) throw new Error(finished.error.message);
    const findingId = finished.value.findings[0]?.id as string;

    const corrected = app.commands.correctReviewFinding(ui, {
      id: findingId,
      text: "На самом деле дело не в этом",
      keepPattern: false,
    });
    expect(corrected).toMatchObject({ ok: true, value: { status: "corrected", patternKey: null } });
  });
});
