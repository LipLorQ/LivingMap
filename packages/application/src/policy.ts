import type { Actor } from "./context";

/**
 * Explicit capability allowlist for write commands (ARCHITECTURE §22).
 * Absence of a rule is NOT permission: unknown command or actor → denied.
 * Reads (queries) are open to every actor in the spike.
 *
 * `mcp-ai` may only (a) create proposals and (b) run the SAFE WRITEs: reordering the already
 * approved Actions of an already approved route, and saving a Memory. Every direct domain write — and accepting or
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
  // Stage 8: a project's lifecycle and order are strategic — activating, pausing, completing or releasing
  // one is the owner's decision (no mcp-ai entry: the AI can only suggest it in words).
  "intention.changeStatus": ["user-ui", "system"],
  "intention.reorder": ["user-ui", "system"],
  // Stage 8: the far layers (decades, 3-year horizon, year) and their courses of change belong to the owner alone.
  "strategy.save": ["user-ui", "system"],
  "strategy.remove": ["user-ui", "system"],
  "strategy.resolveCourseChange": ["user-ui", "system"],
  // Stage 8: daily routines are the owner's stable infrastructure of the day; the AI neither reads nor edits them.
  "routine.add": ["user-ui", "system"],
  "routine.edit": ["user-ui", "system"],
  "routine.remove": ["user-ui", "system"],
  "routine.reorder": ["user-ui", "system"],
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
  // Google Calendar boundary (ARCHITECTURE §32/§18): only the desktop main process refreshes and
  // persists the snapshot; mcp-ai is deliberately absent — the AI only ever reads it.
  "calendar.save": ["user-ui", "system"],
  // Execution (Stage 5): direct user actions only. mcp-ai may read execution facts, never control them.
  "work.start": ["user-ui", "system"],
  "work.pause": ["user-ui", "system"],
  "work.recover": ["system"],
  "settings.dailyWorkTarget": ["user-ui", "system"],
  // Universal `+` (Stage 6, ADR-0007): the user saves raw text; only the desktop's own processor
  // (system) moves it through AI processing. mcp-ai can read Captures, never create or resolve them.
  "capture.create": ["user-ui", "system"],
  "capture.retry": ["user-ui", "system"],
  "capture.process": ["system"],
  // SAFE WRITE (ARCHITECTURE §22 B): a memory is context for future decisions only — it never changes
  // strategy, the order, `Сейчас`, the route or any user setting.
  "memory.save": ["mcp-ai", "system"],
  // Forgetting is the user's decision only: the AI can add to memory, never erase it.
  "memory.forget": ["user-ui", "system"],
  // Reviews (Stage 7): scheduling/processing is the desktop's own background work (system only —
  // mirrors capture.process); mcp-ai has no policy entry for ANY review/pattern/rule command below,
  // so it structurally cannot process a review, resolve a finding, confirm a Pattern or touch a rule.
  "review.schedule": ["system"],
  "review.process": ["system"],
  "review.retry": ["user-ui", "system"],
  "reviewFinding.accept": ["user-ui", "system"],
  "reviewFinding.correct": ["user-ui", "system"],
  "reviewFinding.reject": ["user-ui", "system"],
  // A Pattern candidate becomes a rule ONLY through explicit user confirmation (this stage's prompt §17).
  "pattern.confirm": ["user-ui", "system"],
  "pattern.reject": ["user-ui", "system"],
  "planningRule.deactivate": ["user-ui", "system"],
} as const satisfies Record<string, readonly Actor[]>;

export type CommandName = keyof typeof COMMAND_POLICY;

export function isAllowed(command: string, actor: Actor): boolean {
  if (!Object.hasOwn(COMMAND_POLICY, command)) return false;
  const allowed: readonly Actor[] = COMMAND_POLICY[command as CommandName];
  return allowed.includes(actor);
}
