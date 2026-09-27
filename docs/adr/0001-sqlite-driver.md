# ADR-0001 — SQLite driver: better-sqlite3 13

**Статус:** принято (технический spike, 27.09.2026)
**Закрывает:** ARCHITECTURE.md §50.1

## Контекст

Требования (ARCHITECTURE §3): Windows x64, работа внутри Electron main, транзакции, WAL, короткие конкурентные записи из двух локальных процессов (Electron main + MCP Node process), совместимость с Drizzle, без отдельного процесса БД.

Окружение на момент решения: Electron 44.4.5 (Node 24.21, ABI 149), Node 24.15, Drizzle ORM 0.45.3 (stable), на машине **нет MSVC toolchain** (node-gyp сборка невозможна).

## Рассмотренные варианты (только реально подходящие)

| | better-sqlite3 13.0.3 | `node:sqlite` (встроен в Node/Electron) | @libsql/client 0.18 |
|---|---|---|---|
| Drizzle stable (0.45.3) | ✅ `drizzle-orm/better-sqlite3` | ❌ только в 1.0 RC (`drizzle-orm/node-sqlite`) | ✅ `drizzle-orm/libsql` |
| Нативная сборка под Electron | не нужна: **N-API prebuild внутри tarball**, нет install-скрипта | не нужна | не нужна (N-API) |
| Один бинарь для Node и Electron | ✅ проверено (SQLite 3.53.4 в обоих) | ✅ проверено в Electron 44 | ✅ |
| API | синхронный, `transaction().immediate()` | синхронный, стабильность API ещё двигается | асинхронный, форк SQLite (libSQL) |
| Зрелость в Electron | де-факто стандарт | молодой | меньше опыта именно в Electron main |

## Решение

**better-sqlite3 13.0.3 + drizzle-orm 0.45.3.**

Причины:

1. Единственный вариант, одновременно поддержанный **стабильным** Drizzle и не требующий нативной сборки.
2. v13 перешёл на N-API: `prebuilds/win32-x64.node` лежит внутри npm-пакета, ABI-стабилен → тот же бинарь грузится в Node 24 (MCP) и Electron 44 (main) без `electron-rebuild`.
3. Синхронные транзакции естественно обеспечивают «короткие write-транзакции» (ARCHITECTURE §12): внутри транзакции физически нельзя сделать `await`.
4. `BEGIN IMMEDIATE` доступен из Drizzle (`{ behavior: "immediate" }`).

`node:sqlite` — сильный кандидат на будущее (ноль зависимостей). Пересмотреть, когда Drizzle 1.0 с `node-sqlite` станет stable. Замена затронет только `packages/persistence-sqlite`.

## Последствия

- `pnpm-workspace.yaml`: `allowBuilds.better-sqlite3: false` — неявный node-gyp build запрещён (он не нужен и без MSVC упал бы).
- Доказательства: `packages/persistence-sqlite/test/sqlite.test.ts`, `apps/mcp/test/mcp-process.test.ts`, `apps/desktop/e2e/spike.spec.ts` (реальный Electron main).
- Упаковка (electron-builder + asar unpack для `.node`) не проверялась — это этап «Локальный фундамент».
