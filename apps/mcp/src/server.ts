import type { Application } from "@living-map/application";
import { err, type Result } from "@living-map/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The complete MCP tool whitelist (ARCHITECTURE §22, §39). This stage does not expose the real
 * product domain to MCP (this stage's prompt §2/§19 — that is Stage 3's job): only the technical
 * state_revision read remains, proving desktop and MCP still safely share one SQLite. No SQL,
 * filesystem, shell, migration, policy or product-domain tool exists here yet.
 */
export const MCP_TOOL_NAMES = ["get_state_revision"] as const;

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

  // Tool handler path: MCP input → Zod (SDK, contract schema) → capability policy → application → typed result.
  const run = (use: (app: Application) => Result<unknown>): CallToolResult => {
    const backend = resolveBackend();
    if (backend.status !== "ready") return toToolResult(err("SCHEMA_INCOMPATIBLE", backend.reason));
    const result = use(backend.app);
    // A per-write schema check (ADR-0003) just failed on a connection we thought was ready —
    // drop it instead of repeating the same stale error on every subsequent call.
    if (!result.ok && result.error.code === "SCHEMA_INCOMPATIBLE") invalidateBackend();
    return toToolResult(result);
  };

  server.registerTool(
    "get_state_revision",
    {
      description: "Global monotonically increasing revision of the Living Map state.",
      annotations: { readOnlyHint: true },
    },
    () => run((app) => app.queries.getStateRevision()),
  );

  return server;
}
