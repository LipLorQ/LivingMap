import {
  type CreateProbeInput,
  err,
  type GetProbeInput,
  ok,
  type ProbeDto,
  type RenameProbeInput,
  type Result,
  type StateRevisionDto,
} from "@living-map/contracts";
import { createProbe, isAtVersion, type Probe, renameProbe } from "@living-map/domain";
import { type Actor, type CommandContext, type CommandSource, createCommandContext } from "./context";
import { type CommandName, isAllowed } from "./policy";
import type { Clock, IdGenerator, Store, WriteScope } from "./ports";

export type ApplicationDeps = {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  /** Technical diagnostics only; never receives user content beyond the thrown error. */
  reportError?: (operation: string, error: unknown) => void;
};

const toDto = (p: Probe): ProbeDto => ({ ...p });

/** Carries a failed Result out of a write transaction so the store rolls it back. */
class RollbackSignal {
  constructor(readonly result: Result<never>) {}
}

export function createApplication(deps: ApplicationDeps) {
  const { store, clock, ids } = deps;

  function guarded<T>(operation: string, run: () => Result<T>): Result<T> {
    try {
      return run();
    } catch (error) {
      deps.reportError?.(operation, error);
      return err("STORAGE_ERROR", "Storage operation failed");
    }
  }

  /**
   * The only way commands write (ARCHITECTURE §44): returning a failed Result from `work`
   * rolls the transaction back exactly like a throw — never a half-applied command.
   */
  function transact<T>(ctx: CommandContext, work: (scope: WriteScope) => Result<T>): Result<T> {
    try {
      return store.write(ctx, (scope) => {
        const result = work(scope);
        if (!result.ok) throw new RollbackSignal(result);
        return result;
      });
    } catch (error) {
      if (error instanceof RollbackSignal) return error.result;
      throw error;
    }
  }

  function authorize(command: CommandName, ctx: CommandContext): Result<never> | undefined {
    return isAllowed(command, ctx.actor) ? undefined : err("PERMISSION_DENIED", `${ctx.actor} may not ${command}`);
  }

  return {
    newContext: (actor: Actor, source: CommandSource): CommandContext =>
      createCommandContext({ clock, ids }, actor, source),

    queries: {
      getStateRevision: (): Result<StateRevisionDto> =>
        guarded("getStateRevision", () => ok({ stateRevision: store.read((s) => s.stateRevision()) })),

      listProbes: (): Result<ProbeDto[]> =>
        guarded("listProbes", () => ok(store.read((s) => s.probes.list()).map(toDto))),

      getProbe: (input: GetProbeInput): Result<ProbeDto> =>
        guarded("getProbe", () => {
          const probe = store.read((s) => s.probes.findById(input.id));
          return probe ? ok(toDto(probe)) : err("NOT_FOUND", "Probe not found");
        }),
    },

    commands: {
      createProbe: (ctx: CommandContext, input: CreateProbeInput): Result<ProbeDto> =>
        authorize("probe.create", ctx) ??
        guarded("createProbe", () => {
          const created = createProbe({ id: ids.next(), title: input.title, now: clock.now() });
          if (!created.ok) return err("VALIDATION_ERROR", created.reason);
          const probe = created.value;
          return transact(ctx, (s) => {
            s.probes.insert(probe);
            s.recordChange({
              commandType: "probe.create",
              entityType: "probe",
              entityId: probe.id,
              summary: "created",
            });
            return ok(toDto(probe));
          });
        }),

      renameProbe: (ctx: CommandContext, input: RenameProbeInput): Result<ProbeDto> =>
        authorize("probe.rename", ctx) ??
        guarded("renameProbe", () =>
          transact(ctx, (s): Result<ProbeDto> => {
            const current = s.probes.findById(input.id);
            if (!current) return err("NOT_FOUND", "Probe not found");
            if (!isAtVersion(current, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", `Probe changed (now v${current.version}); reload and retry`);
            }
            const renamed = renameProbe(current, input.title, clock.now());
            if (!renamed.ok) return err("VALIDATION_ERROR", renamed.reason);
            // Storage-level guard: even if the check above were bypassed, a stale version never overwrites.
            if (!s.probes.updateIfVersion(renamed.value, input.expectedVersion)) {
              return err("CONFLICT_RELOAD", "Probe changed concurrently; reload and retry");
            }
            s.recordChange({
              commandType: "probe.rename",
              entityType: "probe",
              entityId: current.id,
              summary: `v${current.version}→v${renamed.value.version}`,
            });
            return ok(toDto(renamed.value));
          }),
        ),
    },
  };
}

export type Application = ReturnType<typeof createApplication>;
