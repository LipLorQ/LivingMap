import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(desktopDir, "..", "mcp");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;
let mcp: Client | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-ai-"));
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

/** A separate MCP process, launched exactly like an AI host would (stdio), on the same data home. */
async function connectMcp(): Promise<Client> {
  const client = new Client({ name: "e2e-ai-host", version: "0" });
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

async function seed(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const c = window.livingMap.commands;
    await c.createSeason({ focus: "Восстановить силы и темп" });
    await c.addGoodLifeCondition({ text: "Сон 8 часов" });
    const i = await c.createIntention({
      title: "Запустить продукт",
      desiredResult: "Продуктом пользуются каждый день",
    });
    if (!i.ok) throw new Error("intention");
    const s = await c.addStage({ intentionId: i.value.id, title: "Основа" });
    if (!s.ok) throw new Error("stage");
    await c.addAction({ stageId: s.value.id, title: "Описать модель", doneWhen: "тесты зелёные" });
  });
}

async function proposeRoute(): Promise<void> {
  const ctx = await tool<Ctx>("get_living_map_context");
  const stage = ctx.stages[0];
  const existing = stage?.actions[0];
  if (!stage || !existing) throw new Error("seed missing");
  await tool("create_route_proposal", {
    intentionId: ctx.intention.id,
    expectedRevision: ctx.stateRevision,
    summary: "Проверить идею на людях перед тем, как строить дальше",
    rationale: "Сначала проверить идею на людях, потом строить",
    newStages: [{ ref: "check", title: "Проверка" }],
    newActions: [{ ref: "talk", stage: "check", title: "Поговорить с тремя людьми", doneWhen: "три заметки" }],
    actionEdits: [{ actionId: existing.id, title: "Описать доменную модель", doneWhen: "все тесты зелёные" }],
    stageOrder: ["check", stage.id],
    actionOrder: ["talk", existing.id],
  });
}

test("Stage 3: an external AI proposal appears live, is reviewed in Russian, rejected / stale / accepted, and survives restart", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await seed(win);
  // Stage 4: manual/AI-route review lives behind the "Замысел" tab; "Сейчас" is the default screen.
  await win.getByTestId("nav-editor").click();
  await expect(win.getByTestId("plan-empty")).toBeVisible();
  mcp = await connectMcp();

  // 1. Created externally while the app is open → appears without restart (revision watch).
  await proposeRoute();
  const card = win.getByTestId("proposal");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Предложение ИИ: Первый маршрут");
  for (const label of [
    "Зачем это",
    "Подробнее о логике",
    "Что изменится",
    "Новый маршрут",
    "Порядок действий",
    "Подтвердить",
    "Отклонить",
  ]) {
    await expect(card).toContainText(label);
  }
  await expect(card).toContainText("Проверить идею на людях перед тем, как строить дальше");
  // Detailed rationale is collapsed by default, expandable on demand.
  await expect(win.getByTestId("proposal-rationale")).toBeHidden();
  await card.getByText("Подробнее о логике").click();
  await expect(win.getByTestId("proposal-rationale")).toContainText("Сначала проверить идею на людях, потом строить");
  await expect(win.getByTestId("proposal-stage")).toHaveCount(2);
  await expect(win.getByTestId("proposal-stage").first()).toContainText("Проверка");
  await expect(win.getByTestId("proposal-order")).toContainText("Поговорить с тремя людьми");
  await expect(card).toContainText("было: Описать модель");
  // Nothing has been applied yet.
  await expect(win.getByTestId("stage")).toHaveCount(1);
  // No English leaks into the product UI (all seed/AI content here is Russian).
  expect(await win.locator("main").innerText()).not.toMatch(/[A-Za-z]/);

  // 2. Reject → strategic state unchanged.
  await win.getByTestId("proposal-reject").click();
  await expect(card).toHaveCount(0);
  await expect(win.getByTestId("stage")).toHaveCount(1);
  await expect(win.getByTestId("history-entry").first()).toHaveText("Отклонено предложение ИИ");

  // 3. Stale: the user changes the Intention after the AI proposed → cannot be confirmed.
  await proposeRoute();
  await expect(card).toBeVisible();
  await win.getByTestId("action-done-when").fill("тесты зелёные и ревью пройдено");
  await win.getByTestId("action-done-when-save").click();
  await expect(win.getByTestId("proposal-stale")).toHaveText(
    "Предложение устарело, потому что Живая карта изменилась. Попроси ИИ пересобрать его.",
  );
  await expect(win.getByTestId("proposal-accept")).toHaveCount(0);
  await win.getByTestId("proposal-reject").click();
  await expect(card).toHaveCount(0);

  // 4. Accept → route and order appear, attributed to the AI proposal.
  await proposeRoute();
  await win.getByTestId("proposal-accept").click();
  await expect(card).toHaveCount(0);
  await expect(win.getByTestId("stage")).toHaveCount(2);
  await expect(win.getByTestId("plan-item")).toHaveText(["Поговорить с тремя людьми", "Описать доменную модель"]);
  await expect(win.getByTestId("plan")).toContainText("Порядок составил ИИ");
  await expect(win.getByTestId("history-entry").first()).toHaveText("Принято предложение ИИ: маршрут");
  expect(await win.locator("main").innerText()).not.toMatch(/[A-Za-z]/);

  // MCP sees the same accepted state.
  const after = await tool<Ctx & { orderedActionPlan: { orderedActionIds: string[] } }>("get_living_map_context");
  expect(after.orderedActionPlan.orderedActionIds).toHaveLength(2);

  // 5. Survives restart.
  await app.close();
  const again = await launch();
  const win2 = await again.firstWindow();
  await win2.getByTestId("nav-editor").click();
  await expect(win2.getByTestId("stage")).toHaveCount(2);
  await expect(win2.getByTestId("plan-item")).toHaveText(["Поговорить с тремя людьми", "Описать доменную модель"]);
  await expect(win2.getByTestId("proposal")).toHaveCount(0);
  await again.close();
});
