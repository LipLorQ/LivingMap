import type { Application } from "@living-map/application";
import { ok } from "@living-map/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manageWorkLifecycle } from "../src/main/work-lifecycle";

// Real accounting is covered in persistence-sqlite/test/execution.test.ts; this pins the wiring of
// the owner's Gate A decisions to the right Electron lifecycle moments.
function fakeApp() {
  const calls: string[] = [];
  const record = (name: string, value: unknown) => () => {
    calls.push(name);
    return ok(value);
  };
  const app = {
    newContext: () => ({}),
    commands: {
      recoverInterruptedWork: record("recover", null),
      heartbeatWork: record("heartbeat", "checkpoint"),
      pauseRunningWork: record("pause", null),
    },
  } as unknown as Application;
  return { app, calls };
}

function fakePower() {
  const listeners = new Map<string, () => void>();
  return { on: (event: string, l: () => void) => listeners.set(event, l), emit: (e: string) => listeners.get(e)?.() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("work lifecycle", () => {
  it("recovers a crashed interval first, then checkpoints about once a minute", () => {
    const { app, calls } = fakeApp();
    manageWorkLifecycle(app, fakePower());
    expect(calls).toEqual(["recover"]);
    vi.advanceTimersByTime(3 * 60_000);
    expect(calls).toEqual(["recover", "heartbeat", "heartbeat", "heartbeat"]);
  });

  it("OS suspend pauses; waking only re-checks the checkpoint and never resumes work", () => {
    const { app, calls } = fakeApp();
    const power = fakePower();
    manageWorkLifecycle(app, power);
    power.emit("suspend");
    power.emit("resume");
    power.emit("unlock-screen");
    expect(calls).toEqual(["recover", "pause", "heartbeat", "heartbeat"]);
  });

  it("the quit hook pauses synchronously and stops heartbeats", () => {
    const { app, calls } = fakeApp();
    const onQuit = manageWorkLifecycle(app, fakePower());
    onQuit();
    expect(calls).toEqual(["recover", "pause"]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(calls).toEqual(["recover", "pause"]);
  });
});
