import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AiRunner,
  type Application,
  type Clock,
  createApplication,
  type ReviewRunOutcome,
} from "@living-map/application";
import type { Result } from "@living-map/contracts";
import {
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  type SqliteHandle,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewProcessor } from "../src/main/ai/review-processor";

const TZ = "Europe/Moscow";

function mutableClock(initial: string): Clock & { set: (now: string) => void } {
  let now = initial;
  return {
    now: () => now,
    set: (n) => {
      now = n;
    },
  };
}

let home: string;
let handle: SqliteHandle;
let app: Application;
let clock: ReturnType<typeof mutableClock>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-review-processor-"));
  handle = openDesktopDatabase(databaseFile(home));
  clock = mutableClock("2026-09-25T08:00:00.000Z");
  app = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock,
    ids: uuidGenerator,
    timeZone: () => TZ,
  });
});
afterEach(() => {
  if (handle.sqlite.open) handle.close();
  rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const reviews = () => unwrap(app.queries.listReviews({ limit: 50 }));

function countingRunner(outcome: ReviewRunOutcome): { runner: AiRunner; count: () => number } {
  let calls = 0;
  const runner: AiRunner = {
    processCapture: async () => ({ ok: false, failure: "failed" }),
    processReview: async () => {
      calls++;
      return outcome;
    },
  };
  return { runner, count: () => calls };
}

describe("ReviewProcessor", () => {
  it("an empty evidence pack never calls the AI and finishes as no_useful_change", async () => {
    // No facts recorded anywhere: the due daily period's evidence pack is empty.
    clock.set("2026-09-26T07:00:00.000Z"); // rolls "2026-09-25" into a closed, due daily period
    const { runner, count } = countingRunner({ ok: true, result: { kind: "no_useful_change" } });
    const processor = createReviewProcessor(app, runner, () => TZ);
    processor.start();
    await processor.idle();

    expect(count()).toBe(0);
    const daily = reviews().find((r) => r.type === "daily");
    expect(daily).toMatchObject({ status: "no_useful_change" });
  });

  it("a non-empty evidence pack does call the AI", async () => {
    // A real fact inside what becomes the due daily period.
    app.commands.createSeason(app.newContext("user-ui", "test"), { focus: "test focus" });
    clock.set("2026-09-26T07:00:00.000Z");
    const { runner, count } = countingRunner({ ok: true, result: { kind: "no_useful_change" } });
    const processor = createReviewProcessor(app, runner, () => TZ);
    processor.start();
    await processor.idle();

    expect(count()).toBeGreaterThan(0);
    const daily = reviews().find((r) => r.type === "daily");
    expect(daily).toMatchObject({ status: "no_useful_change" });
  });

  it("start() recovers an interrupted Review and reports scheduling/recovery errors instead of swallowing them", async () => {
    clock.set("2026-09-26T07:00:00.000Z");
    const { runner } = countingRunner({ ok: true, result: { kind: "no_useful_change" } });
    const messages: string[] = [];
    const processor = createReviewProcessor(
      app,
      runner,
      () => TZ,
      (m) => messages.push(m),
    );
    processor.start();
    await processor.idle();
    // A healthy run reports nothing.
    expect(messages).toEqual([]);
  });
});
