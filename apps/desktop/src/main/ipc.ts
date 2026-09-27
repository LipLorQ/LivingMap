import type { Application } from "@living-map/application";
import {
  CreateProbeInputSchema,
  err,
  GetProbeInputSchema,
  RenameProbeInputSchema,
  type Result,
} from "@living-map/contracts";
import { IPC_CHANNELS } from "@living-map/contracts/ipc";
import { ipcMain, type WebFrameMain } from "electron";
import { z } from "zod";

type TrustCheck = (frame: WebFrameMain | null) => boolean;

/**
 * The renderer is an untrusted boundary (ARCHITECTURE §30): every payload is re-validated here,
 * the sender frame is checked, and handlers only delegate to application use cases.
 */
export function registerIpcHandlers(app: Application, isTrusted: TrustCheck): void {
  function handle<S extends z.ZodType>(
    channel: string,
    schema: S | null,
    run: (input: z.infer<S>) => Result<unknown>,
  ): void {
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!isTrusted(event.senderFrame)) return err("PERMISSION_DENIED", "Untrusted sender");
      if (schema === null) {
        return raw === undefined ? run(undefined as z.infer<S>) : err("VALIDATION_ERROR", "No input expected");
      }
      const parsed = schema.safeParse(raw);
      return parsed.success ? run(parsed.data) : err("VALIDATION_ERROR", z.prettifyError(parsed.error));
    });
  }

  const ui = () => app.newContext("user-ui", "ipc");

  handle(IPC_CHANNELS.getStateRevision, null, () => app.queries.getStateRevision());
  handle(IPC_CHANNELS.listProbes, null, () => app.queries.listProbes());
  handle(IPC_CHANNELS.getProbe, GetProbeInputSchema, (input) => app.queries.getProbe(input));
  handle(IPC_CHANNELS.createProbe, CreateProbeInputSchema, (input) => app.commands.createProbe(ui(), input));
  handle(IPC_CHANNELS.renameProbe, RenameProbeInputSchema, (input) => app.commands.renameProbe(ui(), input));
}
