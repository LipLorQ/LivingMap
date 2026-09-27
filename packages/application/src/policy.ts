import type { Actor } from "./context";

/**
 * Explicit capability allowlist for write commands (ARCHITECTURE §22).
 * Absence of a rule is NOT permission: unknown command or actor → denied.
 * Reads (queries) are open to every actor in the spike.
 */
export const COMMAND_POLICY = {
  "probe.create": ["user-ui", "system"],
  "probe.rename": ["user-ui", "mcp-ai", "system"],
} as const satisfies Record<string, readonly Actor[]>;

export type CommandName = keyof typeof COMMAND_POLICY;

export function isAllowed(command: string, actor: Actor): boolean {
  if (!Object.hasOwn(COMMAND_POLICY, command)) return false;
  const allowed: readonly Actor[] = COMMAND_POLICY[command as CommandName];
  return allowed.includes(actor);
}
