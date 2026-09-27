import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, shell, type WebFrameMain } from "electron";

// Dev server URL is honoured only in unpackaged builds: an inherited env var must never
// point the privileged window (with the preload API) at remote content.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const rendererFile = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const rendererFileUrl = pathToFileURL(rendererFile).href;

/** Only the top-level frame showing our own renderer may call IPC. */
export function isTrustedRendererFrame(frame: WebFrameMain | null): boolean {
  if (!frame || frame.parent !== null) return false;
  try {
    const url = new URL(frame.url);
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    url.hash = "";
    url.search = "";
    return url.href === rendererFileUrl;
  } catch {
    return false;
  }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: "Living Map — spike",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // No remote content in the main window; external links open explicitly in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(rendererFile);
  return win;
}
