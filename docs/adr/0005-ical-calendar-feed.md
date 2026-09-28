# ADR-0005 — Приватный iCal-фид вместо Google OAuth для календаря MVP

**Статус:** принято (Этап 4, 28.09.2026)
**Уточняет:** ARCHITECTURE.md §32–33; DEVELOPMENT_PLAN.md §4.6, Этап 4

## Контекст

Этап 4 реализовал чтение Google Calendar через OAuth 2.0 (loopback redirect + PKCE, без client secret) — стандартный поток Google для desktop-приложений, полностью пройденный через Biome/typecheck/тесты/независимый review. Реальная проверка подключения показала продуктовое ограничение: получение собственного OAuth Client ID для приложения на реальном аккаунте пользователя требует Google Cloud billing/платёжного/налогового профиля. Это неприемлемо для локального read-only MVP одного пользователя (DEVELOPMENT_PLAN.md §2: «не требует облачной синхронизации», «не требует аккаунта» — избыточная инфраструктура ради самого факта аутентификации).

У пользователя уже есть работающий канал: Google Calendar отдаёт «Закрытый адрес в формате iCal» — приватную ссылку на `.ics`-фид того же календаря, доступную без OAuth-приложения.

## Решение

Заменить только внешний механизм получения календарных данных. Архитектурная граница `CalendarProvider` (ARCHITECTURE §32) и её место в системе не меняются:

```ts
interface CalendarProvider {
  refresh(): Promise<CalendarSnapshot>
}
```

### 1. Пакет

`@living-map/integrations-google-calendar` → `@living-map/integrations-ical-calendar`. Внутреннее имя отражает реальный механизм (iCal); UI по-прежнему говорит «Google Calendar» пользователю, потому что фид объективно из Google Calendar — расхождение имени и UI-текста осознанное (DEVELOPMENT_PLAN.md §12 брифа замены).

Парсинг RFC 5545 (включая recurrence/RRULE/EXDATE/VTIMEZONE) выполняет `ical.js` (zero runtime dependencies, официальные TS-типы) — писать recurrence-движок вручную было бы явным переусложнением для MVP.

### 2. Секрет

Приватный iCal URL — credential (даёт read-доступ к приватному календарю), а не публичная конфигурация (в отличие от прежнего OAuth Client ID, который был неконфиденциален по гайду Google для desktop-клиентов). Поэтому:

- хранится только через Electron `safeStorage` (`apps/desktop/src/main/calendar/secret-store.ts`, файл `calendar-feed.enc` рядом с `living-map.sqlite`, как раньше `google-calendar-tokens.enc`);
- никогда не в `config.json`, ни в одной обычной domain-таблице, ни в change_log;
- renderer передаёт его один раз через типизированный IPC-command (`connectCalendar`) и никогда не получает обратно — `CalendarSnapshotDto` не содержит и не содержал URL/токены;
- MCP не получает к нему доступ ни в каком виде (не изменилось: MCP и раньше не видел OAuth-токены, только `CalendarSnapshotDto` через planning context).

### 3. Валидация и порядок замены секрета

Входной IPC-контракт (`ConnectCalendarInputSchema`, `packages/contracts/src/calendar.ts`) требует https-схему, непустой host, без пробельных/управляющих символов, разумный максимум длины — не привязано к домену Google. `CalendarOrchestrator.connect` (`apps/desktop/src/main/calendar/index.ts`) сначала пробует получить и распарсить кандидата через эфемерный `SecretStore`, и только при успехе сохраняет URL и снимок — старый рабочий секрет и старый снимок переживают неудачную попытку подключить новый (не перетираются).

### 4. Fetch и парсинг (`packages/integrations-ical-calendar/src/ical-provider.ts`)

- запрос только из Electron main (как раньше OAuth/REST-вызовы), не из renderer;
- таймаут (15с) через `AbortController`;
- потоковое ограничение размера ответа (5 МБ) — защита от resource abuse, не общая capability для скачивания произвольных URL;
- 401/403/404/410 → `CalendarAuthError` (секрет отклонён/отозван — предлагаем переподключить, как раньше `invalid_grant`); прочие сбои/недоступность → `CalendarProviderError` (временный сбой — оркестратор сохраняет последний хороший снимок, ARCHITECTURE §10, не изменилось);
- парсинг через `ICAL.parse` — чистый текстовый парсер, ничего не исполняет и не рендерит как HTML (заголовки событий и в renderer выводятся как обычный текст React, не `dangerouslySetInnerHTML`).

### 5. Recurrence и часовые пояса

Recurring VEVENT разворачиваются в конкретные occurrences в ограниченном горизонте (21 день — «несколько недель», ARCHITECTURE §32/DEVELOPMENT_PLAN §4.6: собственная календарная сетка не нужна, только read) с явным потолком итераций на серию — защита от неограниченного `FREQ` без `UNTIL`/`COUNT`. Поддержаны `RRULE` (`COUNT`, `UNTIL`), `EXDATE`, per-occurrence переопределения и отмены через `RECURRENCE-ID` + `STATUS:CANCELLED`, `VTIMEZONE` (регистрируется в `ICAL.TimezoneService` перед разворачиванием). All-day события остаются UTC-полуночным сортировочным якорем (`allDay: true`), не превращаются в реальную границу времени — тот же принцип, что уже был закреплён для Google JSON API (ARCHITECTURE §32, независимый review предыдущей версии).

### 6. Отключение

`disconnect()` полностью очищает секрет и возвращает снимок к дисконнекту (события очищаются) — то же простое честное поведение, что было у OAuth-версии, а не «протухший, но connected: true» (ARCHITECTURE §10/§11 брифа замены).

## Последствия

- Полностью удалён OAuth/PKCE/loopback-сервер код (`oauth.ts`, `pkce.ts`, `oauth-flow.ts`) — один путь подключения календаря, без второй «на всякий случай» реализации.
- IPC-команды переименованы: `connectGoogleCalendar`/`disconnectGoogleCalendar` → `connectCalendar`/`disconnectCalendar`; вход — `icalUrl`, не `clientId`.
- `CalendarSnapshotDto.source` — литерал `"ical"` вместо `"google"` (техническое поле, не показывается пользователю напрямую).
- Будущая замена на Google OAuth API или другой источник календаря — это снова только замена `CalendarProvider`, без изменений в domain/application/UI-контракте (ARCHITECTURE §32, №47 «будущая переносимость»).
