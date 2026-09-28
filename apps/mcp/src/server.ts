import type { Application, CommandContext } from "@living-map/application";
import {
  CreateRouteProposalInputSchema,
  err,
  GetProposalInputSchema,
  ListChangeHistoryInputSchema,
  ProposeDesiredResultChangeInputSchema,
  ReorderExistingActionsInputSchema,
  type Result,
} from "@living-map/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The complete MCP tool whitelist with its capability class (ARCHITECTURE §22, §39). The surface
 * itself encodes the boundary: there is no tool to accept/reject a proposal, write the domain
 * directly, run SQL, touch files/shell/migrations/policy, or change Season / Good Life Conditions.
 * Every tool delegates to one application query/command; policy is enforced there too.
 */
export const MCP_TOOLS = {
  get_state_revision: "read",
  get_living_map_context: "read",
  get_history: "read",
  get_proposal: "read",
  create_route_proposal: "proposal",
  propose_desired_result_change: "proposal",
  reorder_existing_actions: "safe-write",
} as const;
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as (keyof typeof MCP_TOOLS)[];

export type McpBackend = { status: "ready"; app: Application } | { status: "unavailable"; reason: string };

const toToolResult = (result: Result<unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  isError: !result.ok,
});

export function createLivingMapMcpServer(
  resolveBackend: () => McpBackend,
  invalidateBackend: () => void,
  version: string,
): McpServer {
  const server = new McpServer({ name: "living-map", version });

  // Tool handler path: MCP input → Zod (SDK, contract schema) → application (capability policy →
  // domain → repository transaction) → typed result. Every write runs as actor `mcp-ai` with a
  // fresh correlationId.
  const run = (use: (app: Application, ai: () => CommandContext) => Result<unknown>): CallToolResult => {
    const backend = resolveBackend();
    if (backend.status !== "ready") return toToolResult(err("SCHEMA_INCOMPATIBLE", backend.reason));
    const { app } = backend;
    const result = use(app, () => app.newContext("mcp-ai", "mcp"));
    // A per-write schema check (ADR-0003) just failed on a connection we thought was ready —
    // drop it instead of repeating the same stale error on every subsequent call.
    if (!result.ok && result.error.code === "SCHEMA_INCOMPATIBLE") invalidateBackend();
    return toToolResult(result);
  };

  const read = { readOnlyHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "get_state_revision",
    { description: "Global monotonically increasing revision of the Living Map state.", annotations: read },
    () => run((app) => app.queries.getStateRevision()),
  );

  server.registerTool(
    "get_living_map_context",
    {
      description:
        "Read the user's whole current planning reality in one call: stateRevision, Season focus, «Чем ты не хочешь жертвовать ради целей?» (hard constraints), the active Intention with its desired result, Stages, Actions (status, doneWhen, blockers), the approved OrderedActionPlan, unplanned actions, pending proposals and recent history. `meanings` explains what every concept means to the user and what you may and may not change — read it first.",
      annotations: read,
    },
    () => run((app) => app.queries.getPlanningContext()),
  );

  server.registerTool(
    "get_history",
    {
      description: "Meaningful changes, newest first (actor user-ui = the user, mcp-ai = an AI).",
      inputSchema: ListChangeHistoryInputSchema,
      annotations: read,
    },
    (input) => run((app) => app.queries.listChangeHistory(input)),
  );

  server.registerTool(
    "get_proposal",
    {
      description:
        "Read one proposal and its current status (pending / accepted / rejected / stale). Use it to learn whether the user accepted your proposal.",
      inputSchema: GetProposalInputSchema,
      annotations: read,
    },
    (input) => run((app) => app.queries.getProposal(input)),
  );

  server.registerTool(
    "create_route_proposal",
    {
      description:
        "Propose a route for the Intention: the first route or a replan. Can add Stages and Actions (with doneWhen), rename Stages, edit title/doneWhen of unfinished Actions, set the Stage sequence, and must give the full execution order (actionOrder) of every unfinished action. New entities get a `ref` you use elsewhere in the same call. Nothing is applied: the user reviews the exact resulting route in the LivingMap desktop app and confirms or rejects it. Cannot delete anything or change action statuses.",
      inputSchema: CreateRouteProposalInputSchema,
      annotations: write,
    },
    (input) => run((app, ai) => app.commands.createRouteProposal(ai(), input)),
  );

  server.registerTool(
    "propose_desired_result_change",
    {
      description:
        "Propose a new desired result (what must become true for the Intention to count as embodied). Applied only if the user confirms it in the desktop app.",
      inputSchema: ProposeDesiredResultChangeInputSchema,
      annotations: write,
    },
    (input) => run((app, ai) => app.commands.proposeDesiredResultChange(ai(), input)),
  );

  server.registerTool(
    "reorder_existing_actions",
    {
      description:
        "SAFE WRITE, applied immediately: reorder the unfinished actions of an ALREADY APPROVED route (orderedActionPlan must exist) and update the order's rationale. Must list exactly every unfinished action once. Cannot create, delete, rename, complete or unblock anything. Before the first route is approved, use create_route_proposal instead.",
      inputSchema: ReorderExistingActionsInputSchema,
      annotations: write,
    },
    (input) => run((app, ai) => app.commands.reorderExistingActions(ai(), input)),
  );

  return server;
}
