import { z } from "zod";

const Id = z.uuid();
const Ms = z.int().nonnegative();

/**
 * Execution facts for the `Сейчас` card. Only what the UI needs — never raw interval rows or
 * crash-recovery internals. `computedAt` lets the renderer advance a running timer locally
 * without a write per second.
 */
export const ExecutionDtoSchema = z.object({
  /** idle = no work recorded on the current Action yet; paused = some, none running. */
  state: z.enum(["idle", "running", "paused"]),
  /** The Action the timer belongs to (the current one), or null without a current Action. */
  actionId: Id.nullable(),
  /** All work on this Action (every interval), including the running one up to computedAt. */
  actionWorkedMs: Ms,
  todayWorkedMs: Ms,
  weekWorkedMs: Ms,
  dailyWorkTargetMinutes: z.int().positive(),
  computedAt: z.iso.datetime(),
});
export type ExecutionDto = z.infer<typeof ExecutionDtoSchema>;

export const WorkActionInputSchema = z.strictObject({ actionId: Id });
export type WorkActionInput = z.infer<typeof WorkActionInputSchema>;

export const SetDailyWorkTargetInputSchema = z.strictObject({
  minutes: z
    .int()
    .min(1)
    .max(24 * 60),
});
export type SetDailyWorkTargetInput = z.infer<typeof SetDailyWorkTargetInputSchema>;
