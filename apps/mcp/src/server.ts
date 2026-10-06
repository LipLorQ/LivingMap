import type { AiSurface } from "@living-map/application";
import {
  CreateRouteProposalInputSchema,
  err,
  GetProposalInputSchema,
  ListCapturesInputSchema,
  ListChangeHistoryInputSchema,
  ProposeDesiredResultChangeInputSchema,
  ReorderExistingActionsInputSchema,
  type Result,
  SaveMemoryInputSchema,
  SearchMemoryInputSchema,
} from "@living-map/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The complete MCP tool whitelist with its capability class (ARCHITECTURE §22, §39). The surface
 * itself encodes the boundary: there is no tool to accept/reject a proposal, write the domain
 * directly, run SQL, touch files/shell/migrations/policy, change Season / Good Life Conditions,
 * create or resolve a Capture, or write to the external calendar.
 * Every tool delegates to one application query/command; policy is enforced there too.
 */
export const MCP_TOOLS = {
  get_state_revision: "read",
  get_living_map_context: "read",
  get_history: "read",
  get_proposal: "read",
  list_captures: "read",
  search_memory: "read",
  create_route_proposal: "proposal",
  propose_desired_result_change: "proposal",
  reorder_existing_actions: "safe-write",
  save_memory: "safe-write",
} as const;
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as (keyof typeof MCP_TOOLS)[];

export type McpBackend = { status: "ready"; ai: AiSurface } | { status: "unavailable"; reason: string };

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

  // Tool handler path: MCP input → Zod (SDK, contract schema) → AI surface (actor fixed to `mcp-ai`,
  // fresh correlationId per write) → application (capability policy → domain → repository
  // transaction) → typed result.
  const run = (use: (ai: AiSurface) => Result<unknown>): CallToolResult => {
    const backend = resolveBackend();
    if (backend.status !== "ready") return toToolResult(err("SCHEMA_INCOMPATIBLE", backend.reason));
    const result = use(backend.ai);
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
    () => run((ai) => ai.getStateRevision()),
  );

  server.registerTool(
    "get_living_map_context",
    {
      description:
        "Read the user's whole current planning reality in one call: stateRevision, the one causal line of their life (strategy: sparse decade plan → next 3 years → this year; season = the Season's main goal), «Чем ты не хочешь жертвовать ради целей?» (hard constraints), the active projects (`projects`, up to three, each with its desired result, Stages, Actions with status/doneWhen/blockers, approved OrderedActionPlan and honest progress; `intention`/`stages`/`orderedActionPlan` mirror the focus project), unplanned actions, pending proposals, confirmed planning rules and recent history. `meanings` explains what every concept means to the user and what you may and may not change — read it first. Everything strategic here is read-only for you.",
      annotations: read,
    },
    () => run((ai) => ai.getPlanningContext()),
  );

  server.registerTool(
    "get_history",
    {
      description: "Meaningful changes, newest first (actor user-ui = the user, mcp-ai = an AI).",
      inputSchema: ListChangeHistoryInputSchema,
      annotations: read,
    },
    (input) => run((ai) => ai.listChangeHistory(input)),
  );

  server.registerTool(
    "get_proposal",
    {
      description:
        "Read one proposal and its current status (pending / accepted / rejected / stale). Use it to learn whether the user accepted your proposal.",
      inputSchema: GetProposalInputSchema,
      annotations: read,
    },
    (input) => run((ai) => ai.getProposal(input)),
  );

  server.registerTool(
    "create_route_proposal",
    {
      description:
        "Propose a route for the Intention: the first route or a replan. Can add Stages and Actions (with doneWhen), rename Stages, edit title/doneWhen of unfinished Actions, set the Stage sequence, and must give the full execution order (actionOrder) of every unfinished action. New entities get a `ref` you use elsewhere in the same call. Nothing is applied: the user reviews the exact resulting route in the LivingMap desktop app and confirms or rejects it. Cannot delete anything or change action statuses.",
      inputSchema: CreateRouteProposalInputSchema,
      annotations: write,
    },
    (input) => run((ai) => ai.createRouteProposal(input)),
  );

  server.registerTool(
    "propose_desired_result_change",
    {
      description:
        "Propose a new desired result (what must become true for the Intention to count as embodied). Applied only if the user confirms it in the desktop app.",
      inputSchema: ProposeDesiredResultChangeInputSchema,
      annotations: write,
    },
    (input) => run((ai) => ai.proposeDesiredResultChange(input)),
  );

  server.registerTool(
    "reorder_existing_actions",
    {
      description:
        "SAFE WRITE, applied immediately: reorder the unfinished actions of an ALREADY APPROVED route (orderedActionPlan must exist) and update the order's rationale. Must list exactly every unfinished action once. Cannot create, delete, rename, complete or unblock anything. Before the first route is approved, or once the user has set the order herself (REQUIRES_CONFIRMATION), use create_route_proposal with the new actionOrder instead — the user's own order is authoritative and only she confirms a replacement. Orders actions inside the user's Stages; the Stage order stays hers.",
      inputSchema: ReorderExistingActionsInputSchema,
      annotations: write,
    },
    (input) => run((ai) => ai.reorderExistingActions(input)),
  );

  server.registerTool(
    "list_captures",
    {
      description:
        "Recent raw inputs the user wrote into LivingMap's «+», newest first, exactly as typed, with processing state (pending / processing / processed / failed), the reply they got and memories saved from them.",
      inputSchema: ListCapturesInputSchema,
      annotations: read,
    },
    (input) => run((ai) => ai.listCaptures(input)),
  );

  server.registerTool(
    "search_memory",
    {
      description:
        "Search LivingMap's long-term memory: the user's earlier decisions, facts, observations, preferences/constraints, dated commitments and ideas. Case-insensitive word match; empty query = most recent. Use it before answering or planning.",
      inputSchema: SearchMemoryInputSchema,
      annotations: read,
    },
    (input) => run((ai) => ai.searchMemory(input)),
  );

  server.registerTool(
    "save_memory",
    {
      description:
        "SAFE WRITE, applied immediately: remember something the user said that matters later (decision, fact, observation, preference/constraint, dated commitment, idea, note). Link captureId when it comes from a «+» input. One memory of each type per capture: a second one of the same type for the same capture is a no-op. It never changes the route, the order, «Сейчас» or any setting — strategic changes still need a proposal.",
      inputSchema: SaveMemoryInputSchema,
      annotations: write,
    },
    (input) => run((ai) => ai.saveMemory(input)),
  );

  return server;
}
