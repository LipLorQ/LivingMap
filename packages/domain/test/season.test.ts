import { describe, expect, it } from "vitest";
import { createSeason, SEASON_FOCUS_MAX, updateSeasonFocus } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

describe("Season", () => {
  it("is created at version 1 with trimmed focus", () => {
    const r = createSeason({ id: "s1", focus: "  build the thing  ", now: T0 });
    expect(r).toEqual({
      ok: true,
      value: { id: "s1", focus: "build the thing", version: 1, createdAt: T0, updatedAt: T0 },
    });
  });

  it("rejects empty and oversized focus", () => {
    expect(createSeason({ id: "s1", focus: "   ", now: T0 }).ok).toBe(false);
    expect(createSeason({ id: "s1", focus: "x".repeat(SEASON_FOCUS_MAX + 1), now: T0 }).ok).toBe(false);
  });

  it("updateSeasonFocus bumps version and updatedAt only", () => {
    const created = createSeason({ id: "s1", focus: "a", now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const updated = updateSeasonFocus(created.value, "b", T1);
    expect(updated).toEqual({ ok: true, value: { id: "s1", focus: "b", version: 2, createdAt: T0, updatedAt: T1 } });
  });
});
