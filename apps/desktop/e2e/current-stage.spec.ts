import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

// Stage 9, Day 1 hotfix (2026-10-06), through the real desktop UI: the owner adds a Stage by hand, makes it
// current and moves it to the top — `Сейчас` must follow at once and after a reload; an empty current Stage
// must say so instead of showing the old AI Action. Business rules are covered in
// packages/persistence-sqlite/test/current-stage.test.ts; this only proves the screens are wired to them.
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(desktopDir, "..", "mcp");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;
let mcp: Client | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-stage-"));
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
  const client = new Client({ name: "e2e-stage-host", version: "0" });
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

/** The old AI-routed project: Stage «Старый этап» with one Action, ordered by an accepted route Proposal. */
async function seedOldAiProject(win: Page): Promise<string> {
  const seeded = await win.evaluate(async () => {
    const c = window.livingMap.commands;
    await c.createSeason({ focus: "Сезон" });
    const intention = await c.createIntention({ title: "Проект P", desiredResult: "P готов" });
    if (!intention.ok) throw new Error("intention");
    const stage = await c.addStage({ intentionId: intention.value.id, title: "Старый этап" });
    if (!stage.ok) throw new Error("stage");
    const action = await c.addAction({ stageId: stage.value.id, title: "Старое действие ИИ", doneWhen: "готово" });
    if (!action.ok) throw new Error("action");
    return { intentionId: intention.value.id, actionId: action.value.id };
  });
  mcp = await connectMcp();
  const ctx = await tool<{ stateRevision: number }>("get_living_map_context");
  const proposal = await tool<{ id: string }>("create_route_proposal", {
    intentionId: seeded.intentionId,
    expectedRevision: ctx.stateRevision,
    summary: "Порядок",
    rationale: "Порядок",
    newStages: [],
    newActions: [],
    actionEdits: [],
    actionOrder: [seeded.actionId],
  });
  const accepted = await win.evaluate(
    async (id) => await window.livingMap.commands.acceptProposal({ id }),
    proposal.id,
  );
  expect(accepted.ok).toBe(true);
  return seeded.actionId;
}

test("hotfix: «Сделать текущим» and Stage order drive `Сейчас`, an empty current Stage says so, all survive a reload", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const oldActionId = await seedOldAiProject(win);
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", oldActionId);

  // The owner adds the Stage she really needs, by hand, in «Проекты».
  await win.getByTestId("nav-editor").click();
  await win.getByTestId("stage-new").fill("Нужный этап");
  await win.getByTestId("stage-add").click();
  // New Stages are appended: the last block is the one just added.
  await expect(win.getByTestId("stage")).toHaveCount(2);
  const wanted = win.getByTestId("stage").last();
  await expect(wanted.getByTestId("stage-title")).toHaveValue("Нужный этап");
  await wanted.getByTestId("action-title-new").fill("Нужное действие");
  await wanted.getByTestId("action-done-when-new").fill("сделано");
  await wanted.getByTestId("action-add").click();
  await expect(wanted.getByTestId("action")).toHaveCount(1);

  // She makes it current and moves it to the top of the Stage list.
  await wanted.getByTestId("stage-set-current").click();
  await expect(wanted.getByTestId("stage-current-badge")).toBeVisible();
  await wanted.getByTestId("move-up").first().click();
  await expect(win.getByTestId("stage").first().getByTestId("stage-title")).toHaveValue("Нужный этап");

  // Back on the main screen `Сейчас` is HER Stage's Action, not the old AI one.
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("now-action")).toContainText("Нужное действие");
  await expect(win.getByTestId("now-stage")).toContainText("Нужный этап");
  await expect(win.getByTestId("now-action")).not.toHaveAttribute("data-id", oldActionId);

  await win.reload();
  await expect(win.getByTestId("now-action")).toContainText("Нужное действие");

  // An empty Stage made current: an honest empty state, never the old Action behind her back.
  await win.getByTestId("nav-editor").click();
  await win.getByTestId("stage-new").fill("Пустой этап");
  await win.getByTestId("stage-add").click();
  await expect(win.getByTestId("stage")).toHaveCount(3);
  const empty = win.getByTestId("stage").last();
  await expect(empty.getByTestId("stage-title")).toHaveValue("Пустой этап");
  await empty.getByTestId("stage-set-current").click();
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("now-empty-stage")).toContainText("В текущем этапе пока нет следующего действия.");
  await expect(win.getByTestId("now-action")).toHaveCount(0);
  await expect(win.getByTestId("now-needs-replan")).toHaveCount(0);
  await expect(win.getByTestId("now-empty-stage-ask-ai")).toBeVisible();

  await win.reload();
  await expect(win.getByTestId("now-empty-stage")).toBeVisible();
  await expect(win.getByTestId("now-action")).toHaveCount(0);

  // «Добавить действие» leads to where Actions are added.
  await win.getByTestId("now-empty-stage-add").click();
  await expect(win.getByTestId("stages")).toBeVisible();

  // The navigation speaks the new word.
  await expect(win.getByTestId("nav-reviews")).toContainText("Анализ");
  await expect(win.getByTestId("nav-reviews")).not.toContainText("Разбор");

  await app.close();
});

test("manual order is authoritative: arrows on Actions change `Сейчас`, «Сделать текущим» wins over the old AI plan, all survive a restart", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const oldActionId = await seedOldAiProject(win);
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", oldActionId);

  // The owner creates the Stage and the three Actions she actually wants, by hand.
  await win.getByTestId("nav-editor").click();
  await win.getByTestId("stage-new").fill("Мой этап");
  await win.getByTestId("stage-add").click();
  await expect(win.getByTestId("stage")).toHaveCount(2);
  const mine = win.getByTestId("stage").last();
  for (const [i, title] of ["Первое", "Второе", "Третье"].entries()) {
    await mine.getByTestId("action-title-new").fill(title);
    await mine.getByTestId("action-done-when-new").fill("сделано");
    await mine.getByTestId("action-add").click();
    await expect(mine.getByTestId("action")).toHaveCount(i + 1);
  }
  await expect(mine.getByTestId("action")).toHaveCount(3);

  // Hand-made Actions are in the order — no «Не входят в порядок» leftovers, no «only display order» disclaimer.
  await expect(win.getByTestId("plan-unplanned")).toHaveCount(0);
  await expect(win.getByText("Не входят в порядок")).toHaveCount(0);
  await expect(win.getByText("только порядок показа")).toHaveCount(0);

  // Stage up, «Сделать текущим», then the arrows: «Третье» up twice.
  await mine.getByTestId("stage-set-current").click();
  await mine.getByTestId("move-up").first().click();
  const top = win.getByTestId("stage").first();
  await expect(top.getByTestId("stage-title")).toHaveValue("Мой этап");
  await top.getByTestId("action").nth(2).getByTestId("move-up").click();
  await top.getByTestId("action").nth(1).getByTestId("move-up").click();
  await expect(top.getByTestId("action-title").first()).toHaveValue("Третье");

  // The main screen shows exactly the first Action of HER Stage in HER order — not the old AI Action.
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("now-action")).toContainText("Третье");
  await expect(win.getByTestId("now-action")).not.toHaveAttribute("data-id", oldActionId);
  await expect(win.getByTestId("now-stage")).toContainText("Мой этап");

  // And the order the screen offers on demand is that very order (one order, not two).
  await win.getByTestId("now-toggle-order").click();
  await expect(win.getByTestId("plan-item").first()).toContainText("Третье");
  await expect(win.getByTestId("plan-item").last()).toContainText("Старое действие ИИ");
  await expect(win.getByText("только порядок показа")).toHaveCount(0);

  // Back in the project: «Второе» to the top — `Сейчас` changes.
  await win.getByTestId("nav-editor").click();
  const again = win.getByTestId("stage").first();
  await again.getByTestId("action").nth(2).getByTestId("move-up").click();
  await again.getByTestId("action").nth(1).getByTestId("move-up").click();
  await expect(again.getByTestId("action-title").first()).toHaveValue("Второе");
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("now-action")).toContainText("Второе");

  // Reload and a real restart: the same order and the same `Сейчас`.
  await win.reload();
  await expect(win.getByTestId("now-action")).toContainText("Второе");
  await app.close();

  const reopened = await launch();
  const win2 = await reopened.firstWindow();
  await expect(win2.getByTestId("now-action")).toContainText("Второе");
  await win2.getByTestId("nav-editor").click();
  await expect(win2.getByTestId("stage").first().getByTestId("stage-title")).toHaveValue("Мой этап");
  await expect(win2.getByTestId("stage").first().getByTestId("action-title").first()).toHaveValue("Второе");
  await reopened.close();
});
