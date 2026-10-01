import { describe, expect, it } from "vitest";
import {
  acceptedFindingText,
  acceptFinding,
  correctFinding,
  createReview,
  createReviewFinding,
  dueDailyPeriods,
  dueWeeklyPeriods,
  dueYearlyPeriods,
  rejectFinding,
} from "../src";

const TZ = "Europe/Moscow";
const last = (periodEnd: string, timeZone = TZ) => ({ periodEnd, timeZone });

describe("createReview", () => {
  it("rejects an empty or inverted period", () => {
    expect(createReview({ id: "r", type: "daily", periodStart: "t", periodEnd: "t", timeZone: TZ, now: "t" }).ok).toBe(
      false,
    );
  });

  it("starts needs_ai with zero attempts", () => {
    const r = createReview({
      id: "r",
      type: "daily",
      periodStart: "2026-09-28T00:00:00.000Z",
      periodEnd: "2026-09-29T00:00:00.000Z",
      timeZone: TZ,
      now: "2026-09-29T06:00:00.000Z",
    });
    expect(r).toMatchObject({ ok: true, value: { status: "needs_ai", attempts: 0, lastError: null } });
  });
});

describe("due calendar periods", () => {
  // "Now" is Monday 2026-09-28 10:00 Moscow (local date 2026-09-28).
  const now = "2026-09-28T07:00:00.000Z";

  it("first-ever daily review: only yesterday is due, never today", () => {
    const periods = dueDailyPeriods(null, now, TZ);
    expect(periods).toEqual([{ periodStart: "2026-09-26T21:00:00.000Z", periodEnd: "2026-09-27T21:00:00.000Z" }]);
  });

  it("daily catch-up resumes right after the last processed period and stops before today", () => {
    const periods = dueDailyPeriods(last("2026-09-24T21:00:00.000Z"), now, TZ);
    expect(periods.map((p) => p.periodStart)).toEqual([
      "2026-09-24T21:00:00.000Z",
      "2026-09-25T21:00:00.000Z",
      "2026-09-26T21:00:00.000Z",
    ]);
    expect(periods.at(-1)?.periodEnd).toBe("2026-09-27T21:00:00.000Z");
  });

  it("daily catch-up is bounded and leaves the rest for next launch", () => {
    const periods = dueDailyPeriods(last("2020-01-01T00:00:00.000Z"), now, TZ, 3);
    expect(periods).toHaveLength(3);
  });

  it("a changed system timezone does not reopen or duplicate the previous period (westward: zone moves behind)", () => {
    // The previous daily period was computed in Tokyo and ended at its own local midnight; the app's
    // current zone is now New York. Reinterpreting that boundary in New York (a ~14h shift) must never
    // produce a period that starts before the Tokyo period already ended.
    const tokyoPeriodEnd = "2026-09-27T15:00:00.000Z"; // 2026-09-28 00:00 Asia/Tokyo
    const periods = dueDailyPeriods(last(tokyoPeriodEnd, "Asia/Tokyo"), "2026-09-29T06:00:00.000Z", "America/New_York");
    expect(periods).toHaveLength(1); // exactly the one day between the two boundaries, never more
    expect(periods[0]?.periodStart).toBe(tokyoPeriodEnd); // resumes exactly where the old period ended, no gap either
  });

  it("a changed system timezone does not reopen or duplicate the previous period (eastward: zone moves ahead)", () => {
    // The previous daily period was computed in New York and ended at its own local midnight; the app's
    // current zone is now Tokyo, which is AHEAD of New York. Re-anchoring the same civil date at local
    // midnight in Tokyo lands BEFORE the New York boundary already reached — exactly the overlap this
    // must prevent (regression: an earlier version of this function did exactly that).
    const nyPeriodEnd = "2026-09-28T04:00:00.000Z"; // 2026-09-28 00:00 America/New_York
    const periods = dueDailyPeriods(last(nyPeriodEnd, "America/New_York"), "2026-09-29T06:00:00.000Z", "Asia/Tokyo");
    expect(periods.length).toBeGreaterThan(0);
    expect(periods[0]?.periodStart).toBe(nyPeriodEnd); // resumes exactly where the old period ended, never before it
  });

  it("first-ever weekly review: only last week is due, never the running week", () => {
    const periods = dueWeeklyPeriods(null, now, TZ);
    // This week starts Monday 2026-09-28; last week starts Monday 2026-09-21.
    expect(periods).toEqual([{ periodStart: "2026-09-20T21:00:00.000Z", periodEnd: "2026-09-27T21:00:00.000Z" }]);
  });

  it("first-ever yearly review: only last year is due", () => {
    const periods = dueYearlyPeriods(null, now, TZ);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.periodStart).toBe("2024-12-31T21:00:00.000Z"); // 2025-01-01 00:00 Moscow
    expect(periods[0]?.periodEnd).toBe("2025-12-31T21:00:00.000Z"); // 2026-01-01 00:00 Moscow
  });

  it("never returns the still-running current period", () => {
    // Right after a period ended, that same instant should not itself be due again next call.
    const lastEnd = dueDailyPeriods(null, now, TZ)[0]?.periodEnd as string;
    expect(dueDailyPeriods(last(lastEnd), lastEnd, TZ)).toEqual([]);
  });
});

describe("ReviewFinding lifecycle", () => {
  const base = () =>
    createReviewFinding({
      id: "f1",
      reviewId: "r1",
      text: "Фактическая ёмкость дня была меньше плановой из-за приёма у врача.",
      evidenceRefs: ["action:a1", "action:a1"],
      evidenceFactIds: ["action:a1"],
      suggestion: null,
      patternKey: null,
      now: "t0",
    });

  it("de-duplicates evidence refs and rejects an empty evidence list", () => {
    const r = base();
    expect(r).toMatchObject({ ok: true, value: { evidenceRefs: ["action:a1"], status: "proposed" } });
    expect(
      createReviewFinding({
        id: "f",
        reviewId: "r",
        text: "x",
        evidenceRefs: [],
        evidenceFactIds: [],
        suggestion: null,
        patternKey: null,
        now: "t",
      }).ok,
    ).toBe(false);
  });

  it("«Всё верно»: accept keeps the AI's own text as the accepted learning", () => {
    const created = base();
    if (!created.ok) throw new Error("setup");
    const accepted = acceptFinding(created.value, "t1");
    expect(accepted).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(accepted.ok && acceptedFindingText(accepted.value)).toBe(created.value.text);
  });

  it("a correction becomes the accepted learning; the AI draft is kept untouched", () => {
    const created = base();
    if (!created.ok) throw new Error("setup");
    const corrected = correctFinding(created.value, "На самом деле дело было не во враче.", false, "t1");
    expect(corrected).toMatchObject({ ok: true, value: { status: "corrected", text: created.value.text } });
    expect(corrected.ok && acceptedFindingText(corrected.value)).toBe("На самом деле дело было не во враче.");
  });

  it("a substantive correction (keepPattern: false, the default) drops the AI's own theme: the AI's read of the substance was wrong, so it must not keep counting toward that theme (M5)", () => {
    const withTheme = createReviewFinding({
      id: "f2",
      reviewId: "r1",
      text: "Похоже, приёмы у врача мешают.",
      evidenceRefs: ["action:a1"],
      evidenceFactIds: ["action:a1"],
      suggestion: null,
      patternKey: "doctor-visits",
      now: "t0",
    });
    if (!withTheme.ok) throw new Error("setup");
    const corrected = correctFinding(withTheme.value, "На самом деле дело не в этом.", false, "t1");
    expect(corrected).toMatchObject({ ok: true, value: { status: "corrected", patternKey: null } });
  });

  it("a wording-only correction (keepPattern: true, an explicit owner signal) keeps the AI's theme association (M5)", () => {
    const withTheme = createReviewFinding({
      id: "f3",
      reviewId: "r1",
      text: "Похоже, приёмы у врача мешают.",
      evidenceRefs: ["action:a1"],
      evidenceFactIds: ["action:a1"],
      suggestion: null,
      patternKey: "doctor-visits",
      now: "t0",
    });
    if (!withTheme.ok) throw new Error("setup");
    const corrected = correctFinding(withTheme.value, "Похоже, визиты к врачу мешают работе.", true, "t1");
    expect(corrected).toMatchObject({ ok: true, value: { status: "corrected", patternKey: "doctor-visits" } });
  });

  it("a rejected finding has no accepted text and cannot be resolved twice", () => {
    const created = base();
    if (!created.ok) throw new Error("setup");
    const rejected = rejectFinding(created.value, "t1");
    expect(rejected).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(rejected.ok && acceptedFindingText(rejected.value)).toBeNull();
    expect(rejected.ok && acceptFinding(rejected.value, "t2").ok).toBe(false);
  });
});
