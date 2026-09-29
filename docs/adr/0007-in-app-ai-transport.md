# ADR-0007 — ИИ изнутри Живой карты: `AiRunner` + Claude Code headless

**Статус:** принято (Этап 6, Owner Gate A — вариант B)
**Дата:** 2026-09-28

## Контекст

MCP-сервер Живой карты только отвечает на запросы ИИ-host'а и сам вызвать ИИ не может
(DEVELOPMENT_PLAN §6, Этап 6). Чтобы `+` работал внутри приложения, desktop должен уметь по требованию
запустить ИИ-host, который подключится к тому же MCP.

## Решение (утверждено владельцем)

**Electron main по требованию запускает ИИ-host за заменяемым портом `AiRunner`.** Первый адаптер —
Claude Code CLI в headless-режиме (`claude -p`), по подписке claude.ai пользователя.

```text
Renderer ── IPC ──▶ Electron main
                    ├─ createCapture (commit в SQLite)      ← ДО любого ИИ
                    └─ CaptureProcessor ─▶ AiRunner (порт, application)
                                             └─ ClaudeCodeCliAiRunner (desktop main, вендорный адаптер)
                                                  └─ claude.exe -p … ── stdio ──▶ Local MCP (living-map)
                                                                                     └─ тот же AiSurface (mcp-ai)
```

- `AiRunner` — порт application-слоя: `processCapture({captureId, rawText, createdAt, now, timeZone}) →
  { ok, result } | { ok: false, failure }`. Результат и виды отказа — вендор-нейтральные контракты
  (`@living-map/contracts`). Domain/Application не знают про Claude, CLI, JSON-формат CLI и имена моделей.
- `ClaudeCodeCliAiRunner` — инфраструктура только в Electron main (`apps/desktop/src/main/ai/`). Renderer
  никогда не запускает процессы и не влияет ни на исполняемый файл, ни на флаги.
- ИИ работает с данными **только через существующий MCP `AiSurface`** (actor `mcp-ai`, capability policy
  ADR-0004). Модель безопасности Proposal остаётся авторитетной: у ИИ нет `proposal.accept`, нет прямых
  стратегических записей.
- Постоянного демона нет: процесс ИИ живёт только на время разбора одной записи.
- Прямых API Anthropic / OpenAI в MVP нет.

## Точная команда (проверено на Claude Code 2.1.144)

Исполняемый файл: `LIVING_MAP_CLAUDE_PATH` → `claude.exe` в `PATH` →
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` → `%USERPROFILE%\.local\bin\claude.exe`.
`spawn(file, args, { shell: false, windowsHide: true })`, фиксированный массив аргументов:

```text
-p --output-format stream-json --verbose
--tools ""                          # никаких встроенных инструментов (Bash/Read/Write/Web…)
--strict-mcp-config --mcp-config <json: только living-map>
--allowedTools mcp__living-map      # MCP Живой карты разрешён заранее
--permission-mode dontAsk           # всё прочее запрещено, окон подтверждения нет
--setting-sources ""                # не читать user/project settings → нет хуков, плагинов, apiKeyHelper
--disable-slash-commands --no-session-persistence
--system-prompt <фиксированный текст> --json-schema <схема результата без `$schema`/`format`>
```

- Текст пользователя передаётся **только через stdin**, никогда не попадает в командную строку и не
  интерполируется в shell.
- MCP-сервер — собранный артефакт desktop (`out/main/mcp.js`), запускается тем же Electron в режиме Node
  (`ELECTRON_RUN_AS_NODE=1`) с `LIVING_MAP_HOME` desktop-приложения. Никакого `tsx`/путей к исходникам.
- `cwd` — пустой каталог `<data home>/ai-workdir`: CLAUDE.md и `.claude/` проекта не подхватываются.
- Из окружения процесса удаляются все `ANTHROPIC_*` и `CLAUDE_CODE_USE_*`; если CLI всё же сообщает
  `apiKeySource` ≠ `none`, процесс убивается до обращения к модели. Тихого перехода на платный API нет.
- Таймаут 5 мин (живой замер: вопрос ~20 с, перепланирование ~170 с), stdout ≤ 4 МБ (превышение — kill); stderr сливается и не сохраняется. MCP-потомок сам завершается при
  закрытии stdin. Процесс убивается и при выходе из приложения.
- В лог и в БД попадает только вендор-нейтральный код отказа, никогда stderr/stdout целиком.

## Capture: сначала сохранить, потом ИИ

`captures`: `id`, `raw_text` (неизменяем — триггер БД), `source`, `created_at`, `state`
(`pending` → `processing` → `processed` | `failed`), `attempts`, `last_error`, `result` (JSON), `proposal_id`.

- `createCapture` коммитится до вызова `AiRunner` — сбой ИИ не может потерять запись.
- Одна задача ИИ одновременно (single-flight в desktop main). Захват записи — атомарный
  `pending → processing`; внешняя работа ИИ — вне транзакций; результат записывается отдельной командой
  только из состояния `processing` и только после Zod-проверки.
- При запуске: `processing` → `pending` (сбой посреди разбора), `failed` с `attempts < 5` → `pending`;
  затем разбор очереди. Явный «Повторить» — `failed → pending`. Сбой ИИ (нет CLI, нет входа, лимит,
  нет сети, MCP) касается только этой записи: она становится `failed`, очередь идёт дальше — ни одна
  запись не застревает в `pending` за чужим сбоем. Повтор одной записи в цикле не делается.
- **Связь и идемпотентность (Gate B).** Desktop передаёт MCP-потомку `LIVING_MAP_CAPTURE_ID`; все записи
  этого запуска идут с `captureId` в контексте команды. Proposal, созданный при разборе, в той же
  транзакции записывается в `captures.proposal_id`. Повторный разбор записи с `proposal_id` не вызывает ИИ
  и не создаёт второй Proposal (запись становится `processed`, kind `proposal`); повторный
  `create_route_proposal` из того же запуска возвращает уже созданный. Память: одна запись каждого типа на
  Capture. Миграция 0012 восстановила связь для записей до этого механизма (Proposal от `mcp-ai` между
  claim и завершением попытки). Перестановка порядка (`reorder_existing_actions`) не связывается: её
  повтор при той же карте даёт «без изменений».
- **MCP «pending».** Claude Code ждёт MCP при `init` лишь ~2,5 с; более медленный старт помечается
  `pending`, после чего сервер подключается и инструменты работают. `mcp_failed` — только если сервера нет
  в `init` или его статус не `connected`/`pending`; проверенный structured result не перечёркивается.
- Интерпретация хранится отдельно (`result`), оригинал не перезаписывается.

## Результат разбора (structured output, проверяется Zod)

`{ kind: answer | memory | commitment | proposal | no_operation, reply, proposalId | null }` —
`reply` — короткий ответ по-русски для пользователя. `proposalId` принимается, только если такое
предложение существует и создано ИИ. Некорректный результат → `failed` (`malformed`), ничего
стратегического не записано.

## Память v1

`memories`: `id`, `type` (`decision | fact | observation | preference | commitment | idea | note`), `text`,
`source_capture_id`, `linked_entity_ids`, `created_by`, `created_at`. Не редактируется. Поиск —
детерминированный локальный: регистр-независимые совпадения по началам слов (грубая основа слова), затем
свежесть. Без векторов и внешних сервисов.

## Новые MCP-инструменты и их класс

| инструмент      | класс      | что делает                                                           |
|-----------------|------------|----------------------------------------------------------------------|
| `search_memory` | read       | поиск по памяти (текст, связь с сущностью, лимит)                    |
| `list_captures` | read       | последние записи `+` и их состояние                                  |
| `save_memory`   | safe write | сохранить запоминание; повтор той же записи из той же Capture — no-op |

`memory.save` разрешён `mcp-ai` как SAFE WRITE (ARCHITECTURE §22 B): память не меняет порядок, `Сейчас`,
маршрут, результат, сезон или ограничения — это только контекст для будущих решений. Всё стратегическое —
по-прежнему через Proposal.

## Календарь

Запись во внешний календарь не реализуется (`CalendarWriter` требует отдельного решения). «Завтра в 15:00
стоматолог» ИИ может сохранить как память `commitment` с абсолютной датой и честно сказать, что в Google
Календарь Живая карта пока не пишет.

## Условия владельца (Gate A)

1. Требуется установленный и залогиненный Claude Code. 2. Разбор расходует лимиты подписки.
3. Поведение авторизации `claude -p` через claude.ai — не вечная гарантия продукта.
4. Транспорт заменяем: будущий адаптер API/провайдера реализует тот же `AiRunner`.
5. Нет CLI / нет входа / лимит / офлайн / сбой — Capture сохранена и ждёт.
6. Стратегические изменения — только Proposal + подтверждение. 7. Большого экрана чата нет.
8. `+` — основной вход к ИИ.
