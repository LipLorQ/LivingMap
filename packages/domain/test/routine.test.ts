import { describe, expect, it } from "vitest";
import {
  COURSE_SUMMARY_MAX,
  computeReorder,
  createCourseChange,
  createRoutineItem,
  editRoutineItem,
  ROUTINE_MAX_ITEMS_PER_KIND,
  ROUTINE_TEXT_MAX,
  resolveCourseChange,
  validateActionOrder,
} from "../src";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";

describe("routine", () => {
  it("is created active, appended to its own kind, at version 1", () => {
    const first = createRoutineItem({ id: "r1", kind: "morning", text: "  Стакан воды ", siblingCount: 0, now: T0 });
    expect(first).toEqual({
      ok: true,
      value: {
        id: "r1",
        kind: "morning",
        text: "Стакан воды",
        position: 1,
        active: true,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    });
    expect(createRoutineItem({ id: "r2", kind: "evening", text: "Читать", siblingCount: 2, now: T0 })).toMatchObject({
      ok: true,
      value: { position: 3 },
    });
  });

  it("rejects an empty or oversized item and a routine that grows into a task list", () => {
    expect(createRoutineItem({ id: "r", kind: "morning", text: " ", siblingCount: 0, now: T0 }).ok).toBe(false);
    expect(
      createRoutineItem({ id: "r", kind: "morning", text: "x".repeat(ROUTINE_TEXT_MAX + 1), siblingCount: 0, now: T0 })
        .ok,
    ).toBe(false);
    expect(
      createRoutineItem({ id: "r", kind: "morning", text: "ok", siblingCount: ROUTINE_MAX_ITEMS_PER_KIND, now: T0 }).ok,
    ).toBe(false);
  });

  it("edits text and active flag; a no-op is refused", () => {
    const created = createRoutineItem({ id: "r", kind: "evening", text: "a", siblingCount: 0, now: T0 });
    if (!created.ok) throw new Error("unreachable");
    expect(editRoutineItem(created.value, { text: "b" }, T1)).toMatchObject({
      ok: true,
      value: { text: "b", active: true, version: 2, updatedAt: T1 },
    });
    expect(editRoutineItem(created.value, { active: false }, T1)).toMatchObject({ ok: true, value: { active: false } });
    expect(editRoutineItem(created.value, { text: "a" }, T1).ok).toBe(false);
    expect(editRoutineItem(created.value, { text: "  " }, T1).ok).toBe(false);
  });

  it("is ordered through the shared manual reorder, never through an OrderedActionPlan", () => {
    expect(computeReorder(["a", "b", "c"], ["c", "a", "b"])).toMatchObject({ ok: true });
    expect(computeReorder(["a", "b"], ["a"]).ok).toBe(false);
    // A routine id can never be smuggled into the AI execution order: it is not an Action of the route.
    const actions = [{ id: "act1", status: "open" as const }];
    expect(validateActionOrder(["act1", "routine-1"], actions).ok).toBe(false);
  });
});

describe("course change record", () => {
  it("is open until the owner resolves it, once", () => {
    const c = createCourseChange({ id: "c1", level: "year", targetId: "y1", summary: "  Новый курс ", now: T0 });
    expect(c).toEqual({
      ok: true,
      value: { id: "c1", level: "year", targetId: "y1", summary: "Новый курс", changedAt: T0, resolvedAt: null },
    });
    if (!c.ok) throw new Error("unreachable");
    const resolved = resolveCourseChange(c.value, T1);
    expect(resolved).toMatchObject({ ok: true, value: { resolvedAt: T1 } });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolveCourseChange(resolved.value, T1).ok).toBe(false);
  });

  it("rejects an empty summary and truncates an over-long one", () => {
    expect(createCourseChange({ id: "c", level: "season", targetId: "s", summary: " ", now: T0 }).ok).toBe(false);
    const long = createCourseChange({
      id: "c",
      level: "season",
      targetId: "s",
      summary: "x".repeat(COURSE_SUMMARY_MAX + 50),
      now: T0,
    });
    expect(long).toMatchObject({ ok: true });
    if (long.ok) expect(long.value.summary).toHaveLength(COURSE_SUMMARY_MAX);
  });
});
