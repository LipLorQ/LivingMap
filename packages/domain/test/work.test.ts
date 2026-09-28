import { describe, expect, it } from "vitest";
import {
  addDays,
  closeAt,
  isSilent,
  localDate,
  startOfLocalDay,
  totalWorkedMs,
  type WorkInterval,
  weekStart,
  workedMsBetweenDates,
} from "../src";

const MIN = 60_000;
const iv = (startedAt: string, endedAt: string | null, timeZone = "Europe/Moscow"): WorkInterval => ({
  id: startedAt,
  actionId: "a",
  startedAt,
  endedAt,
  lastHeartbeatAt: startedAt,
  timeZone,
});

describe("work time accounting", () => {
  it("sums several intervals and counts the running one up to now", () => {
    const running = { ...iv("2026-09-28T15:00:00Z", null), lastHeartbeatAt: "2026-09-28T15:34:00Z" };
    const intervals = [iv("2026-09-28T06:00:00Z", "2026-09-28T06:20:00Z"), running];
    expect(totalWorkedMs(intervals, "2026-09-28T15:35:00Z")).toBe(55 * MIN);
  });

  it("a running interval silent for too long (unnoticed sleep) stops at its last checkpoint", () => {
    const running = { ...iv("2026-09-28T15:00:00Z", null), lastHeartbeatAt: "2026-09-28T15:10:00Z" };
    expect(isSilent(running, "2026-09-28T23:00:00Z")).toBe(true);
    expect(isSilent(running, "2026-09-28T15:11:00Z")).toBe(false);
    expect(totalWorkedMs([running], "2026-09-28T23:00:00Z")).toBe(10 * MIN);
    expect(closeAt(running, "2026-09-28T23:00:00Z")).toBe("2026-09-28T15:10:00Z");
    expect(closeAt(running, "2026-09-28T15:11:00Z")).toBe("2026-09-28T15:11:00Z");
  });

  it("a backwards clock never yields negative time", () => {
    const running = iv("2026-09-28T10:00:00Z", null);
    expect(closeAt(running, "2026-09-28T09:00:00Z")).toBe("2026-09-28T10:00:00Z");
    expect(totalWorkedMs([running], "2026-09-28T09:00:00Z")).toBe(0);
  });

  it("local date follows the interval's zone, not UTC (00:30 Moscow is the next day)", () => {
    expect(localDate("2026-09-28T21:30:00Z", "Europe/Moscow")).toBe("2026-09-29");
    expect(localDate("2026-09-28T21:30:00Z", "UTC")).toBe("2026-09-28");
    expect(startOfLocalDay("2026-09-29", "Europe/Moscow")).toBe(Date.parse("2026-09-28T21:00:00Z"));
  });

  it("splits an interval crossing local midnight between the two days", () => {
    // 23:30–00:45 Moscow local.
    const i = [iv("2026-09-28T20:30:00Z", "2026-09-28T21:45:00Z")];
    expect(workedMsBetweenDates(i, "2026-09-28", "2026-09-29", "2026-09-30T00:00:00Z")).toBe(30 * MIN);
    expect(workedMsBetweenDates(i, "2026-09-29", "2026-09-30", "2026-09-30T00:00:00Z")).toBe(45 * MIN);
  });

  it("historical attribution uses the stored zone even if today's zone differs", () => {
    // Worked 00:30–01:00 in Moscow on the 29th; as UTC this was the 28th.
    const i = [iv("2026-09-28T21:30:00Z", "2026-09-28T22:00:00Z", "Europe/Moscow")];
    expect(workedMsBetweenDates(i, "2026-09-29", "2026-09-30", "2026-10-01T00:00:00Z")).toBe(30 * MIN);
    expect(workedMsBetweenDates(i, "2026-09-28", "2026-09-29", "2026-10-01T00:00:00Z")).toBe(0);
  });

  it("DST day has the right midnight", () => {
    // Europe/Berlin switches to winter time on 2026-10-25.
    expect(startOfLocalDay("2026-10-25", "Europe/Berlin")).toBe(Date.parse("2026-10-24T22:00:00Z"));
    expect(startOfLocalDay("2026-10-26", "Europe/Berlin")).toBe(Date.parse("2026-10-25T23:00:00Z"));
  });

  it("Monday-start weeks", () => {
    expect(weekStart("2026-09-28")).toBe("2026-09-28"); // Monday
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(addDays("2026-09-28", 7)).toBe("2026-10-05");
  });
});
