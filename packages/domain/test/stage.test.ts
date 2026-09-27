import { describe, expect, it } from "vitest";
import { createStage, editStageTitle, isCurrentStageUnambiguous } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

describe("Stage", () => {
  it("is created at version 1 with the given position and current flag", () => {
    const r = createStage({
      id: "st1",
      intentionId: "i1",
      title: "  research  ",
      position: 1,
      isCurrent: true,
      now: T0,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        id: "st1",
        intentionId: "i1",
        title: "research",
        position: 1,
        isCurrent: true,
        createdAt: T0,
        updatedAt: T0,
        version: 1,
      },
    });
  });

  it("rejects an empty title", () => {
    expect(createStage({ id: "st1", intentionId: "i1", title: " ", position: 1, isCurrent: false, now: T0 }).ok).toBe(
      false,
    );
  });

  it("editStageTitle bumps version, keeps position and isCurrent", () => {
    const created = createStage({ id: "st1", intentionId: "i1", title: "a", position: 2, isCurrent: false, now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const edited = editStageTitle(created.value, "b", T1);
    expect(edited).toEqual({
      ok: true,
      value: {
        id: "st1",
        intentionId: "i1",
        title: "b",
        position: 2,
        isCurrent: false,
        version: 2,
        createdAt: T0,
        updatedAt: T1,
      },
    });
  });

  describe("isCurrentStageUnambiguous", () => {
    it("holds with zero or one current stage", () => {
      const a = createStage({ id: "a", intentionId: "i1", title: "a", position: 1, isCurrent: false, now: T0 });
      const b = createStage({ id: "b", intentionId: "i1", title: "b", position: 2, isCurrent: true, now: T0 });
      if (!a.ok || !b.ok) throw new Error("unreachable");
      expect(isCurrentStageUnambiguous([])).toBe(true);
      expect(isCurrentStageUnambiguous([a.value, b.value])).toBe(true);
    });

    it("fails with two current stages", () => {
      const a = createStage({ id: "a", intentionId: "i1", title: "a", position: 1, isCurrent: true, now: T0 });
      const b = createStage({ id: "b", intentionId: "i1", title: "b", position: 2, isCurrent: true, now: T0 });
      if (!a.ok || !b.ok) throw new Error("unreachable");
      expect(isCurrentStageUnambiguous([a.value, b.value])).toBe(false);
    });
  });
});
