# ADR-0003 — Доступ двух процессов к одной SQLite

**Статус:** принято (технический spike, 27.09.2026)
**Уточняет:** ARCHITECTURE.md §9, §12–16, §31, §50.3; ADR-004/006/009/010/011
**MCP-поверхность и подключение MCP-host заменены ADR-0004 (Этап 3).**

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

## Resolved in Stage 1 (Local Foundation, 2026-09-27)

Все четыре риска рассмотрены; ниже — фактическое решение.

1. **Schema check per write, for every store (not an MCP-only option).** `createSqliteStore`'s `write()` re-reads `PRAGMA user_version` inside the write transaction itself (after taking the IMMEDIATE lock), not only at open time, and throws `SchemaConflictError` on mismatch (new type in `packages/application/src/ports.ts` — application and persistence-sqlite already depend on it in the right direction); `createApplication`'s `guarded()` maps it to `SCHEMA_INCOMPATIBLE`. An initial design gated this behind an MCP-only `checkSchemaOnWrite` option; the independent review pointed out that always checking is simpler *and* additionally protects desktop itself against a second/older instance left running (there is no single-instance lock), so the option was removed and the check applies uniformly. `apps/mcp/src/main.ts` also drops its cached backend (`invalidateBackend`) the first time a call returns `SCHEMA_INCOMPATIBLE`, so a stale connection does not repeat the same error forever instead of reopening. Tests: `sqlite.test.ts` → "per-write schema check".

2. **FK-safe migration lifecycle.** `packages/persistence-sqlite/src/migrate.ts` disables `foreign_keys` on the **connection** before `BEGIN` (the pragma is a documented no-op inside an open transaction, so toggling it from generated migration SQL would silently do nothing), applies pending migrations, checks `PRAGMA foreign_key_check` before commit and throws (rolling back everything, including DDL) on any violation, then restores `foreign_keys = ON` in `finally` regardless of outcome. `applyMigrations(sqlite, migrations)` derives its target version from `migrations.length` — there is deliberately no separate `targetVersion` parameter that could disagree with it. Tested directly against fabricated migrations (a syntax error, an FK violation) without waiting for the first real FK table. Tests: "FK-safe migration lifecycle" in `sqlite.test.ts`.

3. **Backup and restore.** `runMigrations` takes `createBackup(sqlite, dataHome, "auto")` before attempting pending migrations, but only when `0 < current < expected` — not on first-ever creation (nothing to lose) and not when the schema is already newer than this app (that attempt fails outright regardless; backing up first would only feed rotation with copies of a database this app never touched — an independent-review finding). Backups are written via `VACUUM INTO` to a temporary file, fsynced, then renamed into place, so a failed VACUUM (e.g. a corrupted source page) or a crash never leaves a truncated file under a name rotation or restore would treat as real. `restoreBackup`: structurally verifies the backup first (non-empty, `user_version > 0`, `PRAGMA quick_check = ok`); best-effort checks that no other connection has an active write/read snapshot via `wal_checkpoint(TRUNCATE)` before touching anything (an idle-but-open connection can still slip through this check on POSIX — accepted, since the shipped platform is Windows, where the OS itself refuses to rename over a file another process holds open, surfacing as a clear error instead of silent loss); takes an **un-rotated** safety copy of whatever it's about to replace, so a bad restore (wrong file picked, or a gap this function didn't catch) stays recoverable; copies to a staging file, fsyncs it, then renames atomically, cleaning up the staging file on any failure. Auto-backup rotation (10 kept) is best-effort per file (a locked stale backup must not block startup) and only ever touches `auto-*`; `manual-*` and `pre-restore-*` are never rotated. Mandatory integration test (create → write A → backup → write B → close → restore → reopen → prove A) plus backup-verification, exclusivity, and safety-copy tests: `packages/persistence-sqlite/test/backup.test.ts`.

4. **`recordChange` — a structural guarantee, not a convention.** `createSqliteStore`'s `write()` compares the SQLite connection's `total_changes()` before and after `work()`; if rows changed but `recordChange` was never called, it throws and the whole transaction rolls back (ARCHITECTURE §44). Not an event-sourcing engine or a generic bus — one check on an existing SQLite counter, using a prepared statement reused across writes. Note: `total_changes()` counts a same-value `UPDATE` (`SET x = x`) as a change too, so a future idempotent no-op command would also need to call `recordChange` — no command does today. Test: "recordChange invariant" in `sqlite.test.ts`.

5. **`SqliteHandle` in the MCP composition root — confirmed safe, code unchanged, plus a concrete guard added.** `apps/mcp/src/main.ts` holds `SqliteHandle` only for `.close()` on shutdown; `McpBackend`/`server.ts` give tool handlers exclusively `Application` (queries/commands), never `.sqlite`. Wrapping `SqliteHandle` in an opaque `{ store, close }` would be an abstraction with no new consumer — left as is (ARCHITECTURE §48). The independent review noted that nothing *textually* stopped a future MCP change from importing `applyMigrations`/`createBackup`/`restoreBackup` from `@living-map/persistence-sqlite` and calling them with `.sqlite` (the existing architecture test only forbids importing the SQLite driver directly). Closed with a new assertion in `tests/architecture.test.ts` that `apps/mcp/src` never references `applyMigrations`, `createBackup`, `restoreBackup`, or `.sqlite`.

Additionally closed during Stage 1 (not in this ADR's original risk list, but required by DEVELOPMENT_PLAN §16, "storage errors must not silently lose or replace data"):

- `apps/desktop/src/main/index.ts`: `describeOpenFailure()` distinguishes "schema newer than the app" / "file damaged" / other for the user dialog — every branch exits the app (`app.exit(1)`) without ever replacing an existing file with a fresh empty one.
- `packages/persistence-sqlite/src/connection.ts`: `openDesktopDatabase` now refuses a pre-existing 0-byte file instead of silently treating it as "first launch" — SQLite itself cannot tell the two apart, and a 0-byte file is exactly what an interrupted write or a failed restore leaves behind (an independent-review finding).
- `apps/mcp/src/main.ts`: `openMcpDatabase()` is now wrapped in `try/catch` — a corrupted DB file returns `{ status: "unavailable" }` instead of an uncaught exception that used to crash the MCP process.

### Independent review

An independent review pass (separate context, `code-reviewer` agent) of the Stage 1 diff found 2 HIGH and 5 MEDIUM issues, all in the first draft of `restoreBackup`/`createBackup`: no backup-file validation before restore, no pre-restore safety copy, no exclusivity check, non-durable writes (no fsync, no atomic temp-then-rename), and a backup-trigger condition that fired on a "newer than this app" open (feeding rotation with useless copies). All of the above (§3) reflects the *fixed* design; the raw findings are not reproduced here as they no longer describe the code. Remaining accepted risks, deliberately not fixed this stage: `PRAGMA foreign_key_check` scans the whole database rather than just the newly migrated tables (theoretical today — no FK tables exist yet); the exclusivity check before restore is best-effort on POSIX (accepted: Windows-only product); restore has no UI/IPC entry point yet (Stage 1 explicitly excludes a backup-manager UI — it is a tested library capability, wired up when a real caller needs it).
