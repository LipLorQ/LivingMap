import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

// resolve() drops the trailing "\": on Windows it would escape the closing quote of the launch argument.
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
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

test("Stage 2: one real Intention through the actual UI, surviving a restart", async () => {
  const app = await launch();
  const win = await app.firstWindow();

  // 1. Hardened window + renderer isolation (still required — ARCHITECTURE §38).
  const prefs = await app.evaluate(({ BrowserWindow }) => {
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
    };
  });
  expect(surface).toEqual({
    require: "undefined",
    process: "undefined",
    ipcRenderer: "undefined",
    api: ["commands", "events", "queries"],
  });

  // Stage 4: manual editing moved behind the "Замысел" tab; "Сейчас" is the default screen.
  await win.getByTestId("nav-editor").click();

  // 2. Season.
  await win.getByTestId("season-focus").fill("Recover and rebuild momentum");
  await win.getByTestId("season-save").click();
  await expect(win.getByTestId("season-save")).toHaveText("Сохранить фокус");

  // 3. Good Life Conditions.
  await win.getByTestId("condition-new").fill("Sleep 8 hours");
  await win.getByTestId("condition-add").click();
  await expect(win.getByTestId("condition")).toHaveCount(1);

  // 4. Main re-validates renderer payloads (renderer is untrusted) — an extra key is rejected.
  const invalid = await win.evaluate(() =>
    window.livingMap.commands.createIntention({ title: "x", desiredResult: "", sql: "drop table season" } as never),
  );
  expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

  // 5. One real Intention, Desired Result, Stage, Action, doneWhen.
  await win.getByTestId("intention-title-new").fill("Ship the Living Map MVP");
  await win.getByTestId("intention-desired-result-new").fill("Living Map is used daily for a real Intention");
  await win.getByTestId("intention-create-submit").click();
  await expect(win.getByTestId("intention")).toBeVisible();

  await win.getByTestId("stage-new").fill("Foundation");
  await win.getByTestId("stage-add").click();
  await expect(win.getByTestId("stage")).toHaveCount(1);
  await expect(win.getByTestId("stage-current-badge")).toBeVisible();

  await win.getByTestId("action-title-new").fill("Model the domain");
  await win.getByTestId("action-done-when-new").fill("Season/Intention/Stage/Action persist and survive restart");
  await win.getByTestId("action-add").click();
  await expect(win.getByTestId("action")).toHaveCount(1);
  await expect(win.getByTestId("action-status")).toHaveText("в работе");

  // 6. Block → cannot complete while blocked → unblock → complete.
  await win.getByTestId("action-block-reason").fill("waiting on review");
  await win.getByTestId("action-block").click();
  await expect(win.getByTestId("action-status")).toHaveText("заблокировано");
  await expect(win.getByTestId("action-blocker-reason")).toContainText("waiting on review");

  await win.getByTestId("action-unblock").click();
  await expect(win.getByTestId("action-status")).toHaveText("в работе");

  await win.getByTestId("action-complete").click();
  await expect(win.getByTestId("action-status")).toHaveText("готово");

  // 7. Reopen undoes an accidental completion, then it can be completed again.
  await win.getByTestId("action-reopen").click();
  await expect(win.getByTestId("action-status")).toHaveText("в работе");

  await win.getByTestId("action-complete").click();
  await expect(win.getByTestId("action-status")).toHaveText("готово");

  // 8. Meaningful change history is visible.
  // Collapsed by default, expandable on demand.
  await expect(win.getByTestId("history-entry").first()).toBeHidden();
  await win.getByTestId("change-history").getByText("История изменений").click();
  await expect(win.getByTestId("history-entry").first()).toBeVisible();

  // 9. Full state survives an app restart.
  await app.close();
  const again = await launch();
  const win2 = await again.firstWindow();
  await win2.getByTestId("nav-editor").click();
  await expect(win2.getByTestId("season-focus")).toHaveValue("Recover and rebuild momentum");
  await expect(win2.getByTestId("condition")).toHaveCount(1);
  await expect(win2.getByTestId("intention-title")).toHaveValue("Ship the Living Map MVP");
  await expect(win2.getByTestId("action-status")).toHaveText("готово");
  await again.close();
});
