import type {
  CreateRouteProposalInput,
  GetProposalInput,
  ListCapturesInput,
  ListChangeHistoryInput,
  ProposeDesiredResultChangeInput,
  ReorderExistingActionsInput,
  SaveMemoryInput,
  SearchMemoryInput,
} from "@living-map/contracts";
import type { Application } from "./application";

/**
 * Everything an external AI may do, with the actor fixed to `mcp-ai`. The MCP process receives only
 * this — never `Application` — so no MCP code can create a `user-ui` context or reach other commands.
 */
export function createAiSurface(app: Application, captureId?: string) {
  // An MCP child started for one `+` Capture links every write of its run to that Capture (ADR-0007).
  const ai = () => ({ ...app.newContext("mcp-ai", "mcp"), ...(captureId && { captureId }) });
  return {
    getStateRevision: () => app.queries.getStateRevision(),
    getPlanningContext: () => app.queries.getPlanningContext(),
    listChangeHistory: (input: ListChangeHistoryInput) => app.queries.listChangeHistory(input),
    getProposal: (input: GetProposalInput) => app.queries.getProposal(input),
    listCaptures: (input: ListCapturesInput) => app.queries.listCaptures(input),
    searchMemory: (input: SearchMemoryInput) => app.queries.searchMemory(input),
    createRouteProposal: (input: CreateRouteProposalInput) => app.commands.createRouteProposal(ai(), input),
    proposeDesiredResultChange: (input: ProposeDesiredResultChangeInput) =>
      app.commands.proposeDesiredResultChange(ai(), input),
    reorderExistingActions: (input: ReorderExistingActionsInput) => app.commands.reorderExistingActions(ai(), input),
    saveMemory: (input: SaveMemoryInput) => app.commands.saveMemory(ai(), input),
  };
}

export type AiSurface = ReturnType<typeof createAiSurface>;
