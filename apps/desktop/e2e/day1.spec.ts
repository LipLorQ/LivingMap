import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

// Stage 9, Day 1 repairs, through the real desktop UI: «Проекты» wording, the project switcher (pause on
// switch, nothing auto-started, survives reload and restart), the restored «Попросить ИИ перестроить» on the
// current card, and «Быт».
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mcpDir = resolve(desktopDir, "..", "mcp");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;
let mcp: Client | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-day1-"));
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
  const client = new Client({ name: "e2e-day1-host", version: "0" });
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

type Project = { id: string; actions: [string, string] };

/** One project with two Actions, created through the real commands. */
async function createProject(win: Page, title: string): Promise<Project> {
  return win.evaluate(async (title) => {
    const c = window.livingMap.commands;
    const must = <T>(r: { ok: boolean; value?: T; error?: { message: string } }): T => {
      if (!r.ok) throw new Error(r.error?.message);
      return r.value as T;
    };
    const intention = must(await c.createIntention({ title, desiredResult: `${title} готов` })) as { id: string };
    const stage = must(await c.addStage({ intentionId: intention.id, title: "Этап" })) as { id: string };
    const a1 = must(await c.addAction({ stageId: stage.id, title: `${title}: первое`, doneWhen: "1" })) as {
      id: string;
    };
    const a2 = must(await c.addAction({ stageId: stage.id, title: `${title}: второе`, doneWhen: "2" })) as {
      id: string;
    };
    return { id: intention.id, actions: [a1.id, a2.id] as [string, string] };
  }, title);
}

/** The AI orders a project's actions (a real route Proposal) and the owner accepts it. */
async function acceptOrder(win: Page, project: Project): Promise<void> {
  const ctx = await tool<{ stateRevision: number }>("get_living_map_context");
  const proposal = await tool<{ id: string }>("create_route_proposal", {
    intentionId: project.id,
    expectedRevision: ctx.stateRevision,
    summary: "По порядку",
    rationale: "По порядку",
    newStages: [],
    newActions: [],
    actionEdits: [],
    actionOrder: project.actions,
  });
  const accepted = await win.evaluate(
    async (id) => await window.livingMap.commands.acceptProposal({ id }),
    proposal.id,
  );
  expect(accepted.ok).toBe(true);
}

test("Day 1: «Проекты», switching projects pauses work and sticks, ask the AI from the card, «Быт»", async () => {
  let app = await launch();
  let win = await app.firstWindow();
  await win.evaluate(async () => await window.livingMap.commands.createSeason({ focus: "Сезон контента" }));
  const a = await createProject(win, "Контент");
  const b = await createProject(win, "Продукт");
  mcp = await connectMcp();
  await acceptOrder(win, a);
  await acceptOrder(win, b);

  // 1. The familiar word everywhere in the navigation, the old one nowhere on the main screen.
  await expect(win.getByTestId("nav-editor")).toHaveText("Проекты");
  await expect(win.getByTestId("nav-household")).toHaveText("Быт");
  await expect(win.locator("body")).not.toContainText("Замысл");

  // 2. The owner's project order leads by default; the switcher lists the active projects.
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", a.actions[0]);
  await expect(win.getByTestId("project-switcher")).toHaveValue(a.id);

  // Work on A, then switch to B: A pauses, nothing starts on B.
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await expect(win.getByTestId("project-switcher-hint")).toBeVisible();
  await win.getByTestId("project-switcher").selectOption(b.id);
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", b.actions[0]);
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await expect(win.getByTestId("work-start")).toHaveText("Начать");

  // Survives a renderer reload, and completing keeps advancing inside B.
  await win.reload();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", b.actions[0]);
  await win.getByTestId("work-complete").click();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", b.actions[1]);

  // …and an app restart.
  await mcp.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", b.actions[1]);
  await expect(win.getByTestId("project-switcher")).toHaveValue(b.id);

  // 7. The AI correction path is right on the current card: a prefilled «+», never sent by itself.
  await win.getByTestId("now-ask-ai").click();
  await expect(win.getByTestId("plus-input")).toHaveValue("Перестрой порядок действий проекта «Продукт».");
  await expect(win.getByTestId("capture")).toHaveCount(0);
  await win.getByTestId("plus-close").click();

  // 8. «Быт»: add, complete, history — and the work screen is untouched.
  await win.getByTestId("nav-household").click();
  await expect(win.getByTestId("household-empty")).toBeVisible();
  await win.getByTestId("household-add").click();
  await win.getByTestId("household-new").fill("Отвезти байк в ремонт");
  await win.getByTestId("household-save").click();
  await expect(win.getByTestId("household-item")).toHaveText(/Отвезти байк в ремонт/);
  await win.getByTestId("household-done").click();
  await expect(win.getByTestId("household-item")).toHaveCount(0);
  await win.getByTestId("household-done-list").locator("summary").click();
  await expect(win.getByTestId("household-done-item")).toContainText("Отвезти байк в ремонт");
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", b.actions[1]);

  await app.close();
});
