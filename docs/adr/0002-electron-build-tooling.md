# ADR-0002 — Electron build tooling: electron-vite 5 + Vite 7

**Статус:** принято (технический spike, 27.09.2026)
**Закрывает:** ARCHITECTURE.md §50.2 (build detail, не архитектурное решение)

## Решение

- **electron-vite 5.0.0** (stable) собирает main / preload / renderer одним конфигом.
- **Vite 7.3.6** — electron-vite 5.0.0 поддерживает Vite ≤ 7 (Vite 8 — только в 6.0 beta).
- **@vitejs/plugin-react 5.2.0** (v6 требует Vite 8), **Tailwind 4** через `@tailwindcss/vite`.
- Workspace-пакеты (`@living-map/*`) — это TS-исходники без собственного build-шага; main-бандл включает их (`externalizeDeps.exclude`), а `better-sqlite3` и прочие `dependencies` остаются external.
- Preload: единый **CJS**-файл (`index.cjs`), т.к. sandboxed preload не поддерживает ESM и произвольный `require`.
- MCP-процесс: `esbuild` → один `apps/mcp/dist/main.js` (external только `better-sqlite3`), для запуска AI-host'ом обычным `node`. В тестах MCP запускается из исходников через `tsx`.

Почему не Electron Forge: навязывает собственный lifecycle/структуру; для spike и MVP достаточно electron-vite. Упаковщик (вероятно electron-builder) выбирается на этапе «Локальный фундамент».

## Отложено сознательно

- shadcn/ui и React Router входят в стек, но не нужны для доказательства архитектуры — подключаются вместе с первым реальным UI.
- Packaging/installer, code signing, auto-update — не текущий этап.

## Замечено при spike

- pnpm 12 требует явного `allowBuilds` для install-скриптов (`electron`, `esbuild`).
- Electron 44 скачивает бинарь лениво при первом `require('electron')` (или `node node_modules/electron/install.js`).
- Playwright `_electron.launch`: путь приложения без завершающего `\` — иначе на Windows аргумент ломается (кавычка экранируется).
