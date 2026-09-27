import type { Actor } from "./context";

/**
 * Explicit capability allowlist for write commands (ARCHITECTURE §22).
 * Absence of a rule is NOT permission: unknown command or actor → denied.
 * Reads (queries) are open to every actor in the spike.
 *
 * `mcp-ai` is deliberately absent from every command below: this stage does not expose the real
 * product domain to MCP (this stage's prompt §2/§19 — that is Stage 3's job). Only `user-ui` and
 * `system` (tests, fixtures) may write.
 */
export const COMMAND_POLICY = {
  "season.create": ["user-ui", "system"],
  "season.updateFocus": ["user-ui", "system"],
  "goodLifeCondition.add": ["user-ui", "system"],
  "goodLifeCondition.edit": ["user-ui", "system"],
  "goodLifeCondition.remove": ["user-ui", "system"],
  "goodLifeCondition.reorder": ["user-ui", "system"],
  "intention.create": ["user-ui", "system"],
  "intention.update": ["user-ui", "system"],
  "stage.add": ["user-ui", "system"],
  "stage.edit": ["user-ui", "system"],
  "stage.reorder": ["user-ui", "system"],
  "stage.setCurrent": ["user-ui", "system"],
  "action.add": ["user-ui", "system"],
  "action.edit": ["user-ui", "system"],
  "action.complete": ["user-ui", "system"],
  "action.block": ["user-ui", "system"],
  "action.unblock": ["user-ui", "system"],
  "action.reopen": ["user-ui", "system"],
  "action.reorder": ["user-ui", "system"],
} as const satisfies Record<string, readonly Actor[]>;

export type CommandName = keyof typeof COMMAND_POLICY;

export function isAllowed(command: string, actor: Actor): boolean {
  if (!Object.hasOwn(COMMAND_POLICY, command)) return false;
  const allowed: readonly Actor[] = COMMAND_POLICY[command as CommandName];
  return allowed.includes(actor);
}
