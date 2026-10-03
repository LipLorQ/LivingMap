import { describe, expect, it } from "vitest";
import {
  activeIntentions,
  changeIntentionStatus,
  createIntention,
  editIntention,
  hasRoomForActive,
  INTENTION_TITLE_MAX,
  INTENTION_WHY_MAX,
  type Intention,
  MAX_ACTIVE_INTENTIONS,
  nextActivePosition,
} from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

function make(id: string, position: number, patch: Partial<Intention> = {}): Intention {
  const r = createIntention({ id, title: id, desiredResult: "", position, now: T0 });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.value, ...patch };
}

describe("Intention", () => {
  it("is created active at version 1 with trimmed title; desiredResult may start empty", () => {
    const r = createIntention({ id: "i1", title: "  ship the MVP  ", desiredResult: "", position: 1, now: T0 });
    expect(r).toEqual({
      ok: true,
      value: {
        id: "i1",
        title: "ship the MVP",
        desiredResult: "",
        whyItMatters: "",
        status: "active",
        position: 1,
        closedAt: null,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    });
  });

  it("rejects an empty or oversized title and an oversized why", () => {
    expect(createIntention({ id: "i1", title: " ", desiredResult: "", position: 1, now: T0 }).ok).toBe(false);
    expect(
      createIntention({ id: "i1", title: "x".repeat(INTENTION_TITLE_MAX + 1), desiredResult: "", position: 1, now: T0 })
        .ok,
    ).toBe(false);
    expect(
      createIntention({
        id: "i1",
        title: "a",
        desiredResult: "",
        whyItMatters: "x".repeat(INTENTION_WHY_MAX + 1),
        position: 1,
        now: T0,
      }).ok,
    ).toBe(false);
  });

  it("editIntention updates title and desiredResult together, bumping version, keeping the why", () => {
    const created = createIntention({
      id: "i1",
      title: "a",
      desiredResult: "",
      whyItMatters: "служит сезону",
      position: 1,
      now: T0,
    });
    if (!created.ok) throw new Error("unreachable");
    const edited = editIntention(created.value, { title: "b", desiredResult: "users can log in" }, T1);
    expect(edited).toEqual({
      ok: true,
      value: {
        ...created.value,
        title: "b",
        desiredResult: "users can log in",
        whyItMatters: "служит сезону",
        version: 2,
        updatedAt: T1,
      },
    });
    expect(editIntention(created.value, { title: "a", desiredResult: "", whyItMatters: "" }, T1)).toMatchObject({
      ok: true,
      value: { whyItMatters: "" },
    });
  });
});

describe("active project limit", () => {
  it(`allows at most ${MAX_ACTIVE_INTENTIONS} active projects at once`, () => {
    const three = [make("a", 1), make("b", 2), make("c", 3)];
    expect(hasRoomForActive(three.slice(0, 2))).toBe(true);
    expect(hasRoomForActive(three)).toBe(false);
  });

  it("completed, released and deferred projects do not count as active", () => {
    const list = [
      make("a", 1),
      make("b", 2),
      make("done", 3, { status: "completed", closedAt: T0 }),
      make("gone", 4, { status: "released", closedAt: T0 }),
      make("paused", 5, { status: "deferred" }),
    ];
    expect(hasRoomForActive(list)).toBe(true);
    expect(activeIntentions(list).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("refuses a fourth activation with a typed limit result, and the list stays untouched", () => {
    const list = [make("a", 1), make("b", 2), make("c", 3), make("paused", 4, { status: "deferred" })];
    const r = changeIntentionStatus(list, "paused", "active", T1);
    expect(r).toMatchObject({ ok: false, limit: true });
    expect(list[3]?.status).toBe("deferred");
  });

  it("lets a project continue once one of the three is completed, released or deferred", () => {
    for (const to of ["completed", "released", "deferred"] as const) {
      const base = [make("a", 1), make("b", 2), make("c", 3), make("paused", 4, { status: "deferred" })];
      const freed = changeIntentionStatus(base, "a", to, T1);
      if (!freed.ok) throw new Error(freed.reason);
      const after = base.map((i) => (i.id === "a" ? freed.value : i));
      const resumed = changeIntentionStatus(after, "paused", "active", T1);
      expect(resumed).toMatchObject({ ok: true, value: { status: "active", position: 4 } });
    }
  });

  it("re-activating an already active project is not a limit problem", () => {
    const three = [make("a", 1), make("b", 2), make("c", 3)];
    expect(changeIntentionStatus(three, "a", "active", T1)).toMatchObject({ ok: false, limit: false });
  });

  it("a new active project goes last in the order", () => {
    expect(nextActivePosition([])).toBe(1);
    expect(nextActivePosition([make("a", 1), make("b", 4), make("p", 9, { status: "deferred" })])).toBe(5);
  });
});

describe("Intention lifecycle", () => {
  it("completing or releasing stamps closedAt; deferring does not", () => {
    const list = [make("a", 1)];
    expect(changeIntentionStatus(list, "a", "completed", T1)).toMatchObject({
      ok: true,
      value: { status: "completed", closedAt: T1, version: 2 },
    });
    expect(changeIntentionStatus(list, "a", "released", T1)).toMatchObject({
      ok: true,
      value: { status: "released", closedAt: T1 },
    });
    expect(changeIntentionStatus(list, "a", "deferred", T1)).toMatchObject({
      ok: true,
      value: { status: "deferred", closedAt: null },
    });
  });

  it("a mistakenly closed project comes back only as paused, never straight to active", () => {
    const closed = [make("a", 1, { status: "completed", closedAt: T0 })];
    expect(changeIntentionStatus(closed, "a", "active", T1)).toMatchObject({ ok: false, limit: false });
    expect(changeIntentionStatus(closed, "a", "deferred", T1)).toMatchObject({
      ok: true,
      value: { status: "deferred", closedAt: null },
    });
  });

  it("refuses unknown ids and no-op transitions", () => {
    expect(changeIntentionStatus([make("a", 1)], "zzz", "completed", T1)).toMatchObject({ ok: false });
    expect(changeIntentionStatus([make("a", 1)], "a", "active", T1)).toMatchObject({ ok: false });
    expect(changeIntentionStatus([make("a", 1, { status: "released" })], "a", "completed", T1)).toMatchObject({
      ok: false,
    });
  });
});
