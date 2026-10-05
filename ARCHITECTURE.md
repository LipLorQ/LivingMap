# Живая карта — архитектура локального MVP

**Статус:** каноническая техническая архитектура  
**Версия:** 1.0  
**Зафиксировано:** 27 сентября 2026  
**Связанный план:** `DEVELOPMENT_PLAN.md` v3.0  
**Текущий рабочий этап:** Архитектура

---

# 0. Назначение документа

Этот документ определяет технический чертёж локального MVP «Живой карты».

Он отвечает на вопросы:

- какие процессы существуют;
- где живёт бизнес-логика;
- кто владеет данными;
- как UI работает с данными;
- как Claude / другой ИИ работает с Живой картой через MCP;
- что ИИ может менять автоматически;
- что требует подтверждения пользователя;
- как Electron и MCP безопасно используют одну локальную SQLite;
- как оставить возможность будущего web/mobile/cloud-продукта, не строя его сейчас.

Этот документ **не является планом функций**. Порядок разработки задаёт `DEVELOPMENT_PLAN.md`.

Если старый `PRODUCT_SPEC.md` или старые технические документы противоречат `DEVELOPMENT_PLAN.md` v3.0 или этому файлу, старые технические решения считаются устаревшими.

---

# 1. Архитектурная цель

Нужно получить максимально простую локальную систему:

> **один Windows-компьютер → одно desktop-приложение → одна локальная база → внешний ИИ через MCP → никакого постоянно работающего сервера.**

При этом нельзя зашить продукт так, чтобы:

- бизнес-логика зависела от Electron;
- домен зависел от SQLite;
- продукт зависел от Claude;
- MCP был единственным способом работать с системой;
- будущий web/mobile потребовал переписать саму механику Живой карты.

Главное правило архитектуры:

> **Стабильным является продуктовый смысл. Заменяемыми являются интерфейс, хранилище, транспорт и конкретный ИИ.**

---

# 2. Не-цели архитектуры

Сейчас сознательно НЕ строим:

- сервер;
- аккаунты;
- авторизацию пользователей;
- облачную БД;
- синхронизацию между устройствами;
- web-клиент;
- mobile-клиент;
- multi-user;
- collaboration;
- подписки и оплату;
- собственный AI chat (большой экран чата; универсальный `+` — не чат, см. §34);
- собственную LLM;
- API OpenAI / Anthropic (ИИ изнутри приложения — через установленный ИИ-host по подписке, §5.5, ADR-0007);
- удалённый MCP;
- vector database;
- сложный RAG;
- микросервисы;
- event sourcing;
- Kafka / очереди;
- GraphQL;
- отдельный Python backend;
- plugin architecture;
- background service, живущий 24/7.

---

# 3. Зафиксированный технологический фундамент

- Electron
- React
- TypeScript
- Vite
- React Router
- Tailwind CSS
- shadcn/ui
- SQLite
- Drizzle ORM
- Zod
- MCP TypeScript SDK
- Vitest
- Playwright
- pnpm
- Biome

Архитектура не зависит от конкретного SQLite-driver. Драйвер выбирается при создании skeleton после короткой проверки совместимости текущих версий Electron + Node + Drizzle.

Требование к выбранному драйверу:

- стабильная работа на Windows x64;
- нормальная работа внутри Electron main process;
- поддержка транзакций;
- WAL;
- короткие конкурентные записи из двух локальных процессов;
- совместимость с Drizzle;
- отсутствие необходимости поднимать отдельный процесс БД.

---

# 4. Главная схема процессов

```text
┌──────────────────────────────────────────────────────────────┐
│                       ПОЛЬЗОВАТЕЛЬ                           │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                │ работает                    │ разговаривает
                ▼                              ▼
┌─────────────────────────┐        ┌───────────────────────────┐
│      Electron App       │        │ Claude / MCP-совместимый │
│                         │        │         AI host           │
│  React Renderer         │        └─────────────┬─────────────┘
│        │ IPC            │                      │ stdio
│  Preload Bridge         │                      ▼
│        │                │        ┌───────────────────────────┐
│  Electron Main          │        │   Local MCP Process       │
└──────────┬──────────────┘        └─────────────┬─────────────┘
           │                                     │
           │ imports                             │ imports
           ▼                                     ▼
┌──────────────────────────────────────────────────────────────┐
│                   APPLICATION LAYER                          │
│  use cases • commands • queries • permissions • proposals    │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                       DOMAIN                                 │
│     продуктовые правила • состояния • переходы • policies    │
└──────────────────────────┬───────────────────────────────────┘
                           │ ports
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                 PERSISTENCE ADAPTER                          │
│                  Drizzle + SQLite                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
                 living-map.sqlite
```

Ключевой момент:

**Electron Main и локальный MCP являются двумя входами в одну и ту же application/domain-логику.**

Ни UI, ни MCP не имеют права обходить application layer и менять SQLite напрямую.

---

# 5. Процессы

## 5.1. Electron Renderer

Задача:

- показывать интерфейс;
- собирать пользовательский ввод;
- отправлять команды;
- запрашивать read models;
- показывать ошибки / конфликты / запросы подтверждения.

Renderer НЕ имеет:

- Node.js filesystem access;
- прямого SQLite access;
- Google OAuth secrets;
- прямого MCP access;
- бизнес-правил изменения доменных сущностей.

Renderer хранит только временное UI-состояние.

Источник истины — локальная БД через application layer.

---

## 5.2. Electron Preload

Preload — узкий безопасный мост.

Он экспортирует renderer только типизированный API:

```ts
window.livingMap.query(...)
window.livingMap.command(...)
window.livingMap.subscribe(...)
```

Не экспортировать:

- `ipcRenderer` целиком;
- filesystem;
- shell;
- произвольные каналы;
- SQL;
- Node APIs.

Все входы валидируются на стороне main process.

---

## 5.3. Electron Main

Main process:

- создаёт окно;
- владеет desktop lifecycle;
- открывает SQLite для desktop-приложения;
- запускает migrations;
- создаёт application services;
- обслуживает IPC;
- позже синхронизирует Google Calendar;
- обнаруживает изменение БД, сделанное MCP;
- по требованию запускает ИИ-host для разбора записей `+` (§5.5);
- закрывает ресурсы при завершении приложения.

Main process не содержит продуктовую механику внутри IPC handlers.

IPC handler вызывает application use case.

---

## 5.4. Local MCP Process

Это отдельный Node-процесс без зависимости от Electron.

Он запускается MCP-host'ом через `stdio`.

Он:

- находит локальную БД;
- проверяет совместимость schema version;
- открывает отдельное SQLite connection;
- поднимает те же application services;
- экспонирует разрешённые MCP resources/tools;
- завершается вместе с MCP-сессией.

Он НЕ:

- слушает TCP-порт;
- работает постоянно;
- запускает migrations;
- пишет SQL напрямую;
- получает стратегические полномочия автоматически.

Если схема БД новее/старее поддерживаемой версии:

> MCP прекращает write-операции и просит сначала открыть/обновить desktop-приложение.

---

## 5.5. ИИ по требованию изнутри приложения (Этап 6, ADR-0007)

Electron Main может по требованию запустить ИИ-host, чтобы разобрать запись `+`. Граница — порт
application-слоя `AiRunner`; первый адаптер — `ClaudeCodeCliAiRunner` (Claude Code headless, подписка
пользователя), вендорная инфраструктура только в Electron Main.

- Renderer никогда не запускает процессы и не управляет исполняемым файлом или флагами.
- Domain/Application вендор-нейтральны: не знают про Claude, CLI и модели.
- Запущенный ИИ работает с данными только через тот же локальный MCP (`mcp-ai`, §22–24): модель
  AiSurface / Proposal остаётся авторитетной.
- Сырая Capture коммитится до вызова ИИ (§34).
- Постоянного демона нет: процесс живёт только на время разбора.
- Прямых API Anthropic / OpenAI в MVP нет; будущий адаптер реализует тот же `AiRunner`.

---

# 6. Направление зависимостей

Зависимости идут внутрь:

```text
UI / MCP / Integrations
          ↓
     Application
          ↓
        Domain
```

Infrastructure реализует порты, объявленные внутренними слоями:

```text
Domain/Application
      ↑ interfaces
      │
SQLite / Google / OS / MCP adapters
```

Запрещено:

```text
domain → electron
domain → drizzle
domain → sqlite
domain → react
domain → mcp sdk
application → react
renderer → sqlite
mcp tool → sql
```

---

# 7. Слои

## 7.1. Domain

Чистый TypeScript.

Без Electron, React, SQLite, Drizzle, MCP и сетевых библиотек.

Содержит:

- сущности;
- value objects там, где они реально полезны;
- state transitions;
- бизнес-инварианты;
- policy-функции;
- CurrentActionSelector;
- правила определения необходимости подтверждения;
- правила прогресса;
- проверки допустимости переходов.

Предпочтение:

> **простые данные + чистые функции**

вместо глубокой OOP-иерархии.

Не создавать класс на каждое существительное.

---

## 7.2. Application

Оркестрирует домен.

Содержит:

- commands;
- queries;
- use cases;
- authorization / capability policy;
- proposal workflow;
- transaction boundaries;
- repository ports;
- integration ports;
- application errors;
- actor context.

Примеры будущих use cases:

```text
CreateIntention
UpdateIntentionResult
CreateRouteProposal
AcceptProposal
SetOrderedActionPlan
CompleteAction
GetCurrentView
CaptureThought
ProcessCapture
SearchMemory
StartWorkSession
FinishWorkSession
```

Application не знает, пришёл вызов из React или из Claude.

---

## 7.3. Contracts

Общие внешние контракты:

- Zod schemas;
- IPC request/response DTO;
- MCP input/output DTO;
- serialized error contracts;
- read models.

Contracts не являются схемой SQLite.

Никогда не выдавать наружу таблицу БД как публичный контракт.

---

## 7.4. Persistence SQLite

Реализует repository ports.

Отвечает за:

- Drizzle schema;
- migrations;
- transactions;
- mappers;
- optimistic concurrency;
- global revision;
- lightweight change log;
- backup/restore;
- SQLite pragmas.

Не содержит продуктовых решений.

---

## 7.5. Integrations

Каждая внешняя система скрыта за отдельным портом.

Пример:

```ts
interface CalendarProvider {
  refresh(): Promise<CalendarSnapshot>
}
```

Будущий `GoogleCalendarAdapter` реализует этот порт.

Domain не знает, что календарь Google.

---

# 8. Предлагаемая структура репозитория

Использовать pnpm workspace.

```text
living-map/
│
├─ apps/
│  ├─ desktop/
│  │  ├─ src/
│  │  │  ├─ main/
│  │  │  ├─ preload/
│  │  │  └─ renderer/
│  │  └─ ...
│  │
│  └─ mcp/
│     ├─ src/
│     └─ ...
│
├─ packages/
│  ├─ domain/
│  │  └─ src/
│  │
│  ├─ application/
│  │  └─ src/
│  │
│  ├─ contracts/
│  │  └─ src/
│  │
│  └─ persistence-sqlite/
│     └─ src/
│
├─ docs/
│  └─ adr/
│
├─ DEVELOPMENT_PLAN.md
├─ ARCHITECTURE.md
├─ FUTURE_IDEAS.md
├─ package.json
├─ pnpm-workspace.yaml
└─ ...
```

`integrations-google-calendar` добавляется только на соответствующем этапе, а не сейчас.

Не создавать заранее пустые packages для всех будущих возможностей.

---

# 9. Composition roots

Есть два composition root.

## Desktop

```text
Electron main
→ config/path
→ SQLite connection
→ repositories
→ application services
→ IPC handlers
```

## MCP

```text
MCP process
→ config/path
→ SQLite connection
→ repositories
→ application services
→ MCP resources/tools
```

Это позволяет переиспользовать продуктовую логику без создания локального сервера.

---

# 10. Где лежат данные

Для текущей Windows-версии использовать стабильную локальную директорию приложения.

Логическая структура:

```text
LivingMap/
├─ living-map.sqlite
├─ backups/
├─ logs/
└─ config.json
```

В production путь определяется платформенным resolver.

Для разработки / тестов должна существовать переменная:

```text
LIVING_MAP_HOME
```

которая полностью переопределяет директорию данных.

Это критично для:

- автоматических тестов;
- dev-сред;
- безопасных временных БД;
- будущей переносимости.

Нельзя хардкодить абсолютный путь пользователя.

---

# 11. SQLite как источник истины

Для локальной версии **SQLite является источником истины актуального состояния**.

Не JSON.
Не Markdown.
Не Obsidian.
Не UI state.

Markdown / экспорт могут появиться как представление или экспорт.

---

# 12. SQLite concurrency: Electron + MCP

Electron и MCP могут быть запущены одновременно и открыть одну локальную БД разными connections.

Для этого использовать:

- WAL;
- `foreign_keys = ON`;
- разумный `busy_timeout`;
- короткие write transactions;
- optimistic concurrency;
- global revision.

Не использовать network filesystem для рабочей БД.

---

# 13. Optimistic concurrency

Каждая изменяемая крупная сущность / aggregate получает:

```text
version
```

Команда, основанная на ранее прочитанном состоянии, передаёт ожидаемую version.

Если реальность уже изменилась:

```text
expected version != current version
```

операция НЕ перетирает новые данные.

Возвращается:

```text
CONFLICT_RELOAD
```

MCP должен перечитать состояние и рассуждать заново.

Это особенно важно, если пользователь редактирует приложение одновременно с Claude.

---

# 14. Global revision

В БД хранится монотонный:

```text
state_revision
```

Каждая успешная доменная write-транзакция увеличивает его.

Зачем:

1. Electron понимает, что MCP изменил состояние.
2. Proposal может знать, на какой версии мира он был создан.
3. UI может быстро понять, что read model устарел.
4. Позже это поможет миграции к синхронизации, но sync сейчас не строится.

---

# 15. Обновление UI после изменений MCP

MCP не должен подключаться напрямую к renderer.

Вместо сложного локального message bus:

1. MCP совершает write-транзакцию.
2. `state_revision` увеличивается.
3. Electron Main, пока приложение открыто, дешёво отслеживает revision.
4. При изменении отправляет renderer событие `stateChanged`.
5. Renderer перезапрашивает нужные read models.

Проверка revision выполняется только пока приложение реально работает.

Это не background service.

Не фиксировать сейчас конкретный интервал polling как продуктовое решение. Он выбирается на этапе реализации и может быть адаптивным.

---

# 16. Schema migrations

Правило владения:

> **Desktop App — единственный компонент, который запускает migrations.**

На старте desktop:

```text
resolve data dir
→ inspect database
→ backup before destructive/risky migration
→ run migrations
→ open application
```

MCP:

```text
resolve data dir
→ inspect schema version
→ compatible? continue
→ incompatible? fail safely
```

MCP не мигрирует БД.

Это убирает гонку migrations между двумя процессами.

---

# 17. Backup / Restore

Backup — часть надёжности, не отдельная продуктовая функция.

Минимальные правила:

- backup перед потенциально опасной migration;
- ручной backup;
- восстановление при закрытой рабочей БД;
- backup должен быть консистентным SQLite snapshot, а не случайным копированием файла во время write;
- ограниченная ротация старых автоматических backup.

Никакого облачного backup в MVP.

---

# 18. Идентификаторы и время

Все доменные сущности имеют стабильные глобально уникальные IDs.

Для текущего MVP достаточно UUID, генерируемых локально.

Не использовать автоинкрементный ID как внешний доменный идентификатор.

Почему:

- MCP и UI могут создавать сущности независимо;
- легче экспортировать;
- легче мигрировать в будущую облачную систему;
- меньше конфликтов при будущем sync.

Время:

- абсолютные timestamps хранятся в UTC;
- календарные события дополнительно сохраняют исходный timezone;
- UI показывает локальное время пользователя.

---

# 19. Actor Context

Любой command выполняется от имени actor.

Минимально:

```text
user-ui
mcp-ai
system
```

Будущее `account-user` сейчас не реализуется.

Command context также содержит:

- correlationId;
- timestamp;
- source.

Это позволяет понимать, кто изменил систему.

---

# 20. Change Log

Не строим event sourcing.

SQLite current state остаётся источником истины.

Но для существенных изменений хранится лёгкий change log:

```text
id
timestamp
actor
commandType
entityType
entityId
correlationId
summary / minimal payload
stateRevision
```

Цели:

- понять, что изменил ИИ;
- отладка;
- история существенных решений;
- восстановление причин изменения;
- будущие обзоры.

Не писать туда полный prompt/response ИИ по умолчанию.

---

# 21. MCP как универсальная граница ИИ

MCP — не «Claude integration».

Это vendor-neutral interface Живой карты.

Текущий transport:

```text
stdio
```

Будущий remote transport может быть добавлен отдельно.

Application/domain не знают о transport.

---

# 22. MCP capabilities

MCP поверхность делится на четыре класса.

## A. READ

ИИ может читать разрешённый контекст:

- текущую стратегическую структуру;
- сезон;
- активные Замыслы;
- результат;
- этапы;
- действия;
- блокировки;
- текущий order;
- календарный snapshot;
- релевантную память;
- captures;
- историю, если она нужна для решения.

---

## B. SAFE WRITE

ИИ может автоматически менять только то, что не создаёт нового стратегического обязательства.

Примеры потенциально safe:

- установить новый порядок **существующих уже допустимых действий**;
- записать `why now`;
- пометить необходимость перепланирования;
- добавить безопасную связь памяти;
- классифицировать capture как неоперационную память;
- сделать локальное техническое уточнение, не меняющее смысл результата.

Каждый конкретный safe command должен быть явно разрешён policy.

Принцип:

> отсутствие запрета НЕ означает разрешение.

---

## C. PROPOSAL REQUIRED

ИИ создаёт proposal, а не применяет изменение.

Обязательно для:

- первого маршрута значимого Замысла;
- изменения желаемого результата;
- изменения крупных этапов;
- активации стратегически значимого Замысла;
- отпускания значимого активного Замысла;
- изменения сезона;
- изменения условий хорошей жизни;
- изменения рабочей нормы как постоянного правила;
- создания / изменения существенного внешнего обязательства;
- существенного перепланирования.

---

## D. FORBIDDEN

MCP не получает инструментов для:

- arbitrary SQL;
- произвольного чтения файлов компьютера через Живую карту;
- массового удаления данных;
- обхода policy;
- migrations;
- изменения permission rules;
- запуска shell-команд от имени приложения;
- управления внешним календарём на текущем этапе.

---

# 23. Proposal workflow

Proposal — отдельная сущность.

Минимально:

```text
id
kind
status
createdBy
createdAt
baseRevision
affectedEntityIds
payload
rationale
```

Статусы:

```text
pending
accepted
rejected
stale
```

Поток:

```text
AI creates proposal
→ proposal saved as pending
→ UI shows exact consequence
→ user accepts / rejects
→ application revalidates
→ if base state changed materially: stale
→ otherwise apply atomically
```

Пользователь всегда должен понимать:

- что изменится;
- почему ИИ это предлагает;
- какие сущности затронуты.

---

# 24. Никакой «магической записи» из чата

MCP tool не должен одновременно:

1. придумать стратегическое изменение;
2. молча применить его.

Для significant changes всегда:

```text
proposal → confirmation → apply
```

Это главный предохранитель системы.

---

# 25. Ordered Action Plan

ИИ не выбирает только один моментальный ход.

Он поддерживает **Ordered Action Plan**.

Минимально:

```text
id
scope / intentionId
orderedActionIds[]
rationale
createdBy
createdAt
version
sourceRevision
```

Можно хранить rationale на уровне отдельных действий, если ИИ его предоставляет.

План не является жёстким календарём.

Это:

> «в каком порядке разумнее двигаться при текущем известном мире».

---

## 25.1. Временное решение: ручной порядок на Этапе 2

На Этапе 2 (Один настоящий Замысел) полноценный `OrderedActionPlan`, описанный выше, ещё не реализуется.

Вместо него Good Life Conditions, Stages и Actions хранят простой персистентный `position` (см. `packages/domain/src/reorder.ts`), который пользователь может вручную менять через UI.

Это допустимо для Этапа 2, потому что:

- AI planning ещё не существует;
- у порядка нет AI rationale;
- нет `sourceRevision` для AI-сформированного порядка;
- порядок сейчас — только ручная/отладочная возможность, а не продуктовое решение о стратегическом маршруте.

Это временная деталь реализации pre-AI этапа, а не конкурирующий стратегический планировщик и не замена `OrderedActionPlan`.

На Этапе 3 (ИИ-мозг через MCP), когда появится настоящий AI-сформированный порядок, должен быть введён канонический `OrderedActionPlan` (id, scope/intentionId, orderedActionIds[], rationale, createdBy, createdAt, version, sourceRevision) в соответствии с разделом 25. Существующее представление на основе `position` не должно разрастись в отдельный стратегический планировщик — при необходимости миграция/адаптация текущих `position`-данных к `OrderedActionPlan` выполняется на Этапе 3.

**Реализовано на Этапе 3 (ADR-0004).** `OrderedActionPlan` — единственный стратегический порядок действий (один на Замысел; всегда перестановка незавершённых действий на момент записи). `Action.position` остаётся только порядком показа внутри этапа и стратегию не определяет; `Stage.position` — последовательность этапов маршрута. Ручной порядок Этапа 2 не мигрирует в план и не выдаётся за решение ИИ: план появляется только после подтверждения пользователем первого маршрутного Proposal.

---

# 26. CurrentActionSelector

Это чистая детерминированная доменная функция.

Она НЕ определяет стратегическую важность.

Она получает:

- Ordered Action Plan;
- Action states;
- blockers;
- hard calendar constraints;
- hard commitments;
- estimated duration, если она известна;
- confirmed planning rules, когда они появятся;
- текущее время.

Она делает только проверку допустимости.

Упрощённо:

```text
for action in AI order:
    if done → skip
    if blocked → skip
    if objectively impossible now → skip
    return action
```

Если ни одно действие нельзя безопасно выбрать:

```text
NeedsAIReplan
```

---

## 26.1. Реализовано на Этапе 8 (ADR-0009): несколько проектов, один `Сейчас`

Intention получил жизненный цикл (`active | deferred | completed | released`); одновременно активных не
больше трёх — домен, типизированный результат `ACTIVE_PROJECT_LIMIT` и триггеры БД. `CurrentActionSelector`
не изменился и по-прежнему получает ровно один план. Приложение (`loadFocusState`) лишь решает, какой проект
спросить первым: порядок активных проектов задаёт владелец вручную, идущая работа закрепляет свой проект,
проект без допустимого действия пропускается; ничего не оценивается и не выдумывается.
Стратегические слои над проектами (план по десятилетиям, горизонт 3 года, год, главная цель сезона) и
рутины утро/вечер — данные владельца: `mcp-ai` читает слои, не читает рутины и не имеет ни одной команды,
которая их меняет. Смена курса высокого слоя не переписывает нижние уровни: она показывает затронутое
заранее и применяется только вместе с отпечатком показанного (§22–24 для ИИ остаются прежними).

**Уточнено на Этапе 9, День 1 (ADR-0010 §9).** (1) Владелец может выбрать, над каким активным проектом
работает сейчас (`settings.selected_intention_id`): `loadFocusState` спрашивает его первым после идущей работы
и пока в его порядке есть допустимое действие; иначе — прежний порядок проектов. Выбор не стратегия: порядок
проектов и планы не меняются; идущая работа на другом проекте ставится на паузу, новая сама не начинается.
(2) План проекта может быть заменён утверждённым владельцем планом (`plan.replace`, только `user-ui`/`system`,
без MCP): прежние Stage архивируются (`archived_at`) и вместе с их Action остаются историей, но репозитории
отдают только живые Stage — архивное недостижимо для маршрута, `Сейчас`, команд и предложений ИИ.
(3) «Быт» (`household_items`) — карман разовых бытовых дел вне доменной линии проектов: не Action, не план,
не рабочее время и не контекст ИИ; ИИ может лишь предложить дело в ответе на `+`, добавляет владелец.

# 27. Важное правило про hard constraints

Локальный алгоритм не имеет права сам вставить новую стратегическую работу выше AI-order.

Если обнаружено:

- близкий дедлайн;
- новое обязательство;
- календарное изменение;
- противоречие порядка с реальностью,

и это нельзя решить простым пропуском недоступного действия:

> вернуть `NeedsAIReplan`.

Не строить второй скрытый «умный планировщик» рядом с ИИ.

---

# 28. `Почему сейчас`

`why now` имеет два источника.

### Стратегическая причина

Приходит из AI Ordered Plan:

> почему это действие должно быть раньше других.

### Причина допустимости

Может быть добавлена локально:

> помещается до встречи;
> предыдущий шаг уже завершён;
> блокировка снята.

Живая карта не придумывает стратегическое объяснение сама.

---

# 29. Application errors

Внутри системы использовать типизированные ошибки / результаты.

Минимум:

```text
VALIDATION_ERROR
NOT_FOUND
CONFLICT_RELOAD
PERMISSION_DENIED
REQUIRES_CONFIRMATION
STALE_PROPOSAL
NEEDS_AI_REPLAN
INTEGRATION_UNAVAILABLE
STORAGE_ERROR
SCHEMA_INCOMPATIBLE
```

IPC и MCP сериализуют их в стабильный внешний контракт.

Не отдавать renderer stack traces.

---

# 30. IPC architecture

Никаких динамических каналов вида:

```text
invoke("anything", payload)
```

Preload экспортирует конечный typed surface.

Пример:

```ts
window.livingMap = {
  queries: {
    getCurrentView,
    getIntention,
  },
  commands: {
    completeAction,
    acceptProposal,
  },
  events: {
    onStateChanged,
  }
}
```

Main повторно валидирует payload через Zod.

Renderer считается недоверенной границей даже в локальном приложении.

---

# 31. MCP architecture

MCP tool handler:

```text
MCP input
→ Zod
→ capability policy
→ application command/query
→ domain
→ repository transaction
→ typed result
→ MCP output
```

Запрещён путь:

```text
MCP input
→ SQL
```

---

# 32. Calendar boundary

```ts
interface CalendarProvider {
  refresh(): Promise<CalendarSnapshot>
}
```

**Реализовано на Этапе 4 (ADR-0005), уточнено при реальной проверке.** Живая проверка OAuth-подключения показала, что она требует Google Cloud billing/tax-профиль пользователя — неприемлемо для локального read-only MVP одного пользователя. Утверждённое продуктовое решение: Desktop читает Google Calendar через приватный "Закрытый адрес в формате iCal" пользователя (`@living-map/integrations-ical-calendar`), а не через Google OAuth/REST API. Сама граница `CalendarProvider` и её место в архитектуре не изменились: Desktop по-прежнему единолично владеет получением снимка и refresh; UI по-прежнему говорит «Google Calendar», потому что фид пользователя реально из Google Calendar — изменился только внутренний механизм получения данных. Подробности и обоснование — ADR-0005.

MCP не обязан напрямую ходить во внешний календарь и не видит секретный адрес; он читает только уже сохранённый `CalendarSnapshot` через обычный planning context.

ИИ читает календарный snapshot, сохранённый Живой картой, вместе с:

```text
syncedAt
source
staleness
```

Если snapshot устарел, система должна это показать.

Не притворяться, что календарь актуален.

Будущая замена адаптера (Google OAuth API или другой источник) не должна менять поведение domain/application — только сам `CalendarProvider`.

---

# 33. Секрет календаря

Секрет, дающий read-доступ к внешнему календарю (OAuth refresh token ранее; приватный iCal URL сейчас, ADR-0005), подчиняется одним и тем же правилам:

- не хранить в renderer, не возвращать renderer после сохранения;
- не хранить открытым текстом в обычной domain table;
- использовать OS-protected storage / Electron `safeStorage` или эквивалентный локальный secret adapter;
- domain видит только `CalendarSnapshot`, не сам секрет;
- MCP не получает секрет ни в каком виде.

---

# 34. Универсальный `+`

Архитектурное правило на будущее:

> сохранение raw capture не зависит от ИИ.

Поток:

```text
user input
→ persist raw capture immediately
→ commit
→ optional AI processing later
```

ИИ никогда не является условием сохранения исходной мысли.

Raw text неизменяем как оригинал.

Интерпретации хранятся отдельно.

**Реализовано на Этапе 6 (ADR-0007).** `+` сохраняет Capture одной транзакцией, затем Electron Main ставит её
в очередь разбора (одна задача ИИ одновременно, `pending → processing → processed | failed`, восстановление
при запуске). Результат ИИ — проверяемый Zod структурированный контракт (ответ / память / предложение /
ничего), а не свободный текст.

---

# 35. Память

На первом этапе памяти:

- SQLite persistence;
- обычный поиск;
- связи;
- MCP retrieval.

Архитектура предусматривает:

```ts
interface MemorySearch {
  search(query): Promise<MemoryHit[]>
}
```

Конкретная реализация может позднее использовать SQLite FTS.

Vector DB сейчас не вводится.

Если когда-либо понадобится семантический поиск, он добавляется как новый adapter, а не переписывает Memory domain.

**Реализовано на Этапе 6 (ADR-0007).** Memory v1 — таблица `memories` (тип, текст, исходная Capture, связи с
сущностями). Поиск — детерминированная чистая доменная функция ранжирования поверх SQLite. MCP: `search_memory`
(read), `save_memory` (safe write), `list_captures` (read).
Пользователь видит память на экране «Память» (поиск, «Забыть»). Забыть — команда `memory.forget`, только
`user-ui`/`system` (в MCP её нет): жёсткое удаление строки `memories`; исходная Capture не меняется.

---

# 36. Разборы без background service

Никакой cron / daemon.

На запуске:

```text
last processed review periods
+ current local date
→ determine due reviews
```

Если review требует ИИ, создаётся ожидающее состояние:

```text
ReviewNeedsAI
```

Пока пользователь не подключил Claude / другой AI, данные не теряются.

---

# 37. UI state

Разделить:

### Persisted product state

SQLite.

### Server-like read state

получается через application queries / IPC.

### Ephemeral UI state

React.

Не хранить доменную реальность только в React store.

Redux не нужен по умолчанию.

---

# 38. Security baseline Electron

Обязательные настройки:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- sandbox, если не конфликтует с необходимым preload;
- строгий preload API;
- Content Security Policy;
- никакого произвольного remote content в основном окне;
- проверка IPC sender там, где применимо;
- внешние ссылки открывать явно и безопасно;
- не передавать secrets в renderer.

---

# 39. Security baseline MCP

- stdio, не публичный port;
- whitelist tools;
- Zod validation;
- capability policy;
- никаких raw filesystem / shell tools;
- никаких raw SQL tools;
- strategic writes только через Proposal;
- каждый write имеет actor/correlationId;
- ошибки не раскрывают лишние локальные пути/секреты.

---

# 40. Логи

Логи нужны для технической диагностики.

По умолчанию НЕ логировать:

- полные личные заметки;
- полную память;
- полные AI conversations;
- OAuth secrets.

Можно логировать:

- command name;
- error code;
- timings;
- entity IDs;
- state revision;
- технические metadata.

Отдельный debug mode может быть добавлен позднее.

---

# 41. Тестовая пирамида

## Domain unit tests — много

Проверять:

- state transitions;
- CurrentActionSelector;
- permissions;
- proposal rules;
- progress;
- invariants.

---

## Application tests — много

На временной SQLite:

- commands;
- transactions;
- optimistic concurrency;
- proposal acceptance;
- audit/change log;
- repository behavior.

---

## Contract tests

Проверять:

- IPC validation;
- MCP schemas;
- serialized errors.

---

## Playwright / Electron E2E — мало, но критично

Сквозные сценарии:

```text
open app
→ read current state
→ execute action
→ state persists
```

Позднее:

```text
MCP write
→ revision changes
→ app refreshes
```

Не пытаться покрыть всю бизнес-логику E2E.

---

# 42. Determinism

Доменный тест не должен зависеть от реального `Date.now()`.

Все use cases, которым нужно время, получают Clock port.

Пример:

```ts
interface Clock {
  now(): Instant
}
```

Production:

```text
SystemClock
```

Tests:

```text
FakeClock
```

Это важно для:

- календарных ограничений;
- рабочих сессий;
- обзоров;
- дедлайнов.

---

# 43. Генерация IDs

Аналогично:

```ts
interface IdGenerator {
  next(): string
}
```

Production использует локальный UUID.

Tests — предсказуемые IDs.

Не размазывать `crypto.randomUUID()` по domain code.

---

# 44. Transaction boundary

Одна application command = максимум одна атомарная доменная write-транзакция.

Например:

```text
AcceptProposal
```

должен либо:

- применить все изменения,
- обновить proposal,
- записать change log,
- увеличить revision,

либо не сделать ничего.

Никаких полусостояний.

---

# 45. Repository design

Не создавать generic repository ради абстракции.

Интерфейсы отражают use cases.

Лучше:

```text
IntentionRepository
ActionPlanRepository
ProposalRepository
MemoryRepository
```

чем:

```text
Repository<T>.save(anything)
```

Repository не обязан соответствовать одной таблице.

---

# 46. Будущая переносимость

Чтобы оставить путь к web/mobile/cloud:

## С самого начала делаем

- platform-agnostic domain;
- platform-agnostic application layer;
- stable UUIDs;
- explicit ports;
- contracts;
- migrations;
- actor metadata;
- optimistic versions;
- change revision.

## Сейчас НЕ делаем

- userId во всех таблицах «на всякий случай»;
- sync protocol;
- cloud API;
- tenant architecture;
- conflict-free replicated data types;
- offline multi-device merging.

Будущая версия добавит отдельный cloud persistence / sync boundary.

---

# 47. Что будет переиспользовано в будущем

При переходе к продаваемому продукту должны потенциально сохраниться:

```text
packages/domain
packages/application
packages/contracts
значительная часть tests
MCP capability model
proposal model
```

Могут замениться:

```text
Electron renderer
SQLite adapter
local stdio MCP transport
single-user composition root
```

Это и есть нужная нам расширяемость.

---

# 48. Что НЕ нужно абстрагировать сейчас

Не создавать интерфейс только потому, что «когда-нибудь может быть два варианта».

Абстракция нужна сейчас только если:

1. уже существуют два входа;
2. это настоящая platform boundary;
3. это внешний сервис;
4. это необходимо тестам.

Поэтому оправданы:

- repository ports;
- Clock;
- IdGenerator;
- CalendarProvider;
- secret storage;
- AI/MCP boundary.

Не оправданы:

- десять UI adapters;
- универсальная plugin system;
- generic workflow engine;
- generic rule DSL;
- generic event bus.

---

# 49. Архитектурные решения (ADR summary)

## ADR-001 — Local desktop first

Electron-приложение является первым runtime.

Причина: максимальная простота текущего использования без сервера.

---

## ADR-002 — SQLite source of truth

Текущая реальность хранится локально в SQLite.

Причина: надёжность, транзакции, простота, переносимость.

---

## ADR-003 — Domain/Application не зависят от Electron

Причина: будущая замена интерфейса не должна переписывать продуктовую механику.

---

## ADR-004 — Два composition root, не локальный сервер

Desktop и MCP напрямую собирают общие application services вокруг своих SQLite connections.

Причина: нет необходимости поднимать localhost backend.

---

## ADR-005 — MCP через stdio

Причина: локальность, отсутствие фонового сервера, совместимость с desktop AI hosts.

---

## ADR-006 — MCP никогда не пишет SQL напрямую

Все операции проходят через application/domain.

Причина: единые инварианты независимо от точки входа.

---

## ADR-007 — Strategic changes через Proposal

Причина: ИИ является мозгом, но не владельцем жизненного направления пользователя.

---

## ADR-008 — ИИ задаёт порядок, локальный selector проверяет допустимость

Причина: не создавать второй конкурирующий «умный планировщик».

---

## ADR-009 — SQLite concurrency через WAL + optimistic concurrency

Причина: desktop и MCP могут взаимодействовать одновременно без отдельного сервера.

---

## ADR-010 — Desktop владеет migrations

Причина: избежать конкурирующих migrations и сделать lifecycle предсказуемым.

---

## ADR-011 — Global revision

Причина: дешёвая синхронизация состояния между локальными процессами и обнаружение stale state.

---

## ADR-012 — No background daemon

Причина: текущему продукту не нужна работа 24/7.

---

## ADR-013 — Raw Capture сохраняется до AI

Причина: мысль нельзя потерять из-за отсутствия ИИ.

---

## ADR-014 — Не строить cloud abstractions заранее

Причина: расширяемость достигается чистыми границами, а не преждевременной инфраструктурой.

---

## ADR-015 — Ручной `position` вместо `OrderedActionPlan` на Этапе 2

На Этапе 2 порядок Good Life Conditions/Stages/Actions хранится как простой персистентный `position`, устанавливаемый вручную пользователем (см. §25.1), а не как канонический AI-ориентированный `OrderedActionPlan` из §25.

Причина: AI planning ещё не реализован, поэтому у порядка нет AI rationale и `sourceRevision`. Вводить `OrderedActionPlan` раньше появления реального ИИ-порядка означало бы строить абстракцию впрок.

Канонический `OrderedActionPlan` вводится на Этапе 3, когда появляется настоящий AI-сформированный порядок; `position`-представление не должно стать конкурирующим стратегическим планировщиком.

---

# 50. Открытые технические вопросы перед skeleton

Эти вопросы НЕ блокируют архитектуру и должны решаться коротким техническим spike, а не новым продуктовым обсуждением.

## 1. SQLite driver

Проверить лучший актуальный вариант для выбранных версий Electron + Node + Drizzle на Windows x64.

Критерии указаны в разделе 3.

---

## 2. Electron build/packaging tooling

Выбрать минимальный актуальный инструмент, который:

- дружит с Vite;
- нормально собирает native SQLite dependency, если она нужна;
- поддерживает Windows;
- не навязывает собственную архитектуру.

Это build detail, не архитектурное решение.

---

## 3. Claude local MCP packaging

Проверить фактический формат подключения локального stdio MCP к текущей версии Claude Desktop и минимальный способ dev-install.

MCP surface при этом остаётся vendor-neutral.

---

# 51. Проверка архитектуры против требований продукта

## Локальная?

Да.

Нет сервера и облачной БД.

## Работает только при взаимодействии?

Да.

Desktop работает, когда открыт.
MCP работает, когда AI host его запускает.

## ИИ обязателен для полного продукта?

Да.

Он получает полноценную MCP-границу и отвечает за интеллектуальный порядок / маршрут.

## Приложение полезно без активного ИИ каждую секунду?

Да.

Последний утверждённый маршрут и AI-order хранятся локально.
Живая карта способна показать `Сейчас` без нового model call.

## Можно позже сделать web/mobile?

Да.

Domain/Application не зависят от Electron/SQLite.

## Не строим ли мы будущий SaaS сейчас?

Нет.

Нет auth, cloud, sync, tenant model и remote API.

## Может ли AI разрушить стратегию молча?

Нет.

Capability policy + Proposal workflow.

## Может ли UI и MCP потереть изменения друг друга?

Архитектура предусматривает optimistic version + global revision.

## Нужно ли приложению работать 24/7?

Нет.

---

# 52. Definition of Done архитектурного этапа

Архитектура считается готовой, если зафиксировано:

- [x] процессы;
- [x] границы Electron Main / Preload / Renderer;
- [x] отдельный MCP process;
- [x] dependency direction;
- [x] domain/application/persistence/contracts;
- [x] repository boundary;
- [x] SQLite ownership;
- [x] migration ownership;
- [x] concurrency strategy;
- [x] global revision;
- [x] change propagation MCP → UI;
- [x] MCP permission model;
- [x] Proposal workflow;
- [x] AI-order / deterministic constraint split;
- [x] Google Calendar boundary;
- [x] backup/restore strategy;
- [x] security baseline;
- [x] testing boundaries;
- [x] future expansion boundary;
- [x] список того, что сознательно НЕ строится.

---

# 53. Следующее реальное движение

Не обсуждать новые функции.

Следующий шаг:

> **создать чистый repository skeleton по этой архитектуре и доказать четыре вещи техническим spike:**

1. Electron main ↔ renderer через безопасный preload/IPC;
2. SQLite + Drizzle работает локально;
3. desktop и отдельный Node/MCP process могут безопасно читать одну тестовую БД;
4. выбранная SQLite concurrency strategy переживает конкурентную запись без потери данных.

После этого начинается следующий этап `DEVELOPMENT_PLAN.md`:

> **Локальный фундамент.**

---

# 54. Prompt для Claude Code на архитектурный skeleton

```text
Мы начинаем новый репозиторий Живой карты с нуля.

Перед любыми действиями прочитай ЦЕЛИКОМ:
1. DEVELOPMENT_PLAN.md
2. ARCHITECTURE.md

Не используй старый roadmap и старый код как основание.

Текущий этап — архитектурный skeleton / технический spike.
Не реализуй продуктовые функции.

Зафиксированный стек:
Electron + React + TypeScript + Vite + React Router + Tailwind + shadcn/ui + SQLite + Drizzle ORM + Zod + MCP TypeScript SDK + Vitest + Playwright + pnpm + Biome.

Создай минимальный pnpm-workspace со структурой, соответствующей ARCHITECTURE.md:
- apps/desktop
- apps/mcp
- packages/domain
- packages/application
- packages/contracts
- packages/persistence-sqlite
- docs/adr

Не создавай заранее packages будущих функций.

Проверь и выбери актуальный SQLite driver, совместимый с текущими версиями Electron + Node + Drizzle на Windows x64. До выбора коротко сравни только реально подходящие варианты и зафиксируй решение отдельным ADR.

Сделай только технический spike, доказывающий:

1. Electron запускается.
2. Renderer не имеет Node integration и обращается к Main через безопасный typed preload API.
3. Main process может открыть тестовую SQLite через persistence adapter.
4. Отдельный Node process из apps/mcp может открыть ту же тестовую БД.
5. Включены WAL, foreign keys, busy timeout.
6. Реализован минимальный state_revision.
7. Два процесса могут прочитать данные.
8. Проведи тест конкурентной записи с optimistic version:
   - первая запись проходит;
   - stale запись НЕ перетирает новую и получает CONFLICT_RELOAD.
9. MCP-слой в spike не должен получать raw SQL tool.
10. Domain и Application не должны импортировать Electron, React, Drizzle, SQLite или MCP SDK.

На этом этапе не реализуй:
- Замыслы;
- сезоны;
- реальные действия;
- Google Calendar;
- настоящий AI planning;
- CurrentActionSelector;
- таймер;
- +;
- память;
- обзоры;
- cloud;
- аккаунты;
- sync;
- красивый UI.

Создай/обнови:
- package manifests;
- workspace config;
- minimal build config;
- ADR по SQLite driver;
- ADR по процессам/доступу к БД, если требуется уточнение;
- тесты spike.

После выполнения остановись.

В финальном отчёте покажи:
1. дерево созданных файлов;
2. выбранный SQLite driver и почему;
3. как устроен безопасный IPC;
4. как desktop и MCP делят SQLite;
5. результат concurrency test;
6. какие пункты ARCHITECTURE.md подтверждены кодом;
7. какие технические риски остались.

Не переходи к этапу «Локальный фундамент» без отдельного подтверждения пользователя.
```

---

# 55. Текущий статус

**Архитектура спроектирована.**

**Следующая работа — только технический skeleton/spike, подтверждающий архитектуру кодом.**

Никакие продуктовые функции до этого не начинаются.
