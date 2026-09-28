import type { Actor } from "./context";

/**
 * Explicit capability allowlist for write commands (ARCHITECTURE §22).
 * Absence of a rule is NOT permission: unknown command or actor → denied.
 * Reads (queries) are open to every actor in the spike.
 *
 * `mcp-ai` may only (a) create proposals and (b) run the one SAFE WRITE: reordering the already
 * approved Actions of an already approved route. Every direct domain write — and accepting or
 * rejecting a proposal — is `user-ui`/`system` only, so a strategic change can reach the domain
 * solely through `proposal.accept` performed by the user (ARCHITECTURE §22–24).
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
  "proposal.create": ["mcp-ai", "system"],
  "proposal.accept": ["user-ui", "system"],
  "proposal.reject": ["user-ui", "system"],
  "plan.reorder": ["mcp-ai", "system"],
} as const satisfies Record<string, readonly Actor[]>;

export type CommandName = keyof typeof COMMAND_POLICY;

export function isAllowed(command: string, actor: Actor): boolean {
  if (!Object.hasOwn(COMMAND_POLICY, command)) return false;
  const allowed: readonly Actor[] = COMMAND_POLICY[command as CommandName];
  return allowed.includes(actor);
}
