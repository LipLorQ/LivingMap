import { describe, expect, it } from "vitest";
import { civilDayOf, formatDayRangeRu, formatDayRu, formatReviewPeriod } from "../src/renderer/src/format";

// Stage 9 Day 1 (owner's «+», 2026-10-05): «в разборах даты нужно писать … например: 5-10 октября 26г».
// Never numeric, never browser-locale output.
const day = (year: number, month: number, d: number) => ({ year, month, day: d });

describe("Russian dates in «Анализ»", () => {
  it("one day", () => {
    expect(formatDayRu(day(2026, 10, 5))).toBe("5 октября 26г");
    expect(formatDayRangeRu(day(2026, 10, 5), day(2026, 10, 5))).toBe("5 октября 26г");
  });

  it("a range inside one month", () => {
    expect(formatDayRangeRu(day(2026, 10, 5), day(2026, 10, 10))).toBe("5–10 октября 26г");
  });

  it("a range across months", () => {
    expect(formatDayRangeRu(day(2026, 9, 28), day(2026, 10, 4))).toBe("28 сентября – 4 октября 26г");
  });

  it("a range across years names both years", () => {
    expect(formatDayRangeRu(day(2026, 12, 28), day(2027, 1, 3))).toBe("28 декабря 26г – 3 января 27г");
  });

  it("every month in the genitive", () => {
    const months = Array.from({ length: 12 }, (_, i) => formatDayRu(day(2026, i + 1, 1)).split(" ")[1]);
    expect(months).toEqual([
      "января",
      "февраля",
      "марта",
      "апреля",
      "мая",
      "июня",
      "июля",
      "августа",
      "сентября",
      "октября",
      "ноября",
      "декабря",
    ]);
  });

  it("a Review's period: its own zone, exclusive end shown as the last included day", () => {
    // Weekly review stored for Monday 28 Sep 00:00 → Monday 5 Oct 00:00 in Asia/Jakarta (UTC+7).
    expect(
      formatReviewPeriod({
        periodStart: "2026-09-27T17:00:00.000Z",
        periodEnd: "2026-10-04T17:00:00.000Z",
        timeZone: "Asia/Jakarta",
      }),
    ).toBe("28 сентября – 4 октября 26г");
    // Daily review: one day, even though the UTC date of its start is the previous day.
    expect(
      formatReviewPeriod({
        periodStart: "2026-10-04T17:00:00.000Z",
        periodEnd: "2026-10-05T17:00:00.000Z",
        timeZone: "Asia/Jakarta",
      }),
    ).toBe("5 октября 26г");
    expect(civilDayOf("2026-10-04T17:00:00.000Z", "UTC")).toEqual(day(2026, 10, 4));
  });
});
