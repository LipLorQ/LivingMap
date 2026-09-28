/**
 * The private iCal feed URL is a credential (Stage 4 iCal decision): it grants read access to the
 * user's private Calendar. Never stored in a plain domain table, never sent to the renderer after
 * submission. The real implementation (Electron `safeStorage`) lives in apps/desktop/src/main —
 * this package only depends on the interface, so it stays testable and Electron-free.
 */
export interface SecretStore {
  load(): string | null;
  save(url: string): void;
  clear(): void;
}

export type RawCalendarEvent = {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  /** The feed gave only a date, not a date-time: `start`/`end` are UTC-midnight anchors for sorting
   * only, not real instants — never show them as a clock time or treat them as a hard time boundary. */
  readonly allDay: boolean;
};

export type RawCalendarSnapshot = {
  readonly timeZone: string;
  readonly events: readonly RawCalendarEvent[];
};

/** The stored feed URL was rejected (invalid, rotated or disabled) — the user must reconnect. */
export class CalendarAuthError extends Error {}

/** Any other failure (network, timeout, malformed feed, oversized response) — the last good snapshot is still valid. */
export class CalendarProviderError extends Error {}

export interface CalendarProvider {
  /** Not connected yet (no feed URL saved) — distinct from a fetch failure. */
  isConnected(): boolean;
  /** Fetches and parses the feed. Never mutates anything. */
  refresh(): Promise<RawCalendarSnapshot>;
}
