import { describe, expect, it } from "vitest";
import { isLaterLocalDay } from "../src/renderer/src/format";

// Stage 9 friction (owner's «+», 2026-10-05): on Monday the idle screen still showed last week's «За неделю»,
// because nothing re-read the figures after midnight. The renderer now reloads once the local day turns.
describe("local day rollover of the work figures", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

  it("is the same day until local midnight", () => {
    const computedAt = new Date(at(2026, 10, 4, 23, 8)).toISOString(); // Sunday evening
    expect(isLaterLocalDay(computedAt, at(2026, 10, 4, 23, 59))).toBe(false);
  });

  it("turns at local midnight, so Monday re-reads «Сегодня» and «За неделю»", () => {
    const computedAt = new Date(at(2026, 10, 4, 23, 8)).toISOString();
    expect(isLaterLocalDay(computedAt, at(2026, 10, 5, 0, 1))).toBe(true);
    expect(isLaterLocalDay(computedAt, at(2026, 10, 5, 9, 30))).toBe(true);
  });
});
