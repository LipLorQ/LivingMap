// Kept free of runtime dependencies: the sandboxed preload imports this file.
import type { Result } from "./errors";
import type { CreateProbeInput, GetProbeInput, ProbeDto, RenameProbeInput, StateRevisionDto } from "./probe";

/** The complete, finite set of IPC channels (ARCHITECTURE §30). No dynamic channels. */
export const IPC_CHANNELS = {
  getStateRevision: "lm:query:getStateRevision",
  listProbes: "lm:query:listProbes",
  getProbe: "lm:query:getProbe",
  createProbe: "lm:command:createProbe",
  renameProbe: "lm:command:renameProbe",
  stateChanged: "lm:event:stateChanged",
} as const;

export type LivingMapApi = {
  queries: {
    getStateRevision(): Promise<Result<StateRevisionDto>>;
    listProbes(): Promise<Result<ProbeDto[]>>;
    getProbe(input: GetProbeInput): Promise<Result<ProbeDto>>;
  };
  commands: {
    createProbe(input: CreateProbeInput): Promise<Result<ProbeDto>>;
    renameProbe(input: RenameProbeInput): Promise<Result<ProbeDto>>;
  };
  events: {
    /** Returns an unsubscribe function. */
    onStateChanged(listener: (change: StateRevisionDto) => void): () => void;
  };
};
