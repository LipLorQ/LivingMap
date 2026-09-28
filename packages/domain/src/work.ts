import type { EntityId, Instant } from "./types";

/**
 * One continuous period of real work on an Action. `endedAt === null` = running right now; at most
 * one such row exists globally (enforced by the database, not just here). Pause closes the row,
 * Resume opens a new one — "a session" is simply all intervals of one Action.
 * `timeZone` is the IANA zone the interval was worked in: daily/weekly attribution uses it, so
 * history never moves to another date when the user later travels or changes the system zone.
 */
export type WorkInterval = {
  readonly id: EntityId;
  readonly actionId: EntityId;
  readonly startedAt: Instant;
  readonly endedAt: Instant | null;
  /** Technical crash-recovery checkpoint; never shown, never part of history. */
  readonly lastHeartbeatAt: Instant;
  readonly timeZone: string;
};

/**
 * A running interval whose last checkpoint is older than this was not really running (sleep without
 * a suspend event, freeze, killed process, clock jump): time after the checkpoint is never work.
 */
export const WORK_HEARTBEAT_GAP_MS = 3 * 60_000;

const ms = (iso: Instant) => new Date(iso).getTime();

/** Latest trustworthy end of a running interval at `nowMs`: now, or its last checkpoint after a silence. */
function trustedEndMs(interval: WorkInterval, nowMs: number): number {
  const heartbeat = ms(interval.lastHeartbeatAt);
  return nowMs - heartbeat > WORK_HEARTBEAT_GAP_MS ? heartbeat : nowMs;
}

/** A running interval that has not been checkpointed for too long: it is not really running. */
export function isSilent(interval: WorkInterval, now: Instant): boolean {
  return interval.endedAt === null && trustedEndMs(interval, ms(now)) !== ms(now);
}

/**
 * Where a running interval stops when closed at `at`: never before it started (clock went
 * backwards) and never past its last checkpoint after a silence (unnoticed sleep, frozen app).
 */
export function closeAt(interval: WorkInterval, at: Instant): Instant {
  const end = trustedEndMs(interval, ms(at));
  if (end < ms(interval.startedAt)) return interval.startedAt;
  return end === ms(at) ? at : interval.lastHeartbeatAt;
}

function intervalEndMs(interval: WorkInterval, nowMs: number): number {
  return interval.endedAt === null
    ? Math.max(trustedEndMs(interval, nowMs), ms(interval.startedAt))
    : ms(interval.endedAt);
}

/** Total worked time of all given intervals, the running one counted up to `now`. */
export function totalWorkedMs(intervals: readonly WorkInterval[], now: Instant): number {
  const nowMs = ms(now);
  let total = 0;
  for (const i of intervals) total += intervalEndMs(i, nowMs) - ms(i.startedAt);
  return total;
}

/** "YYYY-MM-DD" civil date of `instant` in `timeZone`. */
export function localDate(instant: Instant | number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instant),
  );
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the (conventional, Monday-start) week containing `date`. */
export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** UTC epoch ms of local midnight starting `date` in `timeZone` (DST-safe: offset re-checked once). */
export function startOfLocalDay(date: string, timeZone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

/**
 * Worked time falling on local dates [fromDate, toDate) — each interval judged by its OWN stored
 * zone. An interval crossing local midnight is split between the two days.
 */
export function workedMsBetweenDates(
  intervals: readonly WorkInterval[],
  fromDate: string,
  toDate: string,
  now: Instant,
): number {
  const nowMs = ms(now);
  let total = 0;
  for (const i of intervals) {
    const from = startOfLocalDay(fromDate, i.timeZone);
    const to = startOfLocalDay(toDate, i.timeZone);
    const overlap = Math.min(intervalEndMs(i, nowMs), to) - Math.max(ms(i.startedAt), from);
    if (overlap > 0) total += overlap;
  }
  return total;
}
