import { z } from "zod";

/** One event read from the external calendar. Read-only: LivingMap never creates/edits/deletes these. */
export const CalendarEventDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  /** The calendar's own timezone, kept alongside the UTC instants (ARCHITECTURE §18). */
  timeZone: z.string(),
  /** The feed gave only a date: `start`/`end` are UTC-midnight sort anchors, not real clock times —
   * never render them as a time or treat them as a hard time boundary. */
  allDay: z.boolean(),
});
export type CalendarEventDto = z.infer<typeof CalendarEventDtoSchema>;

/**
 * The LivingMap-owned read model of the external calendar (ARCHITECTURE §32). `connected` is false
 * until the user connects their private iCal feed; `lastError` is a truthful, sanitized message
 * (never a raw provider error or the feed URL) shown instead of pretending stale data is fresh.
 */
export const CalendarSnapshotDtoSchema = z.object({
  connected: z.boolean(),
  syncedAt: z.iso.datetime().nullable(),
  source: z.literal("ical").nullable(),
  timeZone: z.string().nullable(),
  events: z.array(CalendarEventDtoSchema),
  lastError: z.string().nullable(),
});
export type CalendarSnapshotDto = z.infer<typeof CalendarSnapshotDtoSchema>;

const MAX_ICAL_URL_LENGTH = 2000;

/**
 * https-only (literal `https://` scheme, so `javascript:`/`data:`/`file:` and bare hostnames are
 * rejected), a non-empty host, and no whitespace/control characters. Deliberately not a full URL
 * parser: contracts stays a dependency-free leaf (no `URL` global assumed — this file is
 * typechecked as source by packages with no DOM/Node lib), and this is enough to satisfy the
 * security requirement (Stage 4 iCal decision §6) without being Google-domain-specific.
 */
const HTTPS_URL_PATTERN = /^https:\/\/[^\s/][^\s]*$/i;

/** The user's private "Закрытый адрес в формате iCal" (Stage 4 iCal decision). */
export const ConnectCalendarInputSchema = z.strictObject({
  icalUrl: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ICAL_URL_LENGTH)
    .refine((value) => HTTPS_URL_PATTERN.test(value), "Ссылка должна быть в формате https://"),
});
export type ConnectCalendarInput = z.infer<typeof ConnectCalendarInputSchema>;
