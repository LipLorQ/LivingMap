# ADR-0003 — Доступ двух процессов к одной SQLite

**Статус:** принято (технический spike, 27.09.2026)
**Уточняет:** ARCHITECTURE.md §9, §12–16, §31, §50.3; ADR-004/006/009/010/011

## Решение

### Процессы и соединения

- Electron main и MCP-процесс открывают **отдельные** соединения к одному файлу `<LIVING_MAP_HOME>/living-map.sqlite`.
- Путь данных: `resolveDataHome()` в `persistence-sqlite` — одинаков для обоих процессов (`LIVING_MAP_HOME` → иначе `%APPDATA%\LivingMap`).
- Pragmas на каждом соединении: `busy_timeout=5000` (первым), `journal_mode=WAL` (с проверкой результата), `foreign_keys=ON`, `synchronous=NORMAL`.

### Транзакции

- Порт `Store` в application: `read(work)` / `write(ctx, work)`; `work` **синхронный**.
- Чтение: `BEGIN DEFERRED` (консистентный WAL-снимок, не блокирует писателя).
- Запись: `BEGIN IMMEDIATE`. Причина: в WAL deferred-транзакция, прочитавшая данные до чужого commit, при попытке записи получает `SQLITE_BUSY` **мгновенно**, busy_timeout не помогает. IMMEDIATE берёт write-lock сразу и ждёт до 5 с.
- Одна команда = одна транзакция: изменение агрегата + `state_revision += 1` + строка `change_log` — атомарно.
- Команды пишут только через `transact()` в application: возврат неуспешного `Result` изнутри транзакции откатывает её так же, как исключение (ARCHITECTURE §44).

### Optimistic concurrency (два уровня)

1. Application: внутри IMMEDIATE-транзакции сверяет `expectedVersion` с текущей → `CONFLICT_RELOAD`.
2. Storage: `UPDATE … WHERE id = ? AND version = ?`; `changes = 0` → `CONFLICT_RELOAD`. Защищает даже при ошибке в use case.

### Migrations и schema version

- Миграции генерирует drizzle-kit (`drizzle/*.sql`), скрипт `db:generate` встраивает их в `src/migrations.generated.ts` → бандл main не зависит от путей файловой системы.
- Schema version = `PRAGMA user_version` = число применённых миграций. Применяется только desktop (`openDesktopDatabase`), атомарно под IMMEDIATE.
- MCP (`openMcpDatabase`): не создаёт файл (`fileMustExist`), не мигрирует; при `missing`/`incompatible` tools отвечают `SCHEMA_INCOMPATIBLE` с просьбой открыть desktop. Открытие ленивое и повторяется при каждом вызове, пока БД не станет пригодной (MCP-host мог стартовать раньше desktop).
- Desktop отказывается открывать БД новее себя.

### MCP → UI

- Main опрашивает `state_revision` через application query каждые 500 мс, пока окно открыто, и шлёт renderer `lm:event:stateChanged`; renderer перезапрашивает read models. Не background service.

### MCP-поверхность

- Ровно 4 tools: `get_state_revision`, `list_probes`, `get_probe` (READ), `rename_probe` (SAFE WRITE, разрешён policy для `mcp-ai`).
- Вход валидируется contract-схемой Zod (`strictObject`), затем capability policy (deny by default), затем application.
- Нет tools для SQL, файлов, shell, миграций, policy. MCP-код не импортирует drizzle/better-sqlite3 (проверяется тестом).

## Dev-install в Claude Desktop (ARCHITECTURE §50.3)

Формат — стандартный stdio MCP server в `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "living-map": {
      "command": "node",
      "args": ["C:\\Projects\\LivingMap\\apps\\mcp\\dist\\main.js"]
    }
  }
}
```

Перед этим: `pnpm --filter @living-map/mcp build` и хотя бы один запуск desktop (он создаёт и мигрирует БД).
Автотесты запускают MCP из исходников (`tsx`); собранный `dist/main.js` проверен вручную SDK-клиентом через stdio (initialize, tools/list, вызов tool). **Подключение к реальному Claude Desktop в spike не проверялось** (конфиг пользователя не изменялся).

### Application ↔ contracts

`packages/application` зависит от `packages/contracts` (DTO-типы входов/выходов, коды ошибок, `Result`). Это сознательно: один источник кодов ошибок §29 для IPC и MCP вместо дублирования. Contracts остаётся листом (только `zod`); направление §6 не нарушается.

## Последствия / риски

Отложено до «Локального фундамента» / этапа MCP (латентно, в текущем коде не проявляется):

- **Schema check в MCP только при открытии.** Если desktop обновит схему, пока старый MCP-процесс жив, тот продолжит писать. Решение: проверять `PRAGMA user_version` внутри каждой IMMEDIATE write-транзакции MCP-store.
- **Миграции с `foreign_keys=ON` внутри транзакции.** Table-recreation миграции drizzle-kit (`PRAGMA foreign_keys=OFF` внутри транзакции — no-op) при появлении FK могут упасть или каскадно удалить данные. До первой схемы с FK: выключать FK на соединении до транзакции + `PRAGMA foreign_key_check` перед commit; плюс backup перед миграцией.
- **`recordChange` вызывается командой добровольно.** Команда, забывшая его, сломает MCP → UI refresh. Можно сверять `total_changes()` до/после `work`.
- **`SqliteHandle` отдаёт MCP composition root сырое соединение.** Архитектурный тест запрещает импорт drizzle/better-sqlite3 в `apps/mcp`, но не использование `handle.sqlite`. Можно вернуть из `openMcpDatabase` непрозрачный `{ store, close }`.

- Синхронный `Store` проще и безопаснее для SQLite, но будущий асинхронный адаптер (cloud) потребует изменить сигнатуры портов.
- Main process блокируется на время ожидания write-lock (до `busy_timeout`). При коротких транзакциях это миллисекунды; долгие операции (backup, большие миграции) нужно проектировать отдельно.
- Polling-интервал 500 мс — деталь реализации (можно заменить на `PRAGMA data_version`).
