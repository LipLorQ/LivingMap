import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

// resolve() drops the trailing "\": on Windows it would escape the closing quote of the launch argument.
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(desktopDir, "..", "mcp");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;
let mcp: Client | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-work-"));
});
test.afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  rmSync(home, { recursive: true, force: true });
});

function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, LIVING_MAP_HOME: home } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: electronPath, args: [desktopDir], env });
}

async function connectMcp(): Promise<Client> {
  const client = new Client({ name: "e2e-work-host", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: mcpDir,
      env: { ...getDefaultEnvironment(), LIVING_MAP_HOME: home },
      stderr: "pipe",
    }),
  );
  return client;
}

async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!mcp) throw new Error("mcp not connected");
  const res = await mcp.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  const parsed = JSON.parse(text) as { ok: boolean; value: T; error?: { message: string } };
  if (!parsed.ok) throw new Error(`${name}: ${parsed.error?.message}`);
  return parsed.value;
}

type Ctx = {
  stateRevision: number;
  intention: { id: string };
  stages: { id: string; actions: { id: string; title: string }[] }[];
};
type SeededActions = { a1: string; a2: string };

async function seed(win: Page): Promise<SeededActions> {
  return win.evaluate(async () => {
    const c = window.livingMap.commands;
    await c.createIntention({ title: "Запустить продукт", desiredResult: "Продуктом пользуются каждый день" });
    const view = await window.livingMap.queries.getCurrentView();
    if (!view.ok || !view.value.intention) throw new Error("intention");
    const s = await c.addStage({ intentionId: view.value.intention.id, title: "Основа" });
    if (!s.ok) throw new Error("stage");
    const first = await c.addAction({ stageId: s.value.id, title: "Первое действие", doneWhen: "готово 1" });
    const second = await c.addAction({ stageId: s.value.id, title: "Второе действие", doneWhen: "готово 2" });
    if (!first.ok || !second.ok) throw new Error("action");
    return { a1: first.value.id, a2: second.value.id };
  });
}

/** Orders the two already-existing (unfinished) Actions into a plan via a real first-route Proposal. */
async function proposeAndAcceptOrder(win: Page, actions: SeededActions): Promise<void> {
  const ctx = await tool<Ctx>("get_living_map_context");
  const proposal = await tool<{ id: string }>("create_route_proposal", {
    intentionId: ctx.intention.id,
    expectedRevision: ctx.stateRevision,
    summary: "Двигаться по порядку: сначала первое, потом второе",
    rationale: "Первое действие логически предшествует второму",
    newStages: [],
    newActions: [],
    actionEdits: [],
    actionOrder: [actions.a1, actions.a2],
  });
  const accepted = await win.evaluate(
    async (id) => await window.livingMap.commands.acceptProposal({ id }),
    proposal.id,
  );
  expect(accepted.ok).toBe(true);
}

test("Stage 5: Начать → Пауза → Продолжить → quit pauses → Готово moves Сейчас; totals and target", async () => {
  let app = await launch();
  let win = await app.firstWindow();
  const actions = await seed(win);
  mcp = await connectMcp();
  await proposeAndAcceptOrder(win, actions);

  // Idle: the current Action offers Начать; totals and the 6 h target are visible but secondary.
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", actions.a1);
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await expect(win.getByTestId("work-timer")).toHaveText("00:00");
  await expect(win.getByTestId("work-today")).toHaveText("Сегодня: 0 мин / 6 ч");
  await expect(win.getByTestId("work-week")).toHaveText("За неделю: 0 мин");
  await expect(win.getByTestId("work-start")).toHaveText("Начать");

  // Running: live timer and Пауза.
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await expect(win.getByTestId("work-pause")).toHaveText("Пауза");
  await expect(win.getByTestId("work-timer")).not.toHaveText("00:00", { timeout: 3000 });

  // Paused: frozen, Продолжить.
  await win.getByTestId("work-pause").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "paused");
  await expect(win.getByTestId("work-start")).toHaveText("Продолжить");
  const frozen = await win.getByTestId("work-timer").textContent();
  await win.waitForTimeout(1500);
  await expect(win.getByTestId("work-timer")).toHaveText(frozen ?? "");

  // Target is an editable setting.
  await win.getByTestId("work-target-edit").click();
  await win.getByTestId("work-target-hours").fill("5");
  await win.getByTestId("work-target-save").click();
  await expect(win.getByTestId("work-today")).toContainText("/ 5 ч");

  // Resume, then really quit the app while running: it comes back paused with the time kept.
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await win.waitForTimeout(1200);
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "paused");
  await expect(win.getByTestId("work-start")).toHaveText("Продолжить");
  await expect(win.getByTestId("work-timer")).not.toHaveText("00:00");

  // Готово while running is one click: next Action becomes Сейчас with its own fresh timer.
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await win.getByTestId("work-complete").click();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", actions.a2);
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await expect(win.getByTestId("work-timer")).toHaveText("00:00");

  // Completing the last Action → NeedsAIReplan, totals still shown.
  await win.getByTestId("work-complete").click();
  await expect(win.getByTestId("now-needs-replan")).toBeVisible();
  await expect(win.getByTestId("work-today-idle")).toContainText("/ 5 ч");

  // Readable Russian history of the meaningful execution events.
  await win.getByTestId("nav-editor").click();
  const history = win.getByTestId("history-entry");
  await expect(history.filter({ hasText: "Работа начата" })).toHaveCount(1);
  await expect(history.filter({ hasText: "Работа продолжена" })).toHaveCount(2);
  await expect(history.filter({ hasText: "Работа поставлена на паузу" })).toHaveCount(2);
  // Both were real pauses (Пауза / quit), not crash recovery.
  await expect(history.filter({ hasText: "после сбоя" })).toHaveCount(0);

  await app.close();
});
