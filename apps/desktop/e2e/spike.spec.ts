import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

// resolve() drops the trailing "\": on Windows it would escape the closing quote of the launch argument.
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(fileURLToPath(new URL("../../mcp", import.meta.url)));
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-"));
});
test.afterEach(() => rmSync(home, { recursive: true, force: true }));

function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, LIVING_MAP_HOME: home } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: electronPath, args: [desktopDir], env });
}

async function spawnMcp(): Promise<Client> {
  const client = new Client({ name: "living-map-e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: mcpDir,
      env: { ...getDefaultEnvironment(), LIVING_MAP_HOME: home },
    }),
  );
  return client;
}

test("spike: secure renderer ↔ main, shared SQLite with MCP, conflicts, persistence", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await expect(win.getByTestId("revision")).toHaveText("0");

  // 1. Hardened window + renderer isolation.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences() exists at runtime but is absent from electron.d.ts.
    const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as {
      getLastWebPreferences(): Electron.WebPreferences;
    };
    const p = wc?.getLastWebPreferences();
    return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox };
  });
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });

  const surface = await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      ipcRenderer: typeof w.ipcRenderer,
      api: Object.keys(window.livingMap).sort(),
      commands: Object.keys(window.livingMap.commands).sort(),
    };
  });
  expect(surface).toEqual({
    require: "undefined",
    process: "undefined",
    ipcRenderer: "undefined",
    api: ["commands", "events", "queries"],
    commands: ["createProbe", "renameProbe"],
  });

  // 2. UI → preload → main → application → SQLite.
  await win.getByTestId("new-title").fill("created in UI");
  await win.getByTestId("create").click();
  await expect(win.getByTestId("probe-title")).toHaveText("created in UI");
  await expect(win.getByTestId("revision")).toHaveText("1");
  const id = await win.getByTestId("probe").getAttribute("data-id");
  expect(id).toBeTruthy();

  // 3. Main re-validates renderer payloads (renderer is untrusted).
  const invalid = await win.evaluate(
    (probeId) =>
      window.livingMap.commands.renameProbe({ id: probeId, expectedVersion: 1, title: "x", sql: "drop" } as never),
    id as string,
  );
  expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

  // 4. Separate MCP process writes to the same DB → revision watcher → renderer refreshes.
  const mcp = await spawnMcp();
  const mcpRename = (expectedVersion: number, title: string) =>
    mcp.callTool({ name: "rename_probe", arguments: { id, expectedVersion, title } });
  try {
    expect((await mcpRename(1, "renamed by MCP")).isError).toBeFalsy();
    await expect(win.getByTestId("probe-title")).toHaveText("renamed by MCP");
    await expect(win.getByTestId("probe-version")).toHaveText("v2");
    await expect(win.getByTestId("revision")).toHaveText("2");

    // 5a. A stale write through the preload API (based on v1) must not overwrite MCP's change.
    const stale = await win.evaluate(
      (probeId) => window.livingMap.commands.renameProbe({ id: probeId, expectedVersion: 1, title: "stale UI" }),
      id as string,
    );
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT_RELOAD" } });

    // 5b. Same through the real UI: the user starts editing at v2, MCP changes the probe, the user submits.
    await win.getByTestId("rename-title").fill("edited in UI");
    expect((await mcpRename(2, "MCP again")).isError).toBeFalsy();
    await expect(win.getByTestId("probe-title")).toHaveText("MCP again");
    await win.getByTestId("rename").click();
    await expect(win.getByTestId("error")).toContainText("CONFLICT_RELOAD");
    await expect(win.getByTestId("probe-title")).toHaveText("MCP again");
    await expect(win.getByTestId("probe-version")).toHaveText("v3");

    // 5c. An edit based on the current version goes through.
    await win.getByTestId("rename-title").fill("final from UI");
    await win.getByTestId("rename").click();
    await expect(win.getByTestId("probe-title")).toHaveText("final from UI");
    await expect(win.getByTestId("probe-version")).toHaveText("v4");
    await expect(win.getByTestId("revision")).toHaveText("4");
    await expect(win.getByTestId("error")).toHaveCount(0);
  } finally {
    await mcp.close();
  }

  // 6. State survives an app restart.
  await app.close();
  const again = await launch();
  const win2 = await again.firstWindow();
  await expect(win2.getByTestId("probe-title")).toHaveText("final from UI");
  await expect(win2.getByTestId("revision")).toHaveText("4");
  await again.close();
});
