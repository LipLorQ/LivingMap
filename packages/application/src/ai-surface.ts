import type {
  CreateRouteProposalInput,
  GetProposalInput,
  ListChangeHistoryInput,
  ProposeDesiredResultChangeInput,
  ReorderExistingActionsInput,
} from "@living-map/contracts";
import type { Application } from "./application";

/**
 * Everything an external AI may do, with the actor fixed to `mcp-ai`. The MCP process receives only
 * this — never `Application` — so no MCP code can create a `user-ui` context or reach other commands.
 */
export function createAiSurface(app: Application) {
  const ai = () => app.newContext("mcp-ai", "mcp");
  return {
    getStateRevision: () => app.queries.getStateRevision(),
    getPlanningContext: () => app.queries.getPlanningContext(),
    listChangeHistory: (input: ListChangeHistoryInput) => app.queries.listChangeHistory(input),
    getProposal: (input: GetProposalInput) => app.queries.getProposal(input),
    createRouteProposal: (input: CreateRouteProposalInput) => app.commands.createRouteProposal(ai(), input),
    proposeDesiredResultChange: (input: ProposeDesiredResultChangeInput) =>
      app.commands.proposeDesiredResultChange(ai(), input),
    reorderExistingActions: (input: ReorderExistingActionsInput) => app.commands.reorderExistingActions(ai(), input),
  };
}

export type AiSurface = ReturnType<typeof createAiSurface>;
