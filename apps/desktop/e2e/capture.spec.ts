import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

// Stage 6 universal `+`. The real Claude Code is never called here: LIVING_MAP_CLAUDE_PATH points at a
// fake CLI script that speaks the same stream-json protocol (the real invocation is covered by
// claude-code-cli.test.ts and by the live owner review).
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(desktopDir, "..", "mcp");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

const FAKE_CLI = `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const file = join(process.env.LIVING_MAP_HOME, "fake-proposal-id.txt");
  const proposalId = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  const result = proposalId
    ? { kind: "proposal", reply: "Подготовила новый порядок — посмотри предложение.", proposalId }
    : { kind: "answer", reply: "Сейчас лучше закончить описание модели.", proposalId: null };
  setTimeout(() => {
    const line = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
    line({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "living-map", status: "connected" }] });
    line({ type: "result", subtype: "success", is_error: false, structured_output: result });
  }, 1500);
});
`;

let home: string;
let mcp: Client | undefined;
test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-plus-"));
  writeFileSync(join(home, "fake-claude.mjs"), FAKE_CLI);
});
test.afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  rmSync(home, { recursive: true, force: true });
});

function launch(claudePath: string = join(home, "fake-claude.mjs")): Promise<ElectronApplication> {
  const env = { ...process.env, LIVING_MAP_HOME: home, LIVING_MAP_CLAUDE_PATH: claudePath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: electronPath, args: [desktopDir], env });
}

/** A real MCP client (as the AI host would be) over the same LIVING_MAP_HOME; returns a tool caller. */
async function connectAi() {
  const client = new Client({ name: "e2e-ai-host", version: "0" });
  mcp = client;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: mcpDir,
      env: { ...getDefaultEnvironment(), LIVING_MAP_HOME: home },
      stderr: "pipe",
    }),
  );
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? "{}").value;
  };
}

async function send(win: Page, text: string): Promise<void> {
  await win.getByTestId("plus-input").fill(text);
  await win.getByTestId("plus-send").click();
}

test("Stage 6: + saves immediately, shows processing, then the AI answer; survives restart", async () => {
  let app = await launch();
  let win = await app.firstWindow();
  await expect(win.getByTestId("now-screen")).toBeVisible();
  await win.getByTestId("plus-open").click();
  await send(win, "Что мне сейчас делать?");

  const capture = win.getByTestId("capture").first();
  await expect(win.getByTestId("plus-input")).toHaveValue("");
  await expect(capture).toContainText("Что мне сейчас делать?");
  await expect(capture).toContainText("ИИ разбирает…");
  await expect(capture.getByTestId("capture-reply")).toHaveText("Сейчас лучше закончить описание модели.", {
    timeout: 20_000,
  });
  await expect(capture).toHaveAttribute("data-state", "processed");

  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await win.getByTestId("plus-open").click();
  await expect(win.getByTestId("capture-reply")).toHaveText("Сейчас лучше закончить описание модели.");
  await app.close();
});

test("Stage 6: AI unavailable keeps the thought; «Повторить» and the next launch process it", async () => {
  let app = await launch(join(home, "no-such-claude.exe"));
  let win = await app.firstWindow();
  await win.getByTestId("plus-open").click();
  await send(win, "Добавь идею снять видео про дисциплину");

  const capture = win.getByTestId("capture").first();
  await expect(capture).toHaveAttribute("data-state", "failed", { timeout: 20_000 });
  await expect(capture).toContainText("Сохранено, но ИИ сейчас недоступен");
  await expect(capture).toContainText("не найден Claude Code");
  await capture.getByTestId("capture-retry").click();
  await expect(capture).toHaveAttribute("data-state", "failed", { timeout: 20_000 });
  expect(await win.getByTestId("capture").count()).toBe(1); // retry never duplicates the thought
  await app.close();

  // The AI is back: the failed Capture is picked up automatically on launch.
  app = await launch();
  win = await app.firstWindow();
  await win.getByTestId("plus-open").click();
  await expect(win.getByTestId("capture").first()).toHaveAttribute("data-state", "processed", { timeout: 20_000 });
  await expect(win.getByTestId("capture")).toHaveCount(1);
  await expect(win.getByTestId("capture").first()).toContainText("Добавь идею снять видео про дисциплину");
  await app.close();
});

test("Stage 6: NeedsAIReplan → «Попросить ИИ перестроить» → editable prefilled + → the AI proposal is surfaced", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.evaluate(async () => {
    const c = window.livingMap.commands;
    await c.createSeason({ focus: "Собрать Живую карту" });
    const i = await c.createIntention({ title: "Живая карта", desiredResult: "Помогает каждый день" });
    if (!i.ok) throw new Error("intention");
    const s = await c.addStage({ intentionId: i.value.id, title: "Основа" });
    if (!s.ok) throw new Error("stage");
    await c.addAction({ stageId: s.value.id, title: "Описать модель", doneWhen: "тесты зелёные" });
  });
  await expect(win.getByTestId("now-needs-replan")).toBeVisible();

  await win.getByTestId("ask-replan").click();
  await expect(win.getByTestId("plus-input")).toHaveValue("Перестрой текущий порядок действий.");
  await expect(win.getByTestId("capture")).toHaveCount(0); // prefilled, not silently sent
  await win.getByTestId("plus-input").fill("Перестрой порядок, я закончила Исполнятор.");

  // What a real AI host would do during the run: create a route proposal through MCP.
  const call = await connectAi();
  const ctx = await call("get_living_map_context");
  const proposal = await call("create_route_proposal", {
    intentionId: ctx.intention.id,
    expectedRevision: ctx.stateRevision,
    summary: "Сначала описать модель",
    rationale: "Модель — основа всего остального",
    actionOrder: [ctx.stages[0].actions[0].id],
  });
  writeFileSync(join(home, "fake-proposal-id.txt"), proposal.id);

  await win.getByTestId("plus-send").click();
  const capture = win.getByTestId("capture").first();
  await expect(capture.getByTestId("capture-proposal")).toBeVisible({ timeout: 20_000 });
  await expect(capture.getByTestId("capture-reply")).toHaveText("Подготовила новый порядок — посмотри предложение.");
  await expect(win.getByTestId("proposal")).toBeVisible();
  // Nothing strategic was applied without the user.
  await expect(win.getByTestId("now-needs-replan")).toBeVisible();
  await app.close();
});

test("Stage 6: «Память» shows what was remembered, searches it, and the user can forget one", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const call = await connectAi();
  await call("save_memory", { type: "preference", text: "Не жертвовать работой ради сна" });
  await call("save_memory", { type: "idea", text: "Снять видео про дисциплину" });

  await win.getByTestId("nav-memory").click();
  const items = win.getByTestId("memory-item");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("Идея");
  await win.getByTestId("memory-search").fill("видео");
  await expect(items).toHaveCount(1);
  await win.getByTestId("memory-search").fill("");

  win.once("dialog", (d) => void d.accept());
  await items.filter({ hasText: "сна" }).getByTestId("memory-forget").click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("Снять видео про дисциплину");
  expect((await call("search_memory", {})).map((m: { text: string }) => m.text)).toEqual([
    "Снять видео про дисциплину",
  ]);
  await app.close();
});
