import { describe, expect, it } from "vitest";
import {
  createDecadeItem,
  createHorizon,
  createYearDirection,
  DECADE_PLAN_MAX_ITEMS,
  DECADE_STATEMENT_MAX,
  decadesServedBy,
  reviseDecadeItem,
  reviseHorizon,
  reviseYearDirection,
  rewordDecadeItem,
  rewordHorizon,
  rewordYearDirection,
  STRATEGY_TEXT_MAX,
  sortDecadePlan,
  yearRangesOverlap,
} from "../src";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";

function decade(id: string, startYear: number, endYear: number, statement = "s") {
  const r = createDecadeItem({ id, startYear, endYear, statement, others: [], now: T0 });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("decade plan", () => {
  it("creates a short statement at version 1", () => {
    expect(
      createDecadeItem({
        id: "d1",
        startYear: 2026,
        endYear: 2035,
        statement: "  Стать мастером  ",
        others: [],
        now: T0,
      }),
    ).toEqual({
      ok: true,
      value: {
        id: "d1",
        startYear: 2026,
        endYear: 2035,
        statement: "Стать мастером",
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    });
  });

  it("orders items by start year regardless of insertion order", () => {
    const items = [decade("c", 2046, 2055), decade("a", 2026, 2035), decade("b", 2036, 2045)];
    expect(sortDecadePlan(items).map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects empty, oversized, inverted, over-long and out-of-bounds statements/ranges", () => {
    const base = { id: "d", startYear: 2026, endYear: 2035, statement: "ok", others: [], now: T0 };
    expect(createDecadeItem({ ...base, statement: "  " }).ok).toBe(false);
    expect(createDecadeItem({ ...base, statement: "x".repeat(DECADE_STATEMENT_MAX + 1) }).ok).toBe(false);
    expect(createDecadeItem({ ...base, startYear: 2036, endYear: 2030 }).ok).toBe(false);
    expect(createDecadeItem({ ...base, startYear: 2026, endYear: 2036 }).ok).toBe(false); // 11 years
    expect(createDecadeItem({ ...base, startYear: 1800, endYear: 1805 }).ok).toBe(false);
    expect(createDecadeItem({ ...base, startYear: 2026.5, endYear: 2030 }).ok).toBe(false);
  });

  it("never lets two decades overlap, but allows touching neighbours", () => {
    const existing = decade("a", 2026, 2035);
    const overlapping = createDecadeItem({
      id: "b",
      startYear: 2035,
      endYear: 2040,
      statement: "x",
      others: [existing],
      now: T0,
    });
    expect(overlapping).toEqual({ ok: false, reason: "Decade ranges must not overlap" });
    expect(
      createDecadeItem({ id: "b", startYear: 2036, endYear: 2045, statement: "x", others: [existing], now: T0 }).ok,
    ).toBe(true);
  });

  it("caps the plan: far = coarse, not dozens of goals", () => {
    const others = Array.from({ length: DECADE_PLAN_MAX_ITEMS }, (_, i) =>
      decade(`d${i}`, 1900 + i * 10, 1900 + i * 10 + 9),
    );
    expect(createDecadeItem({ id: "x", startYear: 2100, endYear: 2105, statement: "x", others, now: T0 }).ok).toBe(
      false,
    );
  });

  it("MODE A reword changes only the statement; MODE B revise may move the years", () => {
    const item = decade("a", 2026, 2035, "старое");
    expect(rewordDecadeItem(item, "лучше сказано", T1)).toEqual({
      ok: true,
      value: { ...item, statement: "лучше сказано", version: 2, updatedAt: T1 },
    });
    const neighbour = decade("b", 2036, 2045);
    const revised = reviseDecadeItem(item, { startYear: 2026, endYear: 2032, statement: "иное" }, [neighbour], T1);
    expect(revised).toMatchObject({ ok: true, value: { endYear: 2032, statement: "иное", version: 2 } });
    expect(reviseDecadeItem(item, { startYear: 2030, endYear: 2040, statement: "иное" }, [neighbour], T1).ok).toBe(
      false,
    );
  });

  it("yearRangesOverlap is inclusive on both ends", () => {
    expect(yearRangesOverlap({ startYear: 2020, endYear: 2029 }, { startYear: 2029, endYear: 2031 })).toBe(true);
    expect(yearRangesOverlap({ startYear: 2020, endYear: 2029 }, { startYear: 2030, endYear: 2031 })).toBe(false);
  });
});

describe("3-year horizon", () => {
  it("always spans exactly three years", () => {
    const r = createHorizon({ id: "h", startYear: 2026, direction: "Запустить и вырасти", whyItMatters: "", now: T0 });
    expect(r).toMatchObject({ ok: true, value: { startYear: 2026, endYear: 2028, version: 1, whyItMatters: "" } });
  });

  it("rejects an empty or oversized direction / why", () => {
    expect(createHorizon({ id: "h", startYear: 2026, direction: " ", whyItMatters: "", now: T0 }).ok).toBe(false);
    expect(
      createHorizon({
        id: "h",
        startYear: 2026,
        direction: "x".repeat(STRATEGY_TEXT_MAX + 1),
        whyItMatters: "",
        now: T0,
      }).ok,
    ).toBe(false);
    expect(
      createHorizon({
        id: "h",
        startYear: 2026,
        direction: "ok",
        whyItMatters: "x".repeat(STRATEGY_TEXT_MAX + 1),
        now: T0,
      }).ok,
    ).toBe(false);
  });

  it("reword keeps the years; revise moves them (still three years)", () => {
    const h = createHorizon({ id: "h", startYear: 2026, direction: "a", whyItMatters: "", now: T0 });
    if (!h.ok) throw new Error("unreachable");
    const reworded = rewordHorizon(h.value, { direction: "b", whyItMatters: "потому что" }, T1);
    expect(reworded).toMatchObject({
      ok: true,
      value: { startYear: 2026, endYear: 2028, direction: "b", whyItMatters: "потому что", version: 2, createdAt: T0 },
    });
    const revised = reviseHorizon(h.value, { startYear: 2027, direction: "c", whyItMatters: "" }, T1);
    expect(revised).toMatchObject({
      ok: true,
      value: { startYear: 2027, endYear: 2029, direction: "c", version: 2, createdAt: T0, updatedAt: T1 },
    });
  });

  it("serves the decade statements its years fall into (derived, not stored)", () => {
    const plan = [decade("d20", 2020, 2029), decade("d30", 2030, 2039), decade("d40", 2040, 2049)];
    const h = createHorizon({ id: "h", startYear: 2028, direction: "a", whyItMatters: "", now: T0 });
    if (!h.ok) throw new Error("unreachable");
    expect(decadesServedBy(h.value, plan).map((d) => d.id)).toEqual(["d20", "d30"]);
    expect(decadesServedBy(h.value, [])).toEqual([]);
  });
});

describe("year direction", () => {
  it("is created at version 1; reword keeps the year, revise may change it", () => {
    const y = createYearDirection({ id: "y", year: 2026, direction: "Запустить", whyItMatters: "", now: T0 });
    expect(y).toMatchObject({ ok: true, value: { year: 2026, version: 1 } });
    if (!y.ok) throw new Error("unreachable");
    expect(rewordYearDirection(y.value, { direction: "Выпустить", whyItMatters: "" }, T1)).toMatchObject({
      ok: true,
      value: { year: 2026, direction: "Выпустить", version: 2 },
    });
    expect(reviseYearDirection(y.value, { year: 2027, direction: "Расти", whyItMatters: "" }, T1)).toMatchObject({
      ok: true,
      value: { year: 2027, direction: "Расти", version: 2, createdAt: T0 },
    });
  });

  it("rejects an out-of-range year and an empty direction", () => {
    expect(createYearDirection({ id: "y", year: 99, direction: "x", whyItMatters: "", now: T0 }).ok).toBe(false);
    expect(createYearDirection({ id: "y", year: 2026, direction: "", whyItMatters: "", now: T0 }).ok).toBe(false);
  });
});
