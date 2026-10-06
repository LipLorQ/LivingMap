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
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-now-"));
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
  const client = new Client({ name: "e2e-now-host", version: "0" });
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
  // A pending Proposal is discoverable from the default "Сейчас" tab, no hunting.
  await expect(win.getByTestId("now-screen")).toBeVisible();
  await expect(win.getByTestId("proposals-heading")).toHaveText("Предложения ИИ (1)");
  const accepted = await win.evaluate(
    async (id) => await window.livingMap.commands.acceptProposal({ id }),
    proposal.id,
  );
  expect(accepted.ok).toBe(true);
}

test("Stage 4: Сейчас reflects real state — empty, needs-replan, selected action, expandable order, disconnected calendar, and updates after completion", async () => {
  const app = await launch();
  const win = await app.firstWindow();

  // 1. Fresh app: "Сейчас" is the default screen, no Intention yet — a calm empty state, not NeedsAIReplan.
  await expect(win.getByTestId("now-screen")).toBeVisible();
  await expect(win.getByTestId("now-empty")).toBeVisible();
  await expect(win.getByTestId("now-needs-replan")).toHaveCount(0);

  // Calendar: never connected — truthful, not pretending to be fresh.
  await expect(win.getByTestId("calendar-disconnected")).toBeVisible();
  await expect(win.getByTestId("calendar-ical-url")).toBeVisible();

  // 2. An Intention with actions but no AI-approved order yet: NeedsAIReplan, not a local guess.
  const actions = await seed(win);
  await expect(win.getByTestId("now-needs-replan")).toBeVisible();
  await expect(win.getByTestId("now-action")).toHaveCount(0);

  // 3. A real external AI proposes the order; the user accepts it in the desktop UI.
  mcp = await connectMcp();
  await proposeAndAcceptOrder(win, actions);

  // 4. The first admissible Action in the AI order becomes "Сейчас", with a truthful local reason.
  await expect(win.getByTestId("now-action")).toBeVisible();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", actions.a1);
  await expect(win.getByTestId("now-done-when")).toContainText("готово 1");
  await expect(win.getByTestId("now-why")).toContainText("Первое невыполненное действие текущего этапа.");
  await expect(win.getByTestId("now-needs-replan")).toHaveCount(0);

  // 5. The strategic order is not shown by default, but can be expanded on demand.
  await expect(win.getByTestId("plan-order")).toHaveCount(0);
  await win.getByTestId("now-toggle-order").click();
  await expect(win.getByTestId("plan-order")).toBeVisible();
  await expect(win.getByTestId("plan-item")).toHaveText(["Первое действие", "Второе действие"]);

  // 6. Completing the current Action (existing Stage 2 lifecycle) reveals the next admissible one —
  // the selector follows the AI order, it does not rerank or invent a new one.
  await win.evaluate(async (id) => {
    const view = await window.livingMap.queries.getCurrentView();
    if (!view.ok) throw new Error("view");
    const action = view.value.stages.flatMap((s) => s.actions).find((a) => a.id === id);
    if (!action) throw new Error("action missing");
    await window.livingMap.commands.completeAction({ id, expectedVersion: action.version });
  }, actions.a1);
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", actions.a2);
  await expect(win.getByTestId("now-why")).toContainText("Предыдущие действия по порядку уже выполнены.");

  // 7. Completing the last remaining Action leaves nothing admissible: a real NeedsAIReplan, not a crash.
  await win.evaluate(async (id) => {
    const view = await window.livingMap.queries.getCurrentView();
    if (!view.ok) throw new Error("view");
    const action = view.value.stages.flatMap((s) => s.actions).find((a) => a.id === id);
    if (!action) throw new Error("action missing");
    await window.livingMap.commands.completeAction({ id, expectedVersion: action.version });
  }, actions.a2);
  await expect(win.getByTestId("now-needs-replan")).toBeVisible();
  await expect(win.getByTestId("now-action")).toHaveCount(0);

  // Calendar state never silently changed on its own throughout.
  await expect(win.getByTestId("calendar-disconnected")).toBeVisible();

  await app.close();
});
