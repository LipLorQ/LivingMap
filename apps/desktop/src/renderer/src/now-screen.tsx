import type {
  ActionDto,
  CalendarEventDto,
  CalendarSnapshotDto,
  CurrentViewDto,
  WhyNowReasonDto,
} from "@living-map/contracts";
import { useEffect, useState } from "react";
import { PlanSection } from "./proposals";

const WHY_NOW_LOCAL: Record<WhyNowReasonDto["kind"], string> = {
  "first-in-plan": "Первое действие в подтверждённом порядке.",
  "previous-done": "Предыдущие действия по порядку уже выполнены.",
  "previous-blocked": "Предыдущие действия по порядку заблокированы.",
};

/** The cached snapshot can be stale (a failed refresh keeps the last good one): never show an
 * event that has already ended as "next" just because it happens to be first in the array.
 * All-day events have no real clock time (see CalendarEventDtoSchema), so they're excluded from
 * this timed, compact preview. */
function pickNextTimedEvents(events: readonly CalendarEventDto[], count: number): CalendarEventDto[] {
  const nowMs = Date.now();
  return events
    .filter((e) => !e.allDay && new Date(e.end).getTime() > nowMs)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, count);
}

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function formatEventTimeRange(event: CalendarEventDto): string {
  const start = new Date(event.start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const end = new Date(event.end).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${start}–${end}`;
}

/** Groups consecutive events by calendar date without collapsing non-adjacent same-date runs —
 * events already arrive sorted by start time, so a date only ever occupies one run. */
function groupByDate(events: readonly CalendarEventDto[]): { date: string; events: CalendarEventDto[] }[] {
  const groups: { date: string; events: CalendarEventDto[] }[] = [];
  for (const event of events) {
    const date = formatEventDate(event.start);
    const last = groups[groups.length - 1];
    if (last?.date === date) last.events.push(event);
    else groups.push({ date, events: [event] });
  }
  return groups;
}

function formatRelative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Above this age the snapshot may no longer reflect reality (ARCHITECTURE §32: "не притворяться,
 * что календарь актуален") — worth a visible nudge to refresh, not just a quietly aging timestamp. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/** The screen only otherwise re-renders on a state change or a command result; without this tick,
 * "обновлён только что" and the "next events" list (which drops events as they end) would silently
 * go stale while the app just sits open. */
function useClockTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function CurrentActionCard({
  action,
  reason,
  planRationale,
}: {
  action: ActionDto | undefined;
  reason: WhyNowReasonDto;
  planRationale: string | null;
}) {
  if (!action) {
    // The plan referenced an id no longer in the current view — defensive, should not happen in practice.
    return <p data-testid="now-action-missing">Действие из порядка не найдено — обновите Живую карту.</p>;
  }
  return (
    <div data-testid="now-action" data-id={action.id} className="space-y-2">
      <h2 className="text-base font-semibold">Сейчас</h2>
      <p className="text-lg font-medium">{action.title}</p>
      <p data-testid="now-done-when" className="text-neutral-700">
        <span className="font-medium">Готово, когда: </span>
        {action.doneWhen || "—"}
      </p>
      <p data-testid="now-why" className="text-neutral-700">
        <span className="font-medium">Почему сейчас: </span>
        {WHY_NOW_LOCAL[reason.kind]}
      </p>
      {planRationale && (
        <details>
          <summary className="cursor-pointer font-medium text-neutral-600">Подробнее о логике</summary>
          <p data-testid="now-why-rationale" className="whitespace-pre-wrap">
            {planRationale}
          </p>
        </details>
      )}
    </div>
  );
}

function NeedsAiReplan() {
  return (
    <div data-testid="now-needs-replan" className="space-y-1 rounded border-2 border-amber-400 bg-amber-50 p-3">
      <p className="font-semibold">Текущий порядок больше не подходит к реальности.</p>
      <p className="text-neutral-700">
        Попроси ИИ перестроить порядок действий — открой подключённый ИИ и попроси предложить новый маршрут.
      </p>
    </div>
  );
}

function CalendarSection({
  snapshot,
  onConnect,
  onRefresh,
  onDisconnect,
}: {
  snapshot: CalendarSnapshotDto;
  onConnect: (icalUrl: string) => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  onDisconnect: () => Promise<unknown>;
}) {
  const [icalUrl, setIcalUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useClockTick(60_000);
  const guarded = (action: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      const result = await action();
      const value = (result as { ok?: boolean; value?: CalendarSnapshotDto } | undefined) ?? {};
      // Only clear the pasted link once it actually connected — a typo/rejected link should stay in
      // the input so the user does not have to paste it again (the orchestrator returns `ok: true`
      // with `lastError` set even when the candidate feed failed).
      if (value.ok && value.value?.connected && !value.value.lastError) setIcalUrl("");
    } finally {
      setBusy(false);
    }
  };
  const upcoming = pickNextTimedEvents(snapshot.events, 2);
  const isStale = snapshot.syncedAt !== null && Date.now() - new Date(snapshot.syncedAt).getTime() > STALE_AFTER_MS;
  const upcomingGroups = groupByDate(upcoming);

  return (
    <section data-testid="calendar" className="space-y-2 rounded border p-3">
      <h3 className="font-semibold">Календарь</h3>
      {!snapshot.connected ? (
        <div className="space-y-2">
          <p data-testid="calendar-disconnected" className="text-neutral-600">
            Календарь не подключён
          </p>
          <p className="text-xs text-neutral-500">
            Возьми «Закрытый адрес в формате iCal» в настройках Google Календаря.
          </p>
          {snapshot.lastError && <p data-testid="calendar-error">{snapshot.lastError}</p>}
          <div className="flex gap-2">
            <input
              data-testid="calendar-ical-url"
              className="flex-1 rounded border px-2 py-1"
              placeholder="Вставь закрытую iCal-ссылку"
              value={icalUrl}
              onChange={(e) => setIcalUrl(e.target.value)}
            />
            <button
              type="button"
              data-testid="calendar-connect"
              disabled={busy || icalUrl.trim().length === 0}
              onClick={guarded(() => onConnect(icalUrl.trim()))}
            >
              Подключить календарь
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p data-testid="calendar-connected" className="text-neutral-600">
            Календарь подключён
          </p>
          {upcoming.length > 0 ? (
            <div data-testid="calendar-upcoming" className="space-y-1">
              <p className="font-medium">Ближайшие события</p>
              {upcomingGroups.map((group) => (
                <div key={group.date}>
                  <p className="text-xs text-neutral-500">{group.date}</p>
                  {group.events.map((event) => (
                    <p key={event.id} data-testid="calendar-upcoming-event">
                      {formatEventTimeRange(event)} · {event.title || "(без названия)"}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p data-testid="calendar-next-event-empty" className="text-neutral-600">
              Ближайших событий нет.
            </p>
          )}
          <p data-testid="calendar-sync-status" className="text-xs text-neutral-500">
            {snapshot.syncedAt
              ? `Календарь обновлён ${formatRelative(snapshot.syncedAt)}`
              : "Календарь ещё не обновлялся"}
          </p>
          {isStale && (
            <p data-testid="calendar-stale" className="text-xs text-amber-700">
              Данные календаря могли устареть — нажми «Обновить».
            </p>
          )}
          {snapshot.lastError && <p data-testid="calendar-error">{snapshot.lastError}</p>}
          <div className="flex gap-2">
            <button type="button" data-testid="calendar-refresh" disabled={busy} onClick={guarded(onRefresh)}>
              Обновить
            </button>
            <button type="button" data-testid="calendar-disconnect" disabled={busy} onClick={guarded(onDisconnect)}>
              Отключить календарь
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function NowScreen({
  view,
  onConnectCalendar,
  onRefreshCalendar,
  onDisconnectCalendar,
}: {
  view: CurrentViewDto;
  onConnectCalendar: (icalUrl: string) => Promise<unknown>;
  onRefreshCalendar: () => Promise<unknown>;
  onDisconnectCalendar: () => Promise<unknown>;
}) {
  const [showOrder, setShowOrder] = useState(false);
  const actionsById = new Map(view.stages.flatMap((s) => s.actions).map((a) => [a.id, a]));

  return (
    <div data-testid="now-screen" className="space-y-4">
      <section data-testid="now-season" className="rounded border p-3">
        <p className="text-sm text-neutral-500">Фокус сезона</p>
        <p className="font-medium">{view.season?.focus || "Сезон ещё не задан — заполни его на вкладке «Замысел»."}</p>
      </section>

      <section className="rounded border-2 border-blue-300 bg-blue-50 p-3">
        {!view.intention ? (
          <p data-testid="now-empty">Пока нет активного Замысла. Начни с вкладки «Замысел».</p>
        ) : view.needsAiReplan || !view.currentAction ? (
          <NeedsAiReplan />
        ) : (
          <CurrentActionCard
            action={actionsById.get(view.currentAction.actionId)}
            reason={view.currentAction.reason}
            planRationale={view.currentAction.planRationale}
          />
        )}
      </section>

      <CalendarSection
        snapshot={view.calendarSnapshot}
        onConnect={onConnectCalendar}
        onRefresh={onRefreshCalendar}
        onDisconnect={onDisconnectCalendar}
      />

      {view.intention && (
        <section className="rounded border p-3">
          <button type="button" data-testid="now-toggle-order" onClick={() => setShowOrder((v) => !v)}>
            {showOrder ? "Скрыть порядок действий" : "Показать порядок действий"}
          </button>
          {showOrder && (
            <PlanSection
              plan={view.orderedActionPlan}
              stages={view.stages}
              unplannedActionIds={view.unplannedActionIds}
            />
          )}
        </section>
      )}
    </div>
  );
}
