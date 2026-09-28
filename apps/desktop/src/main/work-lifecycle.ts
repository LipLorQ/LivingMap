import type { Application } from "@living-map/application";

type PowerEvents = { on(event: "suspend" | "resume" | "unlock-screen", listener: () => void): unknown };

/**
 * Owner decisions (Stage 5 Gate A): focus loss / minimize never touch the timer; OS suspend and app
 * quit pause it; a crash is capped at the last ~1-minute checkpoint on the next launch. No
 * auto-resume anywhere. Commands are synchronous SQLite writes, so the quit pause completes before
 * the caller closes the database — no async race, no quit loop.
 * Returns the quit hook: call it before closing the database.
 */
export function manageWorkLifecycle(app: Application, power: PowerEvents, heartbeatMs = 60_000): () => void {
  const system = () => app.newContext("system", "ipc");
  app.commands.recoverInterruptedWork(system());
  const timer = setInterval(() => app.commands.heartbeatWork(system()), heartbeatMs);
  power.on("suspend", () => app.commands.pauseRunningWork(system()));
  // Waking up: check at once whether the timer silently ran through a sleep nobody announced.
  power.on("resume", () => app.commands.heartbeatWork(system()));
  power.on("unlock-screen", () => app.commands.heartbeatWork(system()));
  return () => {
    clearInterval(timer);
    app.commands.pauseRunningWork(system());
  };
}
