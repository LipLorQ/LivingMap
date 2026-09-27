import type { Application } from "@living-map/application";
import { err, GetProbeInputSchema, RenameProbeInputSchema, type Result } from "@living-map/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The complete MCP tool whitelist (ARCHITECTURE §22, §39). Anything not listed does not exist:
 * no SQL, filesystem, shell, migration or policy tools.
 */
export const MCP_TOOL_NAMES = ["get_state_revision", "list_probes", "get_probe", "rename_probe"] as const;

export type McpBackend = { status: "ready"; app: Application } | { status: "unavailable"; reason: string };

const toToolResult = (result: Result<unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  isError: !result.ok,
});

export function createLivingMapMcpServer(resolveBackend: () => McpBackend, version: string): McpServer {
  const server = new McpServer({ name: "living-map", version });

  // Tool handler path: MCP input → Zod (SDK, contract schema) → capability policy → application → typed result.
  const run = (use: (app: Application) => Result<unknown>): CallToolResult => {
    const backend = resolveBackend();
    return toToolResult(backend.status === "ready" ? use(backend.app) : err("SCHEMA_INCOMPATIBLE", backend.reason));
  };

  server.registerTool(
    "get_state_revision",
    {
      description: "Global monotonically increasing revision of the Living Map state.",
      annotations: { readOnlyHint: true },
    },
    () => run((app) => app.queries.getStateRevision()),
  );

  server.registerTool(
    "list_probes",
    { description: "List technical spike probes.", annotations: { readOnlyHint: true } },
    () => run((app) => app.queries.listProbes()),
  );

  server.registerTool(
    "get_probe",
    {
      description: "Read one technical spike probe by id.",
      inputSchema: GetProbeInputSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => run((app) => app.queries.getProbe(input)),
  );

  server.registerTool(
    "rename_probe",
    {
      description:
        "Rename a probe. Requires the version you last read; returns CONFLICT_RELOAD if the probe changed since — re-read and reason again.",
      inputSchema: RenameProbeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run((app) => app.commands.renameProbe(app.newContext("mcp-ai", "mcp"), input)),
  );

  return server;
}
