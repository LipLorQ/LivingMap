import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseFile, openDesktopDatabase, type SqliteHandle } from "@living-map/persistence-sqlite";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

// Stage 7 «Разборы». The scheduler/evidence/pattern pipeline itself is covered end-to-end against
// real SQLite in persistence-sqlite/test/review.test.ts and against the fake CLI in
// claude-code-cli.test.ts; the real desktop app has no way to time-travel its own clock to produce a
// closed past period with real evidence, so this file seeds a `ready` Review directly by SQL (test
// fixture only — never a product code path) and exercises the one thing those cannot: the real
// renderer + IPC + preload wiring for confirm/correct/ignore and the Pattern → PlanningRule flow.
//
// The real app also schedules its own due periods on launch (first-ever daily/weekly/yearly) — every
// locator below is therefore scoped to the seeded row's own `data-id`, never to list position/count.
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as unknown as string;

let home: string;
let handle: SqliteHandle | undefined;
test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-e2e-reviews-"));
});
test.afterEach(() => {
  if (handle?.sqlite.open) handle.close();
  handle = undefined;
  rmSync(home, { recursive: true, force: true });
});

function launch(): Promise<ElectronApplication> {
  const env = {
    ...process.env,
    LIVING_MAP_HOME: home,
    LIVING_MAP_CLAUDE_PATH: join(home, "no-such-claude.exe"),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: electronPath, args: [desktopDir], env });
}

/** One closed daily period, already `ready`, with one `proposed` finding tagged `patternKey`. */
function seedReadyDaily(dayOffset: number, patternKey: string | null): { reviewId: string; findingId: string } {
  handle ??= openDesktopDatabase(databaseFile(home));
  const now = Date.now();
  const periodEnd = new Date(now - dayOffset * 86_400_000).toISOString();
  const periodStart = new Date(now - (dayOffset + 1) * 86_400_000).toISOString();
  const reviewId = randomUUID();
  const findingId = randomUUID();
  handle.sqlite
    .prepare(
      "insert into reviews (id, type, period_start, period_end, time_zone, status, attempts, last_error, created_at, updated_at) values (?, 'daily', ?, ?, 'Europe/Moscow', 'ready', 1, NULL, ?, ?)",
    )
    .run(reviewId, periodStart, periodEnd, periodEnd, periodEnd);
  handle.sqlite
    .prepare(
      "insert into review_findings (id, review_id, text, evidence_refs, evidence_fact_ids, suggestion, pattern_key, status, corrected_text, created_at, updated_at) values (?, ?, ?, ?, ?, NULL, ?, 'proposed', NULL, ?, ?)",
    )
    .run(
      findingId,
      reviewId,
      `Похоже, приёмы у врача съедают половину дня (период ${dayOffset})`,
      // A distinct fake evidence id per seeded period — two Reviews citing the exact same fact would
      // correctly be refused as one episode counted twice (see HIGH-1 fix, application.ts).
      JSON.stringify([`changelog:seed-${dayOffset}`]),
      // The canonical underlying-fact id(s) the ref above resolves to (H2 fix, application.ts):
      // distinct per seeded period, same as the ref itself, since this fixture invents no aggregation.
      JSON.stringify([`changelog:seed-${dayOffset}`]),
      patternKey,
      periodEnd,
      periodEnd,
    );
  return { reviewId, findingId };
}

async function openReviews(win: Page) {
  await win.getByTestId("nav-reviews").click();
  await expect(win.getByTestId("reviews")).toBeVisible();
}

test("«Разборы»: badge shows a ready Review; «Всё верно» accepts the AI's own draft", async () => {
  const { reviewId } = seedReadyDaily(1, null);
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.getByTestId("now-screen")).toBeVisible();
    await expect(win.getByTestId("reviews-badge")).toBeVisible();

    await openReviews(win);
    await win.locator(`[data-testid="review-item"][data-id="${reviewId}"]`).click();
    const finding = win.getByTestId("review-finding");
    await expect(finding).toContainText("Похоже, приёмы у врача");
    await finding.getByTestId("finding-accept").click();
    await expect(finding).toContainText("Принято");
  } finally {
    await app.close();
  }
});

test("«Разборы»: a correction is saved as the accepted learning; the AI draft is kept", async () => {
  const { reviewId } = seedReadyDaily(1, null);
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await openReviews(win);
    await win.locator(`[data-testid="review-item"][data-id="${reviewId}"]`).click();
    await win.getByTestId("finding-edit").click();
    await win.getByTestId("finding-edit-text").fill("На самом деле дело было не во враче");
    await win.getByTestId("finding-edit-save").click();
    const finding = win.getByTestId("review-finding");
    await expect(finding).toContainText("На самом деле дело было не во враче");
    await expect(finding).toContainText("Исправлено");
  } finally {
    await app.close();
  }
});

test("«Разборы»: two accepted findings from distinct periods surface a Pattern candidate; confirming activates a rule", async () => {
  const first = seedReadyDaily(1, "doctor-visits");
  const second = seedReadyDaily(2, "doctor-visits");
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await openReviews(win);

    for (const { reviewId } of [first, second]) {
      await win.locator(`[data-testid="review-item"][data-id="${reviewId}"]`).click();
      await win.getByTestId("finding-accept").click();
    }

    const candidate = win.getByTestId("pattern-candidate");
    await expect(candidate).toBeVisible();
    await expect(candidate).toContainText("2");
    await candidate.getByTestId("pattern-confirm").click();
    await expect(win.getByTestId("pattern-candidate")).toHaveCount(0);

    const rule = win.getByTestId("planning-rule");
    await expect(rule).toBeVisible();
    await rule.getByTestId("planning-rule-deactivate").click();
    await expect(win.getByTestId("planning-rule")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
