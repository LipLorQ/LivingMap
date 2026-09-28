import { describe, expect, it } from "vitest";
import { type SelectableAction, selectCurrentAction } from "../src";

const NOW = "2026-09-28T10:00:00.000Z";

const action = (
  id: string,
  status: SelectableAction["status"],
  estimatedDurationMinutes?: number | null,
): SelectableAction =>
  estimatedDurationMinutes === undefined ? { id, status } : { id, status, estimatedDurationMinutes };

describe("selectCurrentAction", () => {
  it("returns NeedsAIReplan when there is no plan at all", () => {
    expect(selectCurrentAction({ orderedActionIds: null, actions: [], now: NOW, nextHardEventStart: null })).toEqual({
      status: "needs-ai-replan",
    });
  });

  it("selects the first action when nothing blocks it", () => {
    const actions = [action("a1", "open"), action("a2", "open")];
    expect(
      selectCurrentAction({ orderedActionIds: ["a1", "a2"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "selected", actionId: "a1", reason: { kind: "first-in-plan" } });
  });

  it("skips a done action and reports why", () => {
    const actions = [action("a1", "done"), action("a2", "open")];
    expect(
      selectCurrentAction({ orderedActionIds: ["a1", "a2"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "selected", actionId: "a2", reason: { kind: "previous-done" } });
  });

  it("skips a blocked action and reports why", () => {
    const actions = [action("a1", "blocked"), action("a2", "open")];
    expect(
      selectCurrentAction({ orderedActionIds: ["a1", "a2"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "selected", actionId: "a2", reason: { kind: "previous-blocked" } });
  });

  it("preserves plan ordering: never reranks past an admissible earlier action", () => {
    const actions = [action("a1", "open"), action("a2", "open")];
    expect(
      selectCurrentAction({ orderedActionIds: ["a2", "a1"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "selected", actionId: "a2", reason: { kind: "first-in-plan" } });
  });

  it("returns NeedsAIReplan when every action in the order is done or blocked", () => {
    const actions = [action("a1", "done"), action("a2", "blocked")];
    expect(
      selectCurrentAction({ orderedActionIds: ["a1", "a2"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "needs-ai-replan" });
  });

  it("skips an action whose known duration objectively does not fit before the next hard event", () => {
    const actions = [action("a1", "open", 60), action("a2", "open")];
    const nextHardEventStart = "2026-09-28T10:30:00.000Z"; // 30 minutes away, action needs 60
    expect(selectCurrentAction({ orderedActionIds: ["a1", "a2"], actions, now: NOW, nextHardEventStart })).toEqual({
      status: "selected",
      actionId: "a2",
      reason: { kind: "first-in-plan" },
    });
  });

  it("does not invent a fit when duration is unknown, even with an imminent hard event", () => {
    const actions = [action("a1", "open")]; // no estimatedDurationMinutes
    const nextHardEventStart = "2026-09-28T10:05:00.000Z"; // 5 minutes away
    expect(selectCurrentAction({ orderedActionIds: ["a1"], actions, now: NOW, nextHardEventStart })).toEqual({
      status: "selected",
      actionId: "a1",
      reason: { kind: "first-in-plan" },
    });
  });

  it("selects an action whose known duration does fit before the next hard event", () => {
    const actions = [action("a1", "open", 15)];
    const nextHardEventStart = "2026-09-28T10:30:00.000Z"; // 30 minutes away, action needs 15
    expect(selectCurrentAction({ orderedActionIds: ["a1"], actions, now: NOW, nextHardEventStart })).toEqual({
      status: "selected",
      actionId: "a1",
      reason: { kind: "first-in-plan" },
    });
  });

  it("ignores an id in the order that no longer resolves to a known action", () => {
    const actions = [action("a2", "open")];
    expect(
      selectCurrentAction({ orderedActionIds: ["ghost", "a2"], actions, now: NOW, nextHardEventStart: null }),
    ).toEqual({ status: "selected", actionId: "a2", reason: { kind: "first-in-plan" } });
  });
});
