import { describe, expect, it } from "vitest";
import { createSeason, rewordSeason, SEASON_FOCUS_MAX, SEASON_WHY_MAX, startNewSeason } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";
const T2 = "2026-12-01T10:00:00.000Z";

describe("Season", () => {
  it("is created at version 1 with trimmed focus, started now, with an empty why", () => {
    const r = createSeason({ id: "s1", focus: "  build the thing  ", now: T0 });
    expect(r).toEqual({
      ok: true,
      value: {
        id: "s1",
        focus: "build the thing",
        whyItMatters: "",
        startedAt: T0,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    });
  });

  it("rejects empty and oversized focus / why", () => {
    expect(createSeason({ id: "s1", focus: "   ", now: T0 }).ok).toBe(false);
    expect(createSeason({ id: "s1", focus: "x".repeat(SEASON_FOCUS_MAX + 1), now: T0 }).ok).toBe(false);
    expect(createSeason({ id: "s1", focus: "a", whyItMatters: "x".repeat(SEASON_WHY_MAX + 1), now: T0 }).ok).toBe(
      false,
    );
  });

  it("MODE A reword bumps version and updatedAt only: the season keeps its start and identity", () => {
    const created = createSeason({ id: "s1", focus: "a", whyItMatters: "потому что", now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const updated = rewordSeason(created.value, { focus: "b" }, T1);
    expect(updated).toEqual({
      ok: true,
      value: {
        id: "s1",
        focus: "b",
        whyItMatters: "потому что", // undefined keeps the sentence
        startedAt: T0,
        version: 2,
        createdAt: T0,
        updatedAt: T1,
      },
    });
    expect(rewordSeason(created.value, { focus: "b", whyItMatters: "" }, T1)).toMatchObject({
      ok: true,
      value: { whyItMatters: "" },
    });
  });

  it("MODE B startNewSeason archives the ending season and restarts the same row from now", () => {
    const created = createSeason({ id: "s1", focus: "старая цель", whyItMatters: "старое почему", now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const turned = startNewSeason(created.value, { focus: "  новая цель ", historyId: "h1" }, T2);
    expect(turned).toEqual({
      ok: true,
      value: {
        season: {
          id: "s1",
          focus: "новая цель",
          whyItMatters: "",
          startedAt: T2,
          version: 2,
          createdAt: T0,
          updatedAt: T2,
        },
        ended: { id: "h1", focus: "старая цель", whyItMatters: "старое почему", startedAt: T0, endedAt: T2 },
      },
    });
    expect(startNewSeason(created.value, { focus: " ", historyId: "h1" }, T2).ok).toBe(false);
  });
});
