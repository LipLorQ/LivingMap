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

const LIMIT_TEXT =
  "У тебя уже три проекта в этом сезоне. Заверши, поставь на паузу или отпусти один, прежде чем добавлять новый.";

let home: string;
let mcp: Client | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-map-"));
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
  const client = new Client({ name: "e2e-map-host", version: "0" });
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

type Seeded = { intentionId: string; stageId: string; a1: string; a2: string };
const YEAR = new Date().getFullYear();

/** The strategic line, one project with two Actions, and morning/evening routines — all through the real commands. */
async function seedWorld(win: Page): Promise<Seeded> {
  return win.evaluate(async (year) => {
    const c = window.livingMap.commands;
    const must = <T>(r: { ok: boolean; value?: T; error?: { message: string } }, what: string): T => {
      if (!r.ok) throw new Error(`${what}: ${r.error?.message}`);
      return r.value as T;
    };
    must(
      await c.createSeason({ focus: "Запустить рабочую Живую карту", whyItMatters: "Это главное дело года" }),
      "season",
    );
    must(
      await c.saveStrategy({
        level: "decade",
        startYear: year,
        endYear: year + 9,
        statement: "Строить дела, которыми горжусь",
      }),
      "decade",
    );
    must(
      await c.saveStrategy({
        level: "horizon",
        startYear: year,
        direction: "Запустить и вырасти",
        whyItMatters: "Первый шаг к построенному делу",
      }),
      "horizon",
    );
    must(
      await c.saveStrategy({ level: "year", year, direction: "Рабочий MVP в жизни", whyItMatters: "Основа трёх лет" }),
      "year",
    );
    const intention = must(
      await c.createIntention({
        title: "Запустить продукт",
        desiredResult: "Продуктом пользуются каждый день",
        whyItMatters: "Это и есть главная цель сезона",
      }),
      "intention",
    ) as { id: string };
    const stage = must(await c.addStage({ intentionId: intention.id, title: "Основа" }), "stage") as { id: string };
    const first = must(
      await c.addAction({ stageId: stage.id, title: "Первое действие", doneWhen: "готово 1" }),
      "a1",
    ) as { id: string };
    const second = must(
      await c.addAction({ stageId: stage.id, title: "Второе действие", doneWhen: "готово 2" }),
      "a2",
    ) as { id: string };
    must(await c.addRoutineItem({ kind: "morning", text: "Стакан воды" }), "morning");
    must(await c.addRoutineItem({ kind: "evening", text: "Почитать перед сном" }), "evening");
    return { intentionId: intention.id, stageId: stage.id, a1: first.id, a2: second.id };
  }, YEAR);
}

type Ctx = { stateRevision: number };

/** The AI orders the actions (a real first-route Proposal) and the user accepts it in the desktop. */
async function proposeAndAcceptOrder(win: Page, seeded: Seeded): Promise<void> {
  const ctx = await tool<Ctx>("get_living_map_context");
  const proposal = await tool<{ id: string }>("create_route_proposal", {
    intentionId: seeded.intentionId,
    expectedRevision: ctx.stateRevision,
    summary: "Сначала первое, потом второе",
    rationale: "Первое действие логически предшествует второму",
    newStages: [],
    newActions: [],
    actionEdits: [],
    actionOrder: [seeded.a1, seeded.a2],
  });
  const accepted = await win.evaluate(
    async (id) => await window.livingMap.commands.acceptProposal({ id }),
    proposal.id,
  );
  expect(accepted.ok).toBe(true);
}

test("Stage 8 main screen: the path up, the day's structure and the Executor timer on one screen", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const seeded = await seedWorld(win);
  mcp = await connectMcp();
  await proposeAndAcceptOrder(win, seeded);

  // Strategic orientation: the Season's main goal, the path up one click away.
  await expect(win.getByTestId("now-season-goal")).toHaveText("Запустить рабочую Живую карту");
  await win.getByTestId("now-path-details").locator("summary").click();
  await expect(win.getByTestId("now-path-year")).toContainText("Рабочий MVP в жизни");
  await expect(win.getByTestId("now-path-horizon")).toContainText("Запустить и вырасти");
  await expect(win.getByTestId("now-path-decade")).toContainText("Строить дела, которыми горжусь");

  // The day's structure: morning routine, work now, evening routine — routines are anchors, not work.
  await expect(win.getByTestId("day-morning")).toContainText("Стакан воды");
  await expect(win.getByTestId("day-evening")).toContainText("Почитать перед сном");

  // Current work: project, stage, ONE Action, done-when, why-now — and the timer right there.
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", seeded.a1);
  await expect(win.getByTestId("now-project")).toHaveText("Проект «Запустить продукт»");
  await expect(win.getByTestId("now-stage")).toContainText("этап «Основа»");
  await expect(win.getByTestId("now-done-when")).toContainText("готово 1");
  await expect(win.getByTestId("now-why")).toContainText("Первое действие в подтверждённом порядке.");
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await expect(win.getByTestId("work-timer")).toHaveText("00:00");
  // Routines and calendar are not work time.
  await expect(win.getByTestId("work-today")).toHaveText("Сегодня: 0 мин / 6 ч");

  // Routines never enter the order of Actions.
  await win.getByTestId("now-toggle-order").click();
  await expect(win.getByTestId("plan-item")).toHaveText(["Первое действие", "Второе действие"]);
  await win.getByTestId("now-toggle-order").click();

  // Start → Pause → Resume → Complete, all on the main screen.
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await expect(win.getByTestId("work-timer")).not.toHaveText("00:00", { timeout: 3000 });
  await win.getByTestId("work-pause").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "paused");
  await expect(win.getByTestId("work-start")).toHaveText("Продолжить");
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await win.getByTestId("work-complete").click();

  // The next Action appears with a fresh timer, and the path above it is still the same.
  await expect(win.getByTestId("now-action")).toHaveAttribute("data-id", seeded.a2);
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await expect(win.getByTestId("work-timer")).toHaveText("00:00");
  await expect(win.getByTestId("now-project")).toHaveText("Проект «Запустить продукт»");
  await expect(win.getByTestId("now-season-goal")).toHaveText("Запустить рабочую Живую карту");
  await expect(win.getByTestId("now-season-progress")).toHaveText("Завершено проектов: 0 из 1");
  // Routine text never leaks into what the AI is given.
  const context = JSON.stringify(await tool("get_living_map_context"));
  expect(context).not.toContain("Стакан воды");
  expect(context).not.toContain("Почитать перед сном");

  await app.close();
});

test("Stage 8 Full Map A: trace the current Action upward — Action → Project → Season → Year → 3 years → Decade", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const seeded = await seedWorld(win);
  mcp = await connectMcp();
  await proposeAndAcceptOrder(win, seeded);

  await win.getByTestId("now-open-map").click();
  await expect(win.getByTestId("map-screen")).toBeVisible();

  // Far = coarse at the top, near = detailed at the bottom.
  await expect(win.getByTestId("decade")).toHaveCount(1);
  await expect(win.getByTestId("decade-statement")).toHaveText("Строить дела, которыми горжусь");
  await expect(win.getByTestId("horizon-direction")).toHaveValue("Запустить и вырасти");
  await expect(win.getByTestId("year-direction")).toHaveValue("Рабочий MVP в жизни");
  await expect(win.getByTestId("map-season-focus")).toHaveValue("Запустить рабочую Живую карту");
  await expect(win.getByTestId("map-season-why")).toHaveValue("Это главное дело года");
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 1 из 3");

  // The active project, honest finite progress, current stage — then open it down to the Action.
  await expect(win.getByTestId("map-project")).toHaveCount(1);
  await expect(win.getByTestId("map-project-title")).toHaveText("Запустить продукт");
  await expect(win.getByTestId("map-project-progress")).toHaveText("Этап 1 из 1 · 0 из 2 действий");
  await expect(win.getByTestId("map-project-stage")).toContainText("Основа");
  await win.getByTestId("map-project-open").click();
  await expect(win.getByTestId("map-stage")).toHaveCount(1);
  await expect(win.getByTestId("map-action").first()).toHaveAttribute("data-current", "true");
  await expect(win.getByTestId("map-action").first()).toContainText("Первое действие");

  // The path up from NOW.
  await expect(win.getByTestId("map-now-action")).toHaveText("Первое действие");
  await expect(win.getByTestId("path-action")).toContainText("Первое действие");
  await expect(win.getByTestId("path-stage")).toContainText("Основа");
  await expect(win.getByTestId("path-project")).toContainText("Запустить продукт");
  await expect(win.getByTestId("path-project")).toContainText("Это и есть главная цель сезона");
  await expect(win.getByTestId("path-season")).toContainText("Запустить рабочую Живую карту");
  await expect(win.getByTestId("path-year")).toContainText("Рабочий MVP в жизни");
  await expect(win.getByTestId("path-horizon")).toContainText("Запустить и вырасти");
  await expect(win.getByTestId("path-decade")).toContainText("Строить дела, которыми горжусь");

  // The Executor is right there too: one lifecycle, no second timer.
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "idle");
  await win.getByTestId("work-start").click();
  await expect(win.getByTestId("work")).toHaveAttribute("data-state", "running");
  await win.getByTestId("work-pause").click();

  // No invented percentages anywhere on the map.
  await expect(win.getByTestId("map-screen")).not.toContainText("%");

  await app.close();
});

test("Stage 8 Full Map B: a wording edit changes nothing below; changing course shows the impact, rewrites nothing, and goes through AI + confirmation", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const seeded = await seedWorld(win);
  mcp = await connectMcp();
  await proposeAndAcceptOrder(win, seeded);
  await win.getByTestId("nav-map").click();

  const lowerLevels = () =>
    win.evaluate(async () => {
      const view = await window.livingMap.queries.getCurrentView();
      if (!view.ok) throw new Error("view");
      return JSON.stringify({ season: view.value.season, projects: view.value.projects });
    });
  const before = await lowerLevels();

  // A pending AI proposal that reasoned about today's world.
  const ctx = await tool<Ctx>("get_living_map_context");
  const pending = await tool<{ id: string }>("propose_desired_result_change", {
    intentionId: seeded.intentionId,
    expectedRevision: ctx.stateRevision,
    desiredResult: "Продуктом пользуются каждый день, и он приносит радость",
    summary: "Уточнить результат",
    rationale: "Результат должен включать ощущение",
  });
  const proposalStatus = (id: string) =>
    win.evaluate(async (pid) => {
      const view = await window.livingMap.queries.getCurrentView();
      if (!view.ok) throw new Error("view");
      return view.value.pendingProposals.find((p) => p.id === pid)?.status ?? "gone";
    }, id);
  await expect.poll(() => proposalStatus(pending.id)).toBe("pending");

  // MODE A — wording: same meaning, better words. No impact panel, no cascade, no reminder.
  await win.getByTestId("year-direction").fill("Рабочий MVP, которым я пользуюсь");
  await win.getByTestId("year-save-wording").click();
  await expect(win.getByTestId("year-direction")).toHaveValue("Рабочий MVP, которым я пользуюсь");
  await expect(win.getByTestId("year-impact")).toHaveCount(0);
  await expect(win.getByTestId("course-change")).toHaveCount(0);
  expect(await lowerLevels()).toBe(before);
  await expect.poll(() => proposalStatus(pending.id)).toBe("pending");

  // MODE B — change course: the impact is shown first, and nothing is applied until it is confirmed.
  await win.getByTestId("year-direction").fill("Заработать на продукте");
  await win.getByTestId("year-change-course").click();
  await expect(win.getByTestId("year-impact")).toBeVisible();
  const items = win.getByTestId("year-impact").getByTestId("impact-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Этот сезон: Запустить рабочую Живую карту");
  await expect(items.nth(1)).toContainText("Проект «Запустить продукт» (1 этап, 2 действия в работе)");
  const unchanged = await win.evaluate(async () => {
    const view = await window.livingMap.queries.getCurrentView();
    return view.ok ? view.value.strategy.year?.direction : null;
  });
  expect(unchanged).toBe("Рабочий MVP, которым я пользуюсь"); // previewing changes nothing
  await win.getByTestId("year-confirm-course").click();

  // The year changed; EVERY lower level is exactly as it was — no silent rewrite.
  await expect(win.getByTestId("course-change")).toHaveCount(1);
  expect(await lowerLevels()).toBe(before);
  // The old AI proposal reasoned about the old course: it is stale, not silently rebased.
  await expect.poll(() => proposalStatus(pending.id)).toBe("stale");

  // «Посмотреть, что нужно пересобрать» → the affected entities, then the AI path.
  await win.getByTestId("course-change-show").click();
  await expect(win.getByTestId("course-change-impact").getByTestId("impact-item")).toHaveCount(2);
  await win.getByTestId("course-change-ask-ai").click();
  await expect(win.getByTestId("plus-input")).toHaveValue(/Курс изменился: «Заработать на продукте»/);

  // The AI replans through a Proposal; applying it needs the owner's confirmation.
  const ctx2 = await tool<Ctx>("get_living_map_context");
  const rebuild = await tool<{ id: string }>("create_route_proposal", {
    intentionId: seeded.intentionId,
    expectedRevision: ctx2.stateRevision,
    summary: "Добавить шаг про деньги",
    rationale: "Новый курс требует шага про доход",
    newStages: [],
    newActions: [
      { ref: "money", stage: seeded.stageId, title: "Придумать, как продукт зарабатывает", doneWhen: "есть план" },
    ],
    actionEdits: [],
    actionOrder: ["money", seeded.a1, seeded.a2],
  });
  await expect.poll(() => proposalStatus(rebuild.id)).toBe("pending");
  const actionCount = () =>
    win.evaluate(async () => {
      const view = await window.livingMap.queries.getCurrentView();
      return view.ok ? view.value.projects[0]?.stages.flatMap((s) => s.actions).length : -1;
    });
  expect(await actionCount()).toBe(2); // nothing applied behind the owner's back
  await win.getByTestId("nav-now").click();
  await win.getByTestId("proposal-accept").click();
  await expect.poll(actionCount).toBe(3);

  // The owner closes the reminder once rebuilt.
  await win.getByTestId("nav-map").click();
  await win.getByTestId("course-change-show").click();
  await win.getByTestId("course-change-resolve").click();
  await expect(win.getByTestId("course-change")).toHaveCount(0);

  // A new Season is the same kind of decision: impact first, the old goal goes to history.
  await win.getByTestId("map-season-focus").fill("Продать первым клиентам");
  await win.getByTestId("season-change-course").click();
  await expect(win.getByTestId("season-impact").getByTestId("impact-item")).toHaveCount(1);
  await win.getByTestId("season-confirm-course").click();
  await expect(win.getByTestId("course-change")).toHaveCount(1);
  await win.getByTestId("map-history").locator("summary").click();
  await expect(win.getByTestId("history-season")).toContainText("Запустить рабочую Живую карту");

  // Readable Russian history of the strategic edits.
  await win.getByTestId("nav-editor").click();
  await win.getByTestId("change-history").getByText("История изменений").click();
  const history = win.getByTestId("history-entry");
  await expect(history.filter({ hasText: "Уточнена формулировка года" })).toHaveCount(1);
  await expect(history.filter({ hasText: "Сменён курс года" })).toHaveCount(1);
  await expect(history.filter({ hasText: "Начат новый сезон" })).toHaveCount(1);

  await app.close();
});

test("Stage 8 Full Map C: at most three active projects — a fourth is refused kindly and nothing changes", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const ids = await win.evaluate(async () => {
    const c = window.livingMap.commands;
    await c.createSeason({ focus: "Сезон" });
    const out: { id: string; version: number }[] = [];
    for (const title of ["Первый", "Второй", "Третий"]) {
      const r = await c.createIntention({ title, desiredResult: `${title} готов` });
      if (!r.ok) throw new Error(r.error.message);
      out.push({ id: r.value.id, version: r.value.version });
    }
    return out;
  });
  expect(ids).toHaveLength(3);

  // The editor says it plainly before the user even tries…
  await win.getByTestId("nav-editor").click();
  await expect(win.getByTestId("intention")).toHaveCount(3);
  await expect(win.getByTestId("intention-limit-note")).toHaveText(LIMIT_TEXT);
  // …and the refusal itself is just as friendly. Nothing is created.
  await win.getByTestId("intention-title-new").fill("Четвёртый");
  await win.getByTestId("intention-create-submit").click();
  await expect(win.getByTestId("error")).toHaveText(LIMIT_TEXT);
  await expect(win.getByTestId("intention")).toHaveCount(3);

  // The map shows the slots; pausing one frees a place.
  await win.getByTestId("nav-map").click();
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 3 из 3");
  await expect(win.getByTestId("project-limit-note")).toHaveText(LIMIT_TEXT);
  await win.getByTestId("map-project").nth(2).getByTestId("project-defer").click();
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 2 из 3");
  await expect(win.getByTestId("map-project").nth(2)).toHaveAttribute("data-status", "deferred");

  // A fourth project now fits…
  const fourth = await win.evaluate(async () => {
    const r = await window.livingMap.commands.createIntention({ title: "Четвёртый", desiredResult: "" });
    return r.ok;
  });
  expect(fourth).toBe(true);
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 3 из 3");
  // …but the paused one cannot be resumed until a place is free again: a friendly refusal, state intact.
  await win.getByTestId("project-activate").click();
  await expect(win.getByTestId("error")).toHaveText(LIMIT_TEXT);
  await expect(win.getByTestId("map-project").filter({ has: win.getByTestId("project-activate") })).toHaveAttribute(
    "data-status",
    "deferred",
  );

  // Completing one asks first, then frees a place and lands in the history.
  await win.getByTestId("map-project").first().getByTestId("project-complete").click();
  await win.getByTestId("project-confirm-yes").click();
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 2 из 3");
  await win.getByTestId("map-history").locator("summary").click();
  await expect(win.getByTestId("history-project").filter({ hasText: "Первый" })).toBeVisible();
  await win.getByTestId("project-activate").click();
  await expect(win.getByTestId("project-slots")).toContainText("занято мест: 3 из 3");

  await app.close();
});

test("Stage 8 Full Map D: morning and evening routines persist, show in today's structure, and are never work", async () => {
  let app = await launch();
  let win = await app.firstWindow();
  mcp = await connectMcp();

  await win.getByTestId("nav-editor").click();
  await win.getByTestId("routine-new-morning").fill("Стакан воды");
  await win.getByTestId("routine-add-morning").click();
  await win.getByTestId("routine-new-morning").fill("Зарядка");
  await win.getByTestId("routine-add-morning").click();
  await win.getByTestId("routine-new-evening").fill("Почитать");
  await win.getByTestId("routine-add-evening").click();
  const morning = win.getByTestId("routine-morning").getByTestId("routine-item");
  await expect(morning).toHaveCount(2);
  // Reorder and switch one off.
  await morning.nth(1).getByTestId("move-up").click();
  await expect(morning.first().getByTestId("routine-text")).toHaveValue("Зарядка");
  await morning.nth(1).getByTestId("routine-toggle").click();
  await expect(morning.nth(1)).toHaveAttribute("data-active", "false");

  // Today's structure shows the active ones only; no work time, no Action, no order.
  await win.getByTestId("nav-now").click();
  await expect(win.getByTestId("day-morning")).toContainText("Зарядка");
  await expect(win.getByTestId("day-morning")).not.toContainText("Стакан воды");
  await expect(win.getByTestId("day-evening")).toContainText("Почитать");
  await expect(win.getByTestId("now-empty")).toBeVisible();
  await expect(win.getByTestId("work")).toHaveCount(0);
  const context = JSON.stringify(await tool("get_living_map_context"));
  expect(context).not.toContain("Зарядка");

  // They survive a real restart.
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await expect(win.getByTestId("day-morning")).toContainText("Зарядка");
  await expect(win.getByTestId("day-evening")).toContainText("Почитать");
  await app.close();
});

test("Stage 8: an empty map is a calm, inviting state — every layer can be started from the map itself", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.getByTestId("nav-map").click();
  await expect(win.getByTestId("map-screen")).toBeVisible();
  await expect(win.getByTestId("decades-empty")).toBeVisible();
  await expect(win.getByTestId("projects-empty")).toBeVisible();
  await expect(win.getByTestId("map-now-empty")).toBeVisible();

  await win.getByTestId("map-season-focus").fill("Главное в сезоне");
  await win.getByTestId("map-season-create").click();
  await win.getByTestId("year-direction").fill("Главное в году");
  await win.getByTestId("year-set").click();
  await win.getByTestId("horizon-direction").fill("Главное за три года");
  await win.getByTestId("horizon-set").click();
  await win.getByTestId("decade-new-statement").fill("Главное за десятилетие");
  await win.getByTestId("decade-add").click();
  await expect(win.getByTestId("decade")).toHaveCount(1);
  await expect(win.getByTestId("horizon-serves")).toContainText("Главное за десятилетие");
  await app.close();
});
