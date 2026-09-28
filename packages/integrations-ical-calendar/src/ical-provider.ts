// Real adapter for the `CalendarProvider` boundary (ARCHITECTURE §32), reading a private iCal feed
// (Stage 4 iCal decision) instead of the Google Calendar REST API. No Electron dependency:
// `secretStore` is the seam apps/desktop/src/main fills with `safeStorage`.
import ICAL from "ical.js";
import {
  CalendarAuthError,
  type CalendarProvider,
  CalendarProviderError,
  type RawCalendarEvent,
  type RawCalendarSnapshot,
  type SecretStore,
} from "./types";
import { isValidIcalFeedUrl } from "./validate";

const TIMEOUT_MS = 15_000;
/** Generous for a personal calendar feed, but bounded — not a general-purpose download capability. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** "A few weeks" (Stage 4 iCal decision §9): enough for the next-event/current-action use case
 * without expanding recurring events indefinitely. */
const HORIZON_DAYS = 21;
const MAX_EVENTS = 200;
/** Defense-in-depth against a pathological rule (e.g. "every minute" with no UNTIL/COUNT): the
 * horizon check below already terminates expansion, this just bounds worst-case iteration count.
 * Generous enough to walk a daily/weekly/monthly series back to a DTSTART decades in the past —
 * the cheap pre-filter below keeps that walk fast. */
const MAX_OCCURRENCES_PER_SERIES = 50_000;

async function fetchIcalText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch {
    throw new CalendarProviderError("Could not reach the calendar feed");
  } finally {
    clearTimeout(timeout);
  }
  if ([401, 403, 404, 410].includes(response.status)) {
    throw new CalendarAuthError("The calendar feed link was rejected");
  }
  if (!response.ok) throw new CalendarProviderError(`Calendar feed returned ${response.status}`);

  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CalendarProviderError("Calendar feed response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function zoneIdOf(time: ICAL.Time): string | null {
  const zone = time.zone;
  if (!zone) return null;
  if (zone === ICAL.Timezone.utcTimezone) return "UTC";
  if (zone === ICAL.Timezone.localTimezone) return null; // floating time: no explicit zone
  return zone.tzid || null;
}

function dateOnlyToUtcMidnight(t: ICAL.Time): string {
  const y = String(t.year).padStart(4, "0");
  const m = String(t.month).padStart(2, "0");
  const d = String(t.day).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

function toRawEvent(
  id: string,
  title: string,
  start: ICAL.Time,
  end: ICAL.Time,
  feedTimeZone: string,
): RawCalendarEvent {
  const allDay = start.isDate;
  return {
    id,
    title,
    start: allDay ? dateOnlyToUtcMidnight(start) : start.toJSDate().toISOString(),
    end: allDay ? dateOnlyToUtcMidnight(end) : end.toJSDate().toISOString(),
    timeZone: zoneIdOf(start) ?? feedTimeZone,
    allDay,
  };
}

function isCancelled(comp: ICAL.Component): boolean {
  const status = comp.getFirstPropertyValue("status");
  return typeof status === "string" && status.toUpperCase() === "CANCELLED";
}

/** Expands every VEVENT (including recurrence, per Stage 4 iCal decision §9) into concrete
 * occurrences within [now, now + HORIZON_DAYS], applying per-occurrence exceptions and cancellations. */
function parseIcal(text: string, now: Date): RawCalendarSnapshot {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new CalendarProviderError("Calendar feed could not be parsed");
  }

  for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(vtimezone);
    if (zone.tzid) ICAL.TimezoneService.register(zone);
  }

  const nowTime = ICAL.Time.fromJSDate(now, true);
  const horizonTime = ICAL.Time.fromJSDate(new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000), true);

  type SeriesEntry = { base?: ICAL.Event; exceptions: ICAL.Event[] };
  const series = new Map<string, SeriesEntry>();
  for (const comp of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(comp);
    const entry = series.get(event.uid) ?? { exceptions: [] };
    if (event.isRecurrenceException()) entry.exceptions.push(event);
    else entry.base = event;
    series.set(event.uid, entry);
  }

  const events: RawCalendarEvent[] = [];
  let feedTimeZone = "UTC";
  const noteZone = (t: ICAL.Time) => {
    const zone = zoneIdOf(t);
    if (zone && zone !== "UTC") feedTimeZone = zone;
  };

  for (const { base, exceptions } of series.values()) {
    if (!base || isCancelled(base.component)) continue; // orphaned exception, or whole series cancelled
    for (const exception of exceptions) base.relateException(exception);

    if (!base.isRecurring()) {
      if (base.endDate.compare(nowTime) < 0 || base.startDate.compare(horizonTime) > 0) continue;
      noteZone(base.startDate);
      events.push(toRawEvent(base.uid, base.summary ?? "", base.startDate, base.endDate, feedTimeZone));
      continue;
    }

    // Always iterate from the series' real DTSTART. Seeding `iterator()` with any other date makes
    // ical.js compute COUNT, INTERVAL and any BY* part missing from the rule relative to that seed
    // instead of DTSTART — confirmed against ical.js 2.2.1 to silently resurrect finished COUNT
    // series, shift biweekly/every-N rhythms, and move BYDAY/BYMONTHDAY/BYMONTH-less rules to the
    // seed's own weekday/day/month. A wrong seed is worse than a slow walk. Instead, skip the
    // expensive `getOccurrenceDetails` call (which resolves per-occurrence overrides) for
    // occurrences that cannot possibly still be relevant, using only the base duration.
    const iterator = base.iterator();
    for (let i = 0; i < MAX_OCCURRENCES_PER_SERIES; i++) {
      const occurrenceStart = iterator.next();
      if (!occurrenceStart || occurrenceStart.compare(horizonTime) > 0) break;
      const approxEnd = occurrenceStart.clone();
      approxEnd.addDuration(base.duration);
      if (approxEnd.compare(nowTime) < 0) continue; // cheap skip, no getOccurrenceDetails needed
      const details = base.getOccurrenceDetails(occurrenceStart);
      if (isCancelled(details.item.component) || details.endDate.compare(nowTime) < 0) continue;
      noteZone(details.startDate);
      const id = `${base.uid}_${occurrenceStart.toICALString()}`;
      events.push(toRawEvent(id, details.item.summary ?? "", details.startDate, details.endDate, feedTimeZone));
    }
  }

  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return { timeZone: feedTimeZone, events: events.slice(0, MAX_EVENTS) };
}

export function createIcalCalendarProvider(deps: { secretStore: SecretStore; now?: () => Date }): CalendarProvider {
  const now = deps.now ?? (() => new Date());
  return {
    isConnected: () => deps.secretStore.load() !== null,
    refresh: async () => {
      const url = deps.secretStore.load();
      if (!url) throw new CalendarAuthError("Calendar is not connected");
      if (!isValidIcalFeedUrl(url)) throw new CalendarAuthError("Stored calendar feed URL is invalid");
      return parseIcal(await fetchIcalText(url), now());
    },
  };
}
