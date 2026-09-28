// Composition for the Calendar boundary (ARCHITECTURE §32): the only place that holds the private
// iCal feed URL (Stage 4 iCal decision). Application/domain and MCP never see it — they only ever
// read the CalendarSnapshotDto this orchestrator persists via the normal saveCalendarSnapshot command.
import type { Actor, Application } from "@living-map/application";
import { type CalendarSnapshotDto, ok, type Result } from "@living-map/contracts";
import {
  CalendarAuthError,
  type CalendarProvider,
  createIcalCalendarProvider,
  type RawCalendarSnapshot,
  type SecretStore,
} from "@living-map/integrations-ical-calendar";
import { createSafeStorageSecretStore } from "./secret-store";

const DISCONNECTED: CalendarSnapshotDto = {
  connected: false,
  syncedAt: null,
  source: null,
  timeZone: null,
  events: [],
  lastError: null,
};

function toDto(raw: RawCalendarSnapshot, now: string): CalendarSnapshotDto {
  return {
    connected: true,
    syncedAt: now,
    source: "ical",
    timeZone: raw.timeZone,
    events: raw.events.map((e) => ({ ...e })),
    lastError: null,
  };
}

function sanitize(error: unknown, context: "connect" | "refresh"): string {
  if (error instanceof CalendarAuthError) return "Секретная ссылка отклонена; вставь актуальную";
  return context === "connect" ? "Не удалось подключить календарь" : "Не удалось обновить календарь";
}

/** A `SecretStore` wrapping one fixed candidate URL — used to test a not-yet-saved link without
 * touching the real store (Stage 4 iCal decision §6: the old working secret survives a bad one). */
function candidateSecretStore(url: string): SecretStore {
  return { load: () => url, save: () => {}, clear: () => {} };
}

/**
 * Real dependencies default; `deps` lets tests substitute a fake `SecretStore` and a fake
 * `CalendarProvider` factory without touching Electron `safeStorage` or the network.
 */
export function createCalendarOrchestrator(
  app: Application,
  dataHome: string,
  deps: {
    secretStore?: SecretStore;
    createProvider?: (secretStore: SecretStore) => CalendarProvider;
    now?: () => string;
  } = {},
) {
  const secretStore = deps.secretStore ?? createSafeStorageSecretStore(dataHome);
  const createProvider =
    deps.createProvider ?? ((store: SecretStore) => createIcalCalendarProvider({ secretStore: store }));
  const now = deps.now ?? (() => new Date().toISOString());

  function persist(dto: CalendarSnapshotDto, actor: Actor): Result<CalendarSnapshotDto> {
    return app.commands.saveCalendarSnapshot(app.newContext(actor, "ipc"), dto);
  }

  function currentSnapshot(): CalendarSnapshotDto {
    const view = app.queries.getCurrentView();
    return view.ok ? view.value.calendarSnapshot : DISCONNECTED;
  }

  async function doRefresh(store: SecretStore, actor: Actor): Promise<Result<CalendarSnapshotDto>> {
    try {
      const raw = await createProvider(store).refresh();
      return persist(toDto(raw, now()), actor);
    } catch (error) {
      if (error instanceof CalendarAuthError) {
        secretStore.clear();
        return persist({ ...DISCONNECTED, lastError: sanitize(error, "refresh") }, actor);
      }
      // A transient failure (network, rate limit) keeps the last good snapshot instead of
      // discarding it — truthful (`lastError` set), not destructive (Stage 4 §10).
      return persist({ ...currentSnapshot(), lastError: sanitize(error, "refresh") }, actor);
    }
  }

  return {
    /**
     * Validates the candidate feed by fetching it BEFORE persisting anything (Stage 4 iCal decision
     * §6): a bad new link never overwrites an old working one, and never disconnects it either.
     */
    connect: async (icalUrl: string): Promise<Result<CalendarSnapshotDto>> => {
      try {
        const raw = await createProvider(candidateSecretStore(icalUrl)).refresh();
        secretStore.save(icalUrl);
        return persist(toDto(raw, now()), "user-ui");
      } catch (error) {
        return persist({ ...currentSnapshot(), lastError: sanitize(error, "connect") }, "user-ui");
      }
    },

    /** `actor` defaults to the user's own "Обновить" click; the unattended launch refresh passes
     * "system" (ARCHITECTURE §19) so the change history/audit trail does not misattribute it. */
    refresh: async (actor: Actor = "user-ui"): Promise<Result<CalendarSnapshotDto>> => {
      if (secretStore.load()) return doRefresh(secretStore, actor);
      const previous = currentSnapshot();
      // Never connected: nothing changed, nothing to report — not an error state.
      if (!previous.connected) return ok(previous);
      // Was connected, but the secret file is now gone/undecryptable (deleted, moved data home,
      // etc.): a truthful disconnect instead of silently keeping a stale "connected: true" forever
      // (Stage 4 §10/§11; carried over from the independent review of the OAuth version).
      return persist({ ...DISCONNECTED, lastError: "Доступ к календарю потерян; подключи заново" }, actor);
    },

    disconnect: async (): Promise<Result<CalendarSnapshotDto>> => {
      secretStore.clear();
      return persist(DISCONNECTED, "user-ui");
    },
  };
}

export type CalendarOrchestrator = ReturnType<typeof createCalendarOrchestrator>;
