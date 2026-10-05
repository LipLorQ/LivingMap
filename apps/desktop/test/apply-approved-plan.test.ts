import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@living-map/application";
import {
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runApprovedPlan } from "../scripts/apply-approved-plan";

// The owner-authorized path for a plan designed outside the app (Stage 9 Day 1): dry run by default.
let home: string;
let file: string;
let projectId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-plan-"));
  file = databaseFile(home);
  const handle = openDesktopDatabase(file);
  const app = createApplication({
    store: createSqliteStore(handle, uuidGenerator),
    clock: systemClock,
    ids: uuidGenerator,
  });
  const created = app.commands.createIntention(app.newContext("user-ui", "test"), {
    title: "Контент",
    desiredResult: "",
  });
  if (!created.ok) throw new Error(created.error.message);
  projectId = created.value.id;
  handle.close();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const plan = () => ({
  intentionId: projectId,
  rationale: "Утверждено владельцем",
  stages: [{ title: "Идея", actions: [{ title: "Придумать тему" }] }],
});
const stageCount = () => {
  const h = openDesktopDatabase(file);
  try {
    return (h.sqlite.prepare("select count(*) n from stages").get() as { n: number }).n;
  } finally {
    h.close();
  }
};

describe("apply-approved-plan", () => {
  it("dry run shows the result and writes nothing; --apply writes it", () => {
    const dry = runApprovedPlan({ databasePath: file, plan: plan() });
    expect(dry).toMatchObject({
      ok: true,
      value: { projectTitle: "Контент", firstAction: { title: "Придумать тему" } },
    });
    expect(stageCount()).toBe(0);
    if (!dry.ok) return;
    expect(runApprovedPlan({ databasePath: file, plan: plan(), applyFingerprint: "0000" })).toMatchObject({
      ok: false,
      error: { code: "REQUIRES_CONFIRMATION" },
    });
    expect(stageCount()).toBe(0);
    expect(
      runApprovedPlan({ databasePath: file, plan: plan(), applyFingerprint: dry.value.fingerprint }),
    ).toMatchObject({ ok: true });
    expect(stageCount()).toBe(1);
  });

  it("rejects a malformed plan and a missing database without touching anything", () => {
    expect(
      runApprovedPlan({ databasePath: file, plan: { intentionId: projectId }, applyFingerprint: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(
      runApprovedPlan({ databasePath: join(home, "nope.sqlite"), plan: plan(), applyFingerprint: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(stageCount()).toBe(0);
  });
});
