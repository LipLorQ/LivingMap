// Desktop composition root (ARCHITECTURE §9): config/path → SQLite connection (+ migrations)
// → repositories → application services → IPC handlers.
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
import { app, BrowserWindow, dialog } from "electron";
import { createCalendarOrchestrator } from "./calendar";
import { registerIpcHandlers } from "./ipc";
import { watchStateRevision } from "./revision-watcher";
import { createMainWindow, isTrustedRendererFrame } from "./window";

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

app.whenReady().then(() => {
  const handle = openDatabaseOrExit();
  if (!handle) return;

  const application = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: systemClock,
    ids: uuidGenerator,
    reportError: (operation, error) =>
      console.error(`[living-map] ${operation} failed: ${error instanceof Error ? error.message : "unknown"}`),
  });

  const calendar = createCalendarOrchestrator(application, resolveDataHome());
  registerIpcHandlers(application, isTrustedRendererFrame, calendar);
  // Refresh on launch (Stage 4 §7/§20): a no-op when never connected; otherwise the renderer sees
  // an up-to-date snapshot without the user having to press "Обновить" first. Fire-and-forget —
  // does not delay window creation, and the revision watcher below picks up the result.
  void calendar.refresh("system");

  // Picks up writes made by the MCP process (or anyone) and tells the renderer to re-query (ARCHITECTURE §15).
  const stopWatching = watchStateRevision(application, (change) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_CHANNELS.stateChanged, change);
  });

  createMainWindow();

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    stopWatching();
    handle.close();
  });
});
