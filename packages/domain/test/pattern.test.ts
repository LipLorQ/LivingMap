import { describe, expect, it } from "vitest";
import {
  confirmPattern,
  createPatternCandidate,
  createPlanningRule,
  deactivatePlanningRule,
  growPatternCandidate,
  rejectPattern,
} from "../src";

describe("Pattern candidate", () => {
  it("refuses a single episode: at least two distinct evidence items are required", () => {
    expect(
      createPatternCandidate({
        id: "p",
        patternKey: "k",
        text: "Похоже, это повторяется",
        evidenceFindingIds: ["f1"],
        now: "t",
      }).ok,
    ).toBe(false);
    expect(
      createPatternCandidate({ id: "p", patternKey: "k", text: "x", evidenceFindingIds: ["f1", "f1"], now: "t" }).ok,
    ).toBe(false); // de-duplicated first, so still only one distinct item
  });

  it("accepts two or more distinct evidence items", () => {
    const r = createPatternCandidate({
      id: "p",
      patternKey: "doctor-visits",
      text: "Похоже, это повторяется",
      evidenceFindingIds: ["f1", "f2"],
      now: "t",
    });
    expect(r).toMatchObject({
      ok: true,
      value: { status: "candidate", patternKey: "doctor-visits", evidenceFindingIds: ["f1", "f2"] },
    });
  });

  it("grows a still-pending candidate's evidence instead of duplicating; not once resolved", () => {
    const created = createPatternCandidate({
      id: "p",
      patternKey: "k",
      text: "x",
      evidenceFindingIds: ["f1", "f2"],
      now: "t0",
    });
    if (!created.ok) throw new Error("setup");
    const grown = growPatternCandidate(created.value, ["f1", "f2", "f3"], "t1");
    expect(grown).toMatchObject({ ok: true, value: { status: "candidate", evidenceFindingIds: ["f1", "f2", "f3"] } });
    expect(grown.ok && confirmPattern(grown.value, "user-ui", "t2")).toMatchObject({ ok: true });
    const confirmed = confirmPattern(created.value, "user-ui", "t1");
    if (!confirmed.ok) throw new Error("setup");
    expect(growPatternCandidate(confirmed.value, ["f1", "f2", "f3"], "t2").ok).toBe(false);
  });

  it("«Сделать правилом» / «Не считать правилом» each resolve a candidate exactly once", () => {
    const created = createPatternCandidate({
      id: "p",
      patternKey: "k",
      text: "x",
      evidenceFindingIds: ["f1", "f2"],
      now: "t0",
    });
    if (!created.ok) throw new Error("setup");
    const confirmed = confirmPattern(created.value, "user-ui", "t1");
    expect(confirmed).toMatchObject({ ok: true, value: { status: "confirmed", resolvedBy: "user-ui" } });
    expect(confirmed.ok && confirmPattern(confirmed.value, "user-ui", "t2").ok).toBe(false);

    const rejected = rejectPattern(created.value, "user-ui", "t1");
    expect(rejected).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(rejected.ok && rejectPattern(rejected.value, "user-ui", "t2").ok).toBe(false);
  });
});

describe("PlanningRule", () => {
  it("is created active from a confirmed pattern and can be deactivated exactly once", () => {
    const rule = createPlanningRule({
      id: "pr",
      text: "Планировать медицинские визиты с запасом",
      sourcePatternId: "p1",
      now: "t0",
    });
    expect(rule).toMatchObject({ status: "active", deactivatedAt: null });
    const deactivated = deactivatePlanningRule(rule, "t1");
    expect(deactivated).toMatchObject({ ok: true, value: { status: "inactive", deactivatedAt: "t1" } });
    expect(deactivated.ok && deactivatePlanningRule(deactivated.value, "t2").ok).toBe(false);
  });
});
