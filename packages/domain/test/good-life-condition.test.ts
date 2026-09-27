import { describe, expect, it } from "vitest";
import { CONDITION_TEXT_MAX, createGoodLifeCondition, editGoodLifeCondition } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

describe("GoodLifeCondition", () => {
  it("is created at version 1 with trimmed text and given position", () => {
    const r = createGoodLifeCondition({ id: "g1", text: "  sleep 8h  ", position: 3, now: T0 });
    expect(r).toEqual({
      ok: true,
      value: { id: "g1", text: "sleep 8h", position: 3, version: 1, createdAt: T0, updatedAt: T0 },
    });
  });

  it("rejects empty and oversized text", () => {
    expect(createGoodLifeCondition({ id: "g1", text: " ", position: 1, now: T0 }).ok).toBe(false);
    expect(
      createGoodLifeCondition({ id: "g1", text: "x".repeat(CONDITION_TEXT_MAX + 1), position: 1, now: T0 }).ok,
    ).toBe(false);
  });

  it("edit bumps version and updatedAt, keeps position", () => {
    const created = createGoodLifeCondition({ id: "g1", text: "a", position: 1, now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const edited = editGoodLifeCondition(created.value, "b", T1);
    expect(edited).toEqual({
      ok: true,
      value: { id: "g1", text: "b", position: 1, version: 2, createdAt: T0, updatedAt: T1 },
    });
  });
});
