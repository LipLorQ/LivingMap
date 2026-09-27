import { describe, expect, it } from "vitest";
import { createIntention, editIntention, INTENTION_TITLE_MAX } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

describe("Intention", () => {
  it("is created at version 1 with trimmed title; desiredResult may start empty", () => {
    const r = createIntention({ id: "i1", title: "  ship the MVP  ", desiredResult: "", now: T0 });
    expect(r).toEqual({
      ok: true,
      value: { id: "i1", title: "ship the MVP", desiredResult: "", version: 1, createdAt: T0, updatedAt: T0 },
    });
  });

  it("rejects an empty or oversized title", () => {
    expect(createIntention({ id: "i1", title: " ", desiredResult: "", now: T0 }).ok).toBe(false);
    expect(
      createIntention({ id: "i1", title: "x".repeat(INTENTION_TITLE_MAX + 1), desiredResult: "", now: T0 }).ok,
    ).toBe(false);
  });

  it("editIntention updates title and desiredResult together, bumping version", () => {
    const created = createIntention({ id: "i1", title: "a", desiredResult: "", now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const edited = editIntention(created.value, { title: "b", desiredResult: "users can log in" }, T1);
    expect(edited).toEqual({
      ok: true,
      value: {
        id: "i1",
        title: "b",
        desiredResult: "users can log in",
        version: 2,
        createdAt: T0,
        updatedAt: T1,
      },
    });
  });
});
