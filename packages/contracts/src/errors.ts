import { z } from "zod";

/** Stable external error contract shared by IPC and MCP (ARCHITECTURE §29). */
export const APP_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT_RELOAD",
  "PERMISSION_DENIED",
  "REQUIRES_CONFIRMATION",
  "STALE_PROPOSAL",
  "NEEDS_AI_REPLAN",
  "INTEGRATION_UNAVAILABLE",
  "STORAGE_ERROR",
  "SCHEMA_INCOMPATIBLE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Never carries stack traces, SQL or local file paths. */
export const AppErrorSchema = z.object({
  code: z.enum(APP_ERROR_CODES),
  message: z.string(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(code: AppErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});
