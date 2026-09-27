import { describe, expect, it } from "vitest";
import { createProbe, isAtVersion, PROBE_TITLE_MAX, renameProbe } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

describe("Probe", () => {
  it("is created at version 1 with trimmed title", () => {
    const r = createProbe({ id: "p1", title: "  hello ", now: T0 });
    expect(r).toEqual({
      ok: true,
      value: { id: "p1", title: "hello", version: 1, createdAt: T0, updatedAt: T0 },
    });
  });

  it("rejects empty and oversized titles", () => {
    expect(createProbe({ id: "p1", title: "   ", now: T0 }).ok).toBe(false);
    expect(createProbe({ id: "p1", title: "x".repeat(PROBE_TITLE_MAX + 1), now: T0 }).ok).toBe(false);
  });

  it("rename bumps version and updatedAt only", () => {
    const created = createProbe({ id: "p1", title: "a", now: T0 });
    if (!created.ok) throw new Error("unreachable");
    const renamed = renameProbe(created.value, "b", T1);
    expect(renamed).toEqual({
      ok: true,
      value: { id: "p1", title: "b", version: 2, createdAt: T0, updatedAt: T1 },
    });
  });

  it("isAtVersion compares optimistic versions", () => {
    expect(isAtVersion({ version: 3 }, 3)).toBe(true);
    expect(isAtVersion({ version: 3 }, 2)).toBe(false);
  });
});
