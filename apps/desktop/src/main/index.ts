// Desktop composition root (ARCHITECTURE §9): config/path → SQLite connection (+ migrations)
// → repositories → application services → IPC handlers.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "@living-map/application";
import { IPC_CHANNELS } from "@living-map/contracts/ipc";
import {
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  resolveDataHome,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { createCaptureProcessor } from "./ai/capture-processor";
import { createClaudeCodeCliAiRunner } from "./ai/claude-code-cli";
import { createReviewProcessor } from "./ai/review-processor";
import { serializeAiRunner } from "./ai/serialize";
import { createCalendarOrchestrator } from "./calendar";
import { registerIpcHandlers } from "./ipc";
import { watchStateRevision } from "./revision-watcher";
import { createMainWindow, isTrustedRendererFrame } from "./window";
import { manageWorkLifecycle } from "./work-lifecycle";

/**
 * Distinguishes storage failure modes for the user-facing dialog (never a raw stack trace or
 * local path). Whichever branch fires, the app exits without touching the existing file — never
 * silently replacing a broken existing database with a new empty one.
 */
function describeOpenFailure(message: string): string {
  if (/newer than this app/.test(message)) {
    return "Данные были созданы более новой версией Живой карты. Обновите приложение.";
  }
  if (/not a database|malformed|file is encrypted|exists but is empty/i.test(message)) {
    return "Локальные данные Живой карты повреждены. Резервная копия может быть доступна в папке backups приложения; подробности в логах.";
  }
  return "Живой карте не удалось открыть локальные данные. Подробности в логах.";
}

function openDatabaseOrExit(): SqliteHandle | undefined {
  try {
    return openDesktopDatabase(databaseFile(resolveDataHome()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[living-map] cannot open database: ${message}`);
    dialog.showErrorBox("Живая карта", describeOpenFailure(message));
    app.exit(1);
    return undefined;
  }
}

// One process per database: a second launch must not "crash-recover" the first one's running work.
// Electron keys the lock by userData, so an overridden data home (tests) gets its own.
if (process.env.LIVING_MAP_HOME?.trim()) app.setPath("userData", join(resolveDataHome(), "electron"));
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  const handle = openDatabaseOrExit();
  if (!handle) return;

  const application = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: systemClock,
    ids: uuidGenerator,
    reportError: (operation, error) =>
      console.error(`[living-map] ${operation} failed: ${error instanceof Error ? error.message : "unknown"}`),
  });

  // Before any window: a running interval left by a crash is capped and paused first.
  const pauseWorkOnQuit = manageWorkLifecycle(application, powerMonitor);

  const calendar = createCalendarOrchestrator(application, resolveDataHome());

  // In-app AI (ADR-0007): the AI host is started only on demand and talks to the built LivingMap MCP
  // server, run by this same Electron binary in Node mode against this app's data home.
  const aiRunner = serializeAiRunner(
    createClaudeCodeCliAiRunner({
      mcpServer: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./mcp.js", import.meta.url))],
        env: { ELECTRON_RUN_AS_NODE: "1", LIVING_MAP_HOME: resolveDataHome() },
      },
      workDir: join(resolveDataHome(), "ai-workdir"),
    }),
  );
  const captures = createCaptureProcessor(application, aiRunner, (message) => console.error(`[living-map] ${message}`));
  // Reviews (Stage 7): same replaceable AiRunner, a second job kind, no background service — due
  // periods are determined and processing starts only at launch (start(), below).
  const reviews = createReviewProcessor(
    application,
    aiRunner,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    (message) => console.error(`[living-map] ${message}`),
  );
  registerIpcHandlers(application, isTrustedRendererFrame, calendar, captures, reviews);
  // Refresh on launch (Stage 4 §7/§20): a no-op when never connected; otherwise the renderer sees
  // an up-to-date snapshot without the user having to press "Обновить" first. Fire-and-forget —
  // does not delay window creation, and the revision watcher below picks up the result.
  void calendar.refresh("system");

  // Picks up writes made by the MCP process (or anyone) and tells the renderer to re-query (ARCHITECTURE §15).
  const stopWatching = watchStateRevision(application, (change) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_CHANNELS.stateChanged, change);
  });

  createMainWindow();
  // After a crash mid-processing / pending from earlier: retried now, never by a background service.
  captures.start();
  // Reviews (Stage 7): determines due periods and recovers interrupted rows, then starts processing.
  reviews.start();

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    captures.stop();
    reviews.stop();
    stopWatching();
    pauseWorkOnQuit();
    handle.close();
  });
});
