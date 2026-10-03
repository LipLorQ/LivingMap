import { describe, expect, it } from "vitest";
import {
  computeCourseImpact,
  createDecadeItem,
  createHorizon,
  createIntention,
  createSeason,
  createYearDirection,
  currentYearOf,
  evidenceForYears,
  evidenceSince,
  type Intention,
  impactFingerprint,
  type ProjectSnapshot,
  projectProgress,
  type Season,
  type SeasonHistoryEntry,
  type StrategyState,
  seasonProgress,
} from "../src";

const T0 = "2026-10-01T10:00:00.000Z";

function intention(id: string, patch: Partial<Intention> = {}): Intention {
  const r = createIntention({ id, title: `Проект ${id}`, desiredResult: "", whyItMatters: "", position: 1, now: T0 });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.value, ...patch };
}

function snapshot(id: string, patch: Partial<Intention> = {}, stageCount = 2, unfinished = 5): ProjectSnapshot {
  return { intention: intention(id, patch), stageCount, unfinishedActionCount: unfinished };
}

function fullState(over: Partial<StrategyState> = {}): StrategyState {
  const d20 = createDecadeItem({
    id: "d20",
    startYear: 2020,
    endYear: 2029,
    statement: "Строить",
    others: [],
    now: T0,
  });
  const d40 = createDecadeItem({
    id: "d40",
    startYear: 2040,
    endYear: 2049,
    statement: "Передать",
    others: [],
    now: T0,
  });
  const horizon = createHorizon({ id: "h", startYear: 2026, direction: "Запуск", whyItMatters: "", now: T0 });
  const year = createYearDirection({ id: "y", year: 2026, direction: "MVP", whyItMatters: "", now: T0 });
  const season = createSeason({ id: "s", focus: "Рабочая карта", now: T0 });
  if (!d20.ok || !d40.ok || !horizon.ok || !year.ok || !season.ok) throw new Error("fixture");
  return {
    decadePlan: [d20.value, d40.value],
    horizon: horizon.value,
    year: year.value,
    season: season.value,
    projects: [snapshot("p1"), snapshot("p2")],
    currentYear: 2026,
    ...over,
  };
}

const kinds = (items: { kind: string }[]) => items.map((i) => i.kind);

describe("course impact: what a change of course may touch", () => {
  it("a year change touches the season and the projects, nothing above it", () => {
    expect(kinds(computeCourseImpact(fullState(), "year", "y"))).toEqual(["season", "project", "project"]);
  });

  it("a 3-year change also touches the year", () => {
    expect(kinds(computeCourseImpact(fullState(), "horizon", "h"))).toEqual(["year", "season", "project", "project"]);
  });

  it("a season change touches only the projects", () => {
    expect(kinds(computeCourseImpact(fullState(), "season", "s"))).toEqual(["project", "project"]);
  });

  it("a decade in the current chain touches everything below it; a far decade touches nothing", () => {
    expect(kinds(computeCourseImpact(fullState(), "decade", "d20"))).toEqual([
      "horizon",
      "year",
      "season",
      "project",
      "project",
    ]);
    expect(computeCourseImpact(fullState(), "decade", "d40")).toEqual([]);
    expect(computeCourseImpact(fullState(), "decade", "missing")).toEqual([]);
    // `null` = the decade layer as a whole (a removed statement): everything below it.
    expect(kinds(computeCourseImpact(fullState(), "decade", null))).toEqual([
      "horizon",
      "year",
      "season",
      "project",
      "project",
    ]);
  });

  it("a decade moving INTO the current chain matters even though its old years were far away (review M1)", () => {
    const state = fullState();
    expect(computeCourseImpact(state, "decade", "d40")).toEqual([]);
    expect(kinds(computeCourseImpact(state, "decade", "d40", { startYear: 2025, endYear: 2034 }))).toEqual([
      "horizon",
      "year",
      "season",
      "project",
      "project",
    ]);
    // and one moving OUT of the chain still counts (its old years were in it)
    expect(kinds(computeCourseImpact(state, "decade", "d20", { startYear: 2040, endYear: 2049 }))).toEqual([
      "horizon",
      "year",
      "season",
      "project",
      "project",
    ]);
  });

  it("skips layers that do not exist yet (partially populated map)", () => {
    const sparse = fullState({ horizon: null, year: null, season: null, projects: [] });
    expect(computeCourseImpact(sparse, "decade", "d20")).toEqual([]); // 2026 chain year ∈ 2020s, but nothing below exists
    expect(computeCourseImpact(fullState({ year: null }), "horizon", "h").map((i) => i.kind)).toEqual([
      "season",
      "project",
      "project",
    ]);
  });

  it("only open projects can be affected; completed and released ones are history", () => {
    const state = fullState({
      projects: [
        snapshot("a", { status: "active" }),
        snapshot("b", { status: "deferred" }),
        snapshot("c", { status: "completed", closedAt: T0 }),
        snapshot("d", { status: "released", closedAt: T0 }),
      ],
    });
    expect(computeCourseImpact(state, "season", "s").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("a decade outside the chain years does not touch lower layers even when they exist", () => {
    const state = fullState({ decadePlan: [], horizon: null });
    // chain years fall back to the year direction (2026): a 2030s decade is not part of it.
    const d30 = createDecadeItem({ id: "d30", startYear: 2030, endYear: 2039, statement: "x", others: [], now: T0 });
    if (!d30.ok) throw new Error("fixture");
    expect(computeCourseImpact({ ...state, decadePlan: [d30.value] }, "decade", "d30")).toEqual([]);
  });

  it("the impact is described, never rewritten: items carry labels and counts only", () => {
    const items = computeCourseImpact(fullState(), "season", "s");
    expect(items[0]).toMatchObject({ kind: "project", label: "Проект p1", stageCount: 2, unfinishedActionCount: 5 });
  });
});

describe("impact fingerprint", () => {
  it("is stable for the same impact and changes when anything below moves", () => {
    const a = computeCourseImpact(fullState(), "season", "s");
    expect(impactFingerprint(a)).toBe(impactFingerprint(computeCourseImpact(fullState(), "season", "s")));
    const moved = computeCourseImpact(
      fullState({ projects: [snapshot("p1", {}, 2, 4), snapshot("p2")] }),
      "season",
      "s",
    );
    expect(impactFingerprint(moved)).not.toBe(impactFingerprint(a));
    const bumped = computeCourseImpact(
      fullState({ projects: [snapshot("p1", { version: 2 }), snapshot("p2")] }),
      "season",
      "s",
    );
    expect(impactFingerprint(bumped)).not.toBe(impactFingerprint(a));
  });

  it("is the empty string when nothing is affected", () => {
    expect(impactFingerprint([])).toBe("");
  });
});

describe("honest progress", () => {
  it("counts explicit stages and actions; no percentage exists in the result", () => {
    const progress = projectProgress(
      [
        { position: 2, isCurrent: true },
        { position: 1, isCurrent: false },
        { position: 3, isCurrent: false },
      ],
      [{ status: "done" }, { status: "done" }, { status: "open" }, { status: "blocked" }],
    );
    expect(progress).toEqual({ stageIndex: 2, stageCount: 3, actionsDone: 2, actionsTotal: 4 });
    expect(Object.keys(progress).some((k) => /percent|ratio|score/i.test(k))).toBe(false);
  });

  it("has no stage index without a current stage and no fake denominators for an empty project", () => {
    expect(projectProgress([], [])).toEqual({ stageIndex: null, stageCount: 0, actionsDone: 0, actionsTotal: 0 });
    expect(projectProgress([{ position: 1, isCurrent: false }], [])).toMatchObject({ stageIndex: null, stageCount: 1 });
  });

  const season = (): Season => {
    const r = createSeason({ id: "s", focus: "f", now: "2026-09-01T00:00:00.000Z" });
    if (!r.ok) throw new Error("fixture");
    return r.value;
  };

  it("season progress is completed-of-explicit-projects; released ones are not finished work", () => {
    const projects = [
      intention("a", { status: "completed", closedAt: "2026-09-10T00:00:00.000Z" }),
      intention("b", { status: "active" }),
      intention("c", { status: "deferred" }),
      intention("d", { status: "released", closedAt: "2026-09-12T00:00:00.000Z" }),
      intention("old", { status: "completed", closedAt: "2026-08-01T00:00:00.000Z" }), // before this season
    ];
    expect(seasonProgress(season(), projects)).toEqual({ completed: 1, total: 3 });
  });

  it("is null when the season has no projects — nothing to count, nothing invented", () => {
    expect(seasonProgress(season(), [])).toBeNull();
    expect(
      seasonProgress(season(), [intention("d", { status: "released", closedAt: "2026-09-12T00:00:00.000Z" })]),
    ).toBeNull();
  });
});

describe("real evidence", () => {
  const completed = (id: string, closedAt: string) => intention(id, { status: "completed", closedAt });
  const past: SeasonHistoryEntry[] = [
    {
      id: "ps1",
      focus: "Старый сезон",
      whyItMatters: "",
      startedAt: "2025-01-01T00:00:00.000Z",
      endedAt: "2025-12-20T00:00:00.000Z",
    },
  ];

  it("lists only completed projects since the season began, oldest first", () => {
    const items = evidenceSince("2026-09-01T00:00:00.000Z", [
      completed("b", "2026-09-20T00:00:00.000Z"),
      completed("a", "2026-09-05T00:00:00.000Z"),
      completed("old", "2026-08-30T00:00:00.000Z"),
      intention("open", { status: "active" }),
      intention("gone", { status: "released", closedAt: "2026-09-06T00:00:00.000Z" }),
    ]);
    expect(items.map((i) => i.text)).toEqual(["Проект a", "Проект b"]);
    expect(items.every((i) => i.kind === "project_completed")).toBe(true);
  });

  it("collects completed projects and closed seasons that fall inside a year range, in local time", () => {
    const items = evidenceForYears({ startYear: 2025, endYear: 2026 }, "UTC", {
      intentions: [completed("x", "2026-03-01T00:00:00.000Z"), completed("far", "2031-03-01T00:00:00.000Z")],
      pastSeasons: past,
    });
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["season_closed", "Старый сезон"],
      ["project_completed", "Проект x"],
    ]);
  });

  it("attributes an instant to the local year of the owner's zone, not UTC", () => {
    // 2026-12-31 20:00 UTC is already 2027-01-01 in Novosibirsk (UTC+7).
    const at = "2026-12-31T20:00:00.000Z";
    expect(currentYearOf(at, "UTC")).toBe(2026);
    expect(currentYearOf(at, "Asia/Novosibirsk")).toBe(2027);
    const items = evidenceForYears({ startYear: 2027, endYear: 2027 }, "Asia/Novosibirsk", {
      intentions: [completed("ny", at)],
      pastSeasons: [],
    });
    expect(items).toHaveLength(1);
  });

  it("is empty when nothing real happened — never a placeholder", () => {
    expect(evidenceSince(T0, [])).toEqual([]);
    expect(evidenceForYears({ startYear: 2026, endYear: 2028 }, "UTC", { intentions: [], pastSeasons: [] })).toEqual(
      [],
    );
  });
});
