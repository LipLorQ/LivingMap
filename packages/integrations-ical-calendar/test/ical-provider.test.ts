import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarAuthError, CalendarProviderError, createIcalCalendarProvider, type SecretStore } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FIXED_NOW = new Date("2026-09-28T10:00:00.000Z");
const FEED_URL =
  "https://calendar.google.com/calendar/ical/secret%40group.calendar.google.com/private-abc123/basic.ics";

function fakeSecretStore(initial: string | null): SecretStore {
  let current = initial;
  return {
    load: () => current,
    save: (url) => {
      current = url;
    },
    clear: () => {
      current = null;
    },
  };
}

const MOSCOW_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "TZNAME:MSK",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

function vcal(...vevents: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//test//EN",
    MOSCOW_VTIMEZONE,
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function icsResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function provider(secretStore: SecretStore) {
  return createIcalCalendarProvider({ secretStore, now: () => FIXED_NOW });
}

describe("createIcalCalendarProvider.isConnected", () => {
  it("reflects whether a feed URL is stored, without any network call", () => {
    expect(provider(fakeSecretStore(null)).isConnected()).toBe(false);
    expect(provider(fakeSecretStore(FEED_URL)).isConnected()).toBe(true);
  });
});

describe("createIcalCalendarProvider.refresh — connection/network", () => {
  it("refuses to refresh when never connected", async () => {
    await expect(provider(fakeSecretStore(null)).refresh()).rejects.toBeInstanceOf(CalendarAuthError);
  });

  it("a network failure surfaces as CalendarProviderError, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
    await expect(provider(fakeSecretStore(FEED_URL)).refresh()).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it("a rejected/rotated feed link (403/404/410) is CalendarAuthError, prompting reconnect", async () => {
    for (const status of [403, 404, 410]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
      await expect(provider(fakeSecretStore(FEED_URL)).refresh()).rejects.toBeInstanceOf(CalendarAuthError);
    }
  });

  it("any other non-2xx response is CalendarProviderError (transient, not a reconnect prompt)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(provider(fakeSecretStore(FEED_URL)).refresh()).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it("malformed iCal data is CalendarProviderError, never a raw parser crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, "BEGIN:VCALENDAR\r\nGARBAGE\r\n")));
    await expect(provider(fakeSecretStore(FEED_URL)).refresh()).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it("a response larger than the size cap is rejected instead of being parsed", async () => {
    const huge = "X".repeat(5 * 1024 * 1024 + 1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, huge)));
    await expect(provider(fakeSecretStore(FEED_URL)).refresh()).rejects.toBeInstanceOf(CalendarProviderError);
  });
});

describe("createIcalCalendarProvider.refresh — parsing", () => {
  it("reads a simple timed event", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:evt1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260928T120000Z",
        "DTEND:20260928T123000Z",
        "SUMMARY:Созвон",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toEqual([
      {
        id: "evt1@test",
        title: "Созвон",
        start: "2026-09-28T12:00:00.000Z",
        end: "2026-09-28T12:30:00.000Z",
        timeZone: "UTC",
        allDay: false,
      },
    ]);
  });

  it("represents an all-day event as a UTC-midnight anchor, not a guessed time", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:allday1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART;VALUE=DATE:20260929",
        "DTEND;VALUE=DATE:20260930",
        "SUMMARY:День рождения",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toEqual([
      {
        id: "allday1@test",
        title: "День рождения",
        start: "2026-09-29T00:00:00.000Z",
        end: "2026-09-30T00:00:00.000Z",
        timeZone: "UTC",
        allDay: true,
      },
    ]);
  });

  it("resolves a TZID-anchored event to the correct UTC instant (timezone-aware)", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:tz1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART;TZID=Europe/Moscow:20260928T150000",
        "DTEND;TZID=Europe/Moscow:20260928T153000",
        "SUMMARY:Встреча по МСК",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    // 15:00 MSK (UTC+3, no DST) = 12:00 UTC.
    expect(snapshot.events).toEqual([
      {
        id: "tz1@test",
        title: "Встреча по МСК",
        start: "2026-09-28T12:00:00.000Z",
        end: "2026-09-28T12:30:00.000Z",
        timeZone: "Europe/Moscow",
        allDay: false,
      },
    ]);
  });

  it("expands a daily recurrence (bounded, timezone-aware) into concrete occurrences", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:daily1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART;TZID=Europe/Moscow:20260928T150000",
        "DTEND;TZID=Europe/Moscow:20260928T153000",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Ежедневная встреча",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.map((e) => e.start)).toEqual([
      "2026-09-28T12:00:00.000Z",
      "2026-09-29T12:00:00.000Z",
      "2026-09-30T12:00:00.000Z",
    ]);
    for (const event of snapshot.events) {
      expect(event.timeZone).toBe("Europe/Moscow");
      expect(event.allDay).toBe(false);
      expect(event.id.startsWith("daily1@test_")).toBe(true);
    }
  });

  it("finds near-term occurrences of a recurrence that started years ago (does not exhaust the iteration budget walking from DTSTART)", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:longrunning1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20230101T090000Z",
        "DTEND:20230101T093000Z",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Ежедневная привычка",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // Today's 09:00–09:30 occurrence already ended before FIXED_NOW (10:00); the daily rule has no
    // COUNT/UNTIL, so every remaining day up to the 21-day horizon is a valid occurrence.
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.slice(0, 3).map((e) => e.start)).toEqual([
      "2026-09-29T09:00:00.000Z",
      "2026-09-30T09:00:00.000Z",
      "2026-10-01T09:00:00.000Z",
    ]);
    expect(snapshot.events).toHaveLength(21);
  });

  it("still includes a still-ongoing occurrence of a long-running recurrence (started before now, ends after)", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:ongoing1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20230101T093000Z",
        "DTEND:20230101T103000Z",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Долгая ежедневная встреча",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // FIXED_NOW is 2026-09-28T10:00:00Z, inside today's 09:30–10:30 occurrence.
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events[0]).toMatchObject({ start: "2026-09-28T09:30:00.000Z", end: "2026-09-28T10:30:00.000Z" });
  });

  it("honors a weekly recurrence's UNTIL bound (stops before the horizon would)", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:weekly1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260929T090000Z",
        "DTEND:20260929T093000Z",
        "RRULE:FREQ=WEEKLY;UNTIL=20261013T090000Z",
        "SUMMARY:Еженедельная встреча",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.map((e) => e.start)).toEqual([
      "2026-09-29T09:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
      "2026-10-13T09:00:00.000Z",
    ]);
  });

  it("excludes an occurrence removed via EXDATE", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:exdate1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260929T140000Z",
        "DTEND:20260929T150000Z",
        "RRULE:FREQ=DAILY;COUNT=4",
        "EXDATE:20260930T140000Z",
        "SUMMARY:С исключением",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.map((e) => e.start)).toEqual([
      "2026-09-29T14:00:00.000Z",
      "2026-10-01T14:00:00.000Z",
      "2026-10-02T14:00:00.000Z",
    ]);
  });

  it("excludes a single cancelled occurrence overridden via RECURRENCE-ID + STATUS:CANCELLED", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:cancel1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260929T160000Z",
        "DTEND:20260929T163000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Серия",
        "END:VEVENT",
      ].join("\r\n"),
      [
        "BEGIN:VEVENT",
        "UID:cancel1@test",
        "RECURRENCE-ID:20260930T160000Z",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260930T160000Z",
        "DTEND:20260930T163000Z",
        "SUMMARY:Серия",
        "STATUS:CANCELLED",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.map((e) => e.start)).toEqual(["2026-09-29T16:00:00.000Z", "2026-10-01T16:00:00.000Z"]);
  });

  it("excludes an entirely cancelled non-recurring event", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:cancelled-single@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260929T100000Z",
        "DTEND:20260929T110000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Отменено",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toEqual([]);
  });

  it("excludes an event that already ended before now", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:past1@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260928T070000Z",
        "DTEND:20260928T080000Z",
        "SUMMARY:Уже прошло",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toEqual([]);
  });

  it("does not resurrect a COUNT-bounded recurrence that already finished before now", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:finished-count@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260701T090000Z",
        "DTEND:20260701T093000Z",
        "RRULE:FREQ=DAILY;COUNT=5",
        "SUMMARY:Уже закончившаяся серия",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // COUNT=5 from Jul 1 ends Jul 5, long before FIXED_NOW (Sep 28). A seed-shifted iterator would
    // recompute COUNT relative to the seed and wrongly resurrect "occurrences" near now.
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toEqual([]);
  });

  it("keeps a DAILY;INTERVAL=2 recurrence's parity anchored to DTSTART, not to an arbitrary seed", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:interval2@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260101T090000Z",
        "DTEND:20260101T093000Z",
        "RRULE:FREQ=DAILY;INTERVAL=2",
        "SUMMARY:Через день",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // Every-other-day from Jan 1 (day 0, even) lands on Sep 28 (day 270, even), Sep 30, Oct 2, ... —
    // never on the odd-offset days in between. `now` sits just after the Sep 28 occurrence ends, so
    // the first two occurrences returned must be Sep 30 and Oct 2, not Sep 29/Oct 1 (what a seed one
    // day off from a true multiple of 2 would produce).
    const customNowProvider = createIcalCalendarProvider({
      secretStore: fakeSecretStore(FEED_URL),
      now: () => new Date("2026-09-29T10:00:00.000Z"),
    });
    const snapshot = await customNowProvider.refresh();
    expect(snapshot.events.slice(0, 2).map((e) => e.start)).toEqual([
      "2026-09-30T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
    ]);
  });

  it("keeps a BYDAY-less weekly recurrence anchored to DTSTART's own weekday", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:weekly-no-byday@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260106T090000Z",
        "DTEND:20260106T093000Z",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Еженедельно без BYDAY",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // With no BYDAY, RFC 5545 keeps every occurrence on DTSTART's own weekday — i.e. an exact
    // multiple of 7 days from DTSTART. A seed-shifted iterator can land on the seed's weekday
    // instead, which this invariant catches regardless of which weekday DTSTART happens to be.
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.length).toBeGreaterThan(0);
    const dtstartMs = Date.parse("2026-01-06T09:00:00.000Z");
    for (const event of snapshot.events) {
      expect((new Date(event.start).getTime() - dtstartMs) % (7 * 86_400_000)).toBe(0);
    }
  });

  it("keeps a BYMONTHDAY-less monthly recurrence on DTSTART's own day of month", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:monthly-no-bymonthday@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260115T090000Z",
        "DTEND:20260115T093000Z",
        "RRULE:FREQ=MONTHLY",
        "SUMMARY:Ежемесячно без BYMONTHDAY",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // Sep 15 already passed before FIXED_NOW (Sep 28); the next real occurrence is Oct 15, not
    // "Sep 28" (a seed-shifted iterator can wrongly emit an occurrence on the seed date itself).
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events[0]?.start).toBe("2026-10-15T09:00:00.000Z");
  });

  it("keeps a BYMONTH-less yearly recurrence on DTSTART's own month and day", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:yearly-no-bymonth@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20201005T090000Z",
        "DTEND:20201005T093000Z",
        "RRULE:FREQ=YEARLY",
        "SUMMARY:Ежегодно без BYMONTH",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    // DTSTART is Oct 5; this year's occurrence (Oct 5, 2026) falls within the 21-day horizon from
    // FIXED_NOW (Sep 28). A seed-shifted iterator can wrongly emit an occurrence on the seed date
    // itself (Sep 28) instead of the real Oct 5 anniversary.
    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      title: "Ежегодно без BYMONTH",
      start: "2026-10-05T09:00:00.000Z",
      end: "2026-10-05T09:30:00.000Z",
      timeZone: "UTC",
      allDay: false,
    });
    expect(snapshot.events[0]?.id.startsWith("yearly-no-bymonth@test_")).toBe(true);
  });

  it("orders events by start time ascending regardless of source order", async () => {
    const ics = vcal(
      [
        "BEGIN:VEVENT",
        "UID:late@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260930T100000Z",
        "DTEND:20260930T110000Z",
        "SUMMARY:Позже",
        "END:VEVENT",
      ].join("\r\n"),
      [
        "BEGIN:VEVENT",
        "UID:early@test",
        "DTSTAMP:20260928T100000Z",
        "DTSTART:20260928T110000Z",
        "DTEND:20260928T120000Z",
        "SUMMARY:Раньше",
        "END:VEVENT",
      ].join("\r\n"),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(icsResponse(200, ics)));

    const snapshot = await provider(fakeSecretStore(FEED_URL)).refresh();
    expect(snapshot.events.map((e) => e.id)).toEqual(["early@test", "late@test"]);
  });
});
