import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Application } from "@living-map/application";
import type { CalendarSnapshotDto } from "@living-map/contracts";
import {
  CalendarAuthError,
  type CalendarProvider,
  CalendarProviderError,
  type RawCalendarSnapshot,
  type SecretStore,
} from "@living-map/integrations-ical-calendar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalendarOrchestrator } from "../src/main/calendar/index";

// This suite exists because an independent review of Stage 4's OAuth version found the
// orchestrator's keep-last-good-on-transient-failure / disconnect-on-auth-error / lost-secret logic
// had no coverage beyond the e2e "disconnected" state; that requirement carries over to the iCal
// version. `secretStore`/`createProvider` are injectable exactly so this can be tested without
// Electron `safeStorage` or the network.

let dataHome: string;
beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "living-map-calendar-orchestrator-"));
});
afterEach(() => rmSync(dataHome, { recursive: true, force: true }));

const DISCONNECTED: CalendarSnapshotDto = {
  connected: false,
  syncedAt: null,
  source: null,
  timeZone: null,
  events: [],
  lastError: null,
};

const FEED_URL = "https://calendar.google.com/calendar/ical/secret/private-abc/basic.ics";
const OTHER_FEED_URL = "https://calendar.google.com/calendar/ical/secret/private-xyz/basic.ics";

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

/** Minimal stand-in for `Application`: only the three members the orchestrator actually calls. */
function fakeApp(initial: CalendarSnapshotDto): {
  app: Application;
  current: () => CalendarSnapshotDto;
  saveCount: () => number;
} {
  let snapshot = initial;
  let saves = 0;
  const app = {
    newContext: (actor: string, source: string) => ({
      actor,
      source,
      correlationId: "c1",
      timestamp: "2026-09-28T10:00:00.000Z",
    }),
    commands: {
      saveCalendarSnapshot: (_ctx: unknown, dto: CalendarSnapshotDto) => {
        snapshot = dto;
        saves++;
        return { ok: true as const, value: dto };
      },
    },
    queries: {
      getCurrentView: () => ({ ok: true as const, value: { calendarSnapshot: snapshot } }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: deliberately partial test double
  } as any as Application;
  return { app, current: () => snapshot, saveCount: () => saves };
}

const previouslySynced: CalendarSnapshotDto = {
  connected: true,
  syncedAt: "2026-09-28T08:00:00.000Z",
  source: "ical",
  timeZone: "UTC",
  events: [
    {
      id: "e1",
      title: "Старое событие",
      start: "2026-09-28T09:00:00.000Z",
      end: "2026-09-28T09:30:00.000Z",
      timeZone: "UTC",
      allDay: false,
    },
  ],
  lastError: null,
};

/** `createProvider` in these tests dispatches on which URL the injected `SecretStore` returns, so
 * a single fake can represent "this feed works" vs "that one fails" for both connect and refresh. */
function providerFor(behavior: Record<string, CalendarProvider>): (secretStore: SecretStore) => CalendarProvider {
  return (secretStore) => {
    const url = secretStore.load();
    const chosen = url ? behavior[url] : undefined;
    return (
      chosen ?? {
        isConnected: () => false,
        refresh: async () => {
          throw new CalendarProviderError("unknown feed");
        },
      }
    );
  };
}

const workingProvider = (raw: RawCalendarSnapshot): CalendarProvider => ({
  isConnected: () => true,
  refresh: async () => raw,
});

describe("createCalendarOrchestrator.refresh", () => {
  it("a transient failure keeps the last good snapshot and only adds a truthful error", async () => {
    const { app, current } = fakeApp(previouslySynced);
    const orchestrator = createCalendarOrchestrator(app, dataHome, {
      secretStore: fakeSecretStore(FEED_URL),
      createProvider: (): CalendarProvider => ({
        isConnected: () => true,
        refresh: async () => {
          throw new CalendarProviderError("network down");
        },
      }),
    });

    const result = await orchestrator.refresh();
    expect(result).toMatchObject({ ok: true, value: { connected: true, lastError: "Не удалось обновить календарь" } });
    expect(current().events).toEqual(previouslySynced.events); // not wiped
    expect(current().syncedAt).toBe(previouslySynced.syncedAt); // not bumped: this refresh did not succeed
  });

  it("an auth error (feed rejected) disconnects, clears the secret, and discards stale events", async () => {
    const secretStore = fakeSecretStore(FEED_URL);
    const { app, current } = fakeApp(previouslySynced);
    const orchestrator = createCalendarOrchestrator(app, dataHome, {
      secretStore,
      createProvider: (): CalendarProvider => ({
        isConnected: () => true,
        refresh: async () => {
          throw new CalendarAuthError("revoked");
        },
      }),
    });

    const result = await orchestrator.refresh();
    expect(result).toEqual({
      ok: true,
      value: { ...DISCONNECTED, lastError: "Секретная ссылка отклонена; вставь актуальную" },
    });
    expect(current().events).toEqual([]);
    expect(secretStore.load()).toBeNull();
  });

  it("is a no-op when never connected: nothing is persisted", async () => {
    const { app, saveCount } = fakeApp(DISCONNECTED);
    const orchestrator = createCalendarOrchestrator(app, dataHome, { secretStore: fakeSecretStore(null) });

    const result = await orchestrator.refresh();
    expect(result).toEqual({ ok: true, value: DISCONNECTED });
    expect(saveCount()).toBe(0);
  });

  it("reports a truthful disconnect when the secret is lost after having been connected (not a silent stale 'connected: true')", async () => {
    const { app, current } = fakeApp(previouslySynced); // app still thinks it's connected
    const orchestrator = createCalendarOrchestrator(app, dataHome, { secretStore: fakeSecretStore(null) }); // secret gone

    const result = await orchestrator.refresh();
    expect(result.ok).toBe(true);
    expect(current()).toMatchObject({ connected: false, lastError: "Доступ к календарю потерян; подключи заново" });
  });
});

describe("createCalendarOrchestrator.connect", () => {
  it("validates the candidate feed before saving it, then performs an initial refresh", async () => {
    const raw: RawCalendarSnapshot = {
      timeZone: "Europe/Moscow",
      events: [
        {
          id: "e2",
          title: "Созвон",
          start: "2026-09-28T12:00:00.000Z",
          end: "2026-09-28T12:30:00.000Z",
          timeZone: "Europe/Moscow",
          allDay: false,
        },
      ],
    };
    const secretStore = fakeSecretStore(null);
    const { app, current } = fakeApp(DISCONNECTED);
    const orchestrator = createCalendarOrchestrator(app, dataHome, {
      secretStore,
      createProvider: providerFor({ [FEED_URL]: workingProvider(raw) }),
      now: () => "2026-09-28T10:00:00.000Z",
    });

    const result = await orchestrator.connect(FEED_URL);
    expect(result).toEqual({
      ok: true,
      value: {
        connected: true,
        syncedAt: "2026-09-28T10:00:00.000Z",
        source: "ical",
        timeZone: "Europe/Moscow",
        events: raw.events,
        lastError: null,
      },
    });
    expect(current().connected).toBe(true);
    expect(secretStore.load()).toBe(FEED_URL); // persisted for future refreshes
  });

  it("a candidate feed that fails to fetch/parse never reports connected, with a truthful (not raw) error", async () => {
    const secretStore = fakeSecretStore(null);
    const { app, current } = fakeApp(DISCONNECTED);
    const orchestrator = createCalendarOrchestrator(app, dataHome, {
      secretStore,
      createProvider: (): CalendarProvider => ({
        isConnected: () => false,
        refresh: async () => {
          throw new CalendarProviderError(`could not fetch ${FEED_URL}: 404`);
        },
      }),
    });

    const result = await orchestrator.connect(FEED_URL);
    expect(result).toEqual({ ok: true, value: { ...DISCONNECTED, lastError: "Не удалось подключить календарь" } });
    expect(current().connected).toBe(false);
    expect(secretStore.load()).toBeNull(); // the failed candidate was never saved
    // The raw error text (which could contain the URL) never reaches the persisted state.
    expect(JSON.stringify(current())).not.toContain(FEED_URL);
  });

  it("a failing new link never overwrites or disconnects an already-working old one", async () => {
    const secretStore = fakeSecretStore(FEED_URL);
    const { app, current } = fakeApp(previouslySynced);
    const orchestrator = createCalendarOrchestrator(app, dataHome, {
      secretStore,
      createProvider: providerFor({
        [FEED_URL]: workingProvider({ timeZone: "UTC", events: previouslySynced.events }),
      }), // OTHER_FEED_URL has no entry: falls back to a rejecting provider
    });

    const result = await orchestrator.connect(OTHER_FEED_URL);
    expect(result).toMatchObject({
      ok: true,
      value: { connected: true, lastError: "Не удалось подключить календарь" },
    });
    expect(current().events).toEqual(previouslySynced.events); // old snapshot preserved
    expect(secretStore.load()).toBe(FEED_URL); // old secret preserved, candidate discarded
  });
});

describe("createCalendarOrchestrator.disconnect", () => {
  it("clears the secret and persists a clean disconnected snapshot", async () => {
    const secretStore = fakeSecretStore(FEED_URL);
    const { app, current } = fakeApp(previouslySynced);
    const orchestrator = createCalendarOrchestrator(app, dataHome, { secretStore });

    const result = await orchestrator.disconnect();
    expect(result).toEqual({ ok: true, value: DISCONNECTED });
    expect(current()).toEqual(DISCONNECTED);
    expect(secretStore.load()).toBeNull();
  });
});
