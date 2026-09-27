import { describe, expect, it } from "vitest";
import { blockAction, completeAction, createAction, editAction, reopenAction, unblockAction } from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";

function open(overrides: Partial<Parameters<typeof createAction>[0]> = {}) {
  const created = createAction({
    id: "a1",
    stageId: "st1",
    title: "write the draft",
    doneWhen: "draft exists in the repo",
    position: 1,
    now: T0,
    ...overrides,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

describe("Action", () => {
  it("is created open, unblocked, uncompleted, at version 1", () => {
    expect(open()).toEqual({
      id: "a1",
      stageId: "st1",
      title: "write the draft",
      doneWhen: "draft exists in the repo",
      position: 1,
      status: "open",
      blocker: null,
      version: 1,
      createdAt: T0,
      updatedAt: T0,
      completedAt: null,
    });
  });

  it("rejects an empty title", () => {
    expect(createAction({ id: "a1", stageId: "st1", title: " ", doneWhen: "", position: 1, now: T0 }).ok).toBe(false);
  });

  describe("blockAction / unblockAction", () => {
    it("blocking records a reason and timestamp, bumps version", () => {
      const blocked = blockAction(open(), " waiting on design ", T1);
      expect(blocked).toEqual({
        ok: true,
        value: {
          ...open(),
          status: "blocked",
          blocker: { reason: "waiting on design", blockedAt: T1 },
          version: 2,
          updatedAt: T1,
        },
      });
    });

    it("rejects an empty blocker reason", () => {
      expect(blockAction(open(), "  ", T1).ok).toBe(false);
    });

    it("cannot block an already-completed action", () => {
      const done = completeAction(open(), T1);
      if (!done.ok) throw new Error("unreachable");
      expect(blockAction(done.value, "too late", T1)).toEqual({ ok: false, reason: "Cannot block a completed action" });
    });

    it("unblocking clears the blocker and returns to open", () => {
      const blocked = blockAction(open(), "waiting", T1);
      if (!blocked.ok) throw new Error("unreachable");
      const unblocked = unblockAction(blocked.value, T1);
      expect(unblocked).toEqual({
        ok: true,
        value: { ...open(), status: "open", blocker: null, version: 3, updatedAt: T1 },
      });
    });

    it("cannot unblock an action that is not blocked", () => {
      expect(unblockAction(open(), T1)).toEqual({ ok: false, reason: "Action is not blocked" });
    });
  });

  describe("completeAction", () => {
    it("marks done and stamps completedAt", () => {
      const done = completeAction(open(), T1);
      expect(done).toEqual({
        ok: true,
        value: { ...open(), status: "done", completedAt: T1, version: 2, updatedAt: T1 },
      });
    });

    it("cannot complete an already-completed action", () => {
      const done = completeAction(open(), T1);
      if (!done.ok) throw new Error("unreachable");
      expect(completeAction(done.value, T1)).toEqual({ ok: false, reason: "Action is already completed" });
    });

    it("cannot complete a blocked action; must unblock first", () => {
      const blocked = blockAction(open(), "waiting", T1);
      if (!blocked.ok) throw new Error("unreachable");
      expect(completeAction(blocked.value, T1)).toEqual({
        ok: false,
        reason: "Cannot complete a blocked action; unblock it first",
      });
    });
  });

  describe("reopenAction", () => {
    it("returns a done action to open, clears completedAt, bumps version", () => {
      const done = completeAction(open(), T1);
      if (!done.ok) throw new Error("unreachable");
      expect(reopenAction(done.value, T1)).toEqual({
        ok: true,
        value: { ...open(), status: "open", completedAt: null, version: 3, updatedAt: T1 },
      });
    });

    it("cannot reopen an action that is not completed", () => {
      expect(reopenAction(open(), T1)).toEqual({ ok: false, reason: "Action is not completed" });
    });
  });

  describe("editAction", () => {
    it("updates title and doneWhen, bumps version", () => {
      const edited = editAction(open(), { title: "write final draft", doneWhen: "PR opened" }, T1);
      expect(edited).toEqual({
        ok: true,
        value: { ...open(), title: "write final draft", doneWhen: "PR opened", version: 2, updatedAt: T1 },
      });
    });

    it("cannot edit a completed action", () => {
      const done = completeAction(open(), T1);
      if (!done.ok) throw new Error("unreachable");
      expect(editAction(done.value, { title: "x", doneWhen: "y" }, T1)).toEqual({
        ok: false,
        reason: "Cannot edit a completed action",
      });
    });
  });
});
