import { describe, expect, it } from "vitest";
import { computeReorder } from "../src";

describe("computeReorder", () => {
  it("turns a permutation into 1-based positions", () => {
    const r = computeReorder(["a", "b", "c"], ["c", "a", "b"]);
    expect(r).toEqual({
      ok: true,
      value: new Map([
        ["c", 1],
        ["a", 2],
        ["b", 3],
      ]),
    });
  });

  it("rejects duplicates in the proposed order", () => {
    expect(computeReorder(["a", "b"], ["a", "a"]).ok).toBe(false);
  });

  it("rejects an order that drops an existing item", () => {
    expect(computeReorder(["a", "b"], ["a"]).ok).toBe(false);
  });

  it("rejects an order that introduces an unknown item", () => {
    expect(computeReorder(["a", "b"], ["a", "b", "c"]).ok).toBe(false);
  });
});
