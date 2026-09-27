import type { EntityId, Instant } from "@living-map/domain";
import type { Clock, IdGenerator } from "./ports";

/** Who performs a command (ARCHITECTURE §19). `account-user` is intentionally absent. */
export type Actor = "user-ui" | "mcp-ai" | "system";

/** Entry point the command came through. Application logic never branches on it. */
export type CommandSource = "ipc" | "mcp" | "test";

export type CommandContext = {
  readonly actor: Actor;
  readonly source: CommandSource;
  readonly correlationId: EntityId;
  readonly timestamp: Instant;
};

export function createCommandContext(
  deps: { clock: Clock; ids: IdGenerator },
  actor: Actor,
  source: CommandSource,
): CommandContext {
  return { actor, source, correlationId: deps.ids.next(), timestamp: deps.clock.now() };
}
