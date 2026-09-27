// MCP composition root (ARCHITECTURE §9): config/path → SQLite connection → repositories
// → application services → MCP tools. Launched by an MCP host over stdio; never listens on a port.
// stdout belongs to the MCP protocol — diagnostics go to stderr only.
import { createApplication } from "@living-map/application";
import {
  createSqliteStore,
  databaseFile,
  openMcpDatabase,
  resolveDataHome,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLivingMapMcpServer, type McpBackend } from "./server";

const VERSION = "0.0.0-spike";
const file = databaseFile(resolveDataHome());

let ready: { backend: McpBackend; handle: SqliteHandle } | undefined;

/**
 * Opens lazily and retries on every call until the database is usable, so an MCP host that
 * started before the desktop app (no DB yet / migration in progress) recovers without a restart.
 * MCP itself never creates or migrates the database (ARCHITECTURE §16).
 */
function resolveBackend(): McpBackend {
  if (ready) return ready.backend;
  const opened = openMcpDatabase(file);
  if (opened.status === "ready") {
    const app = createApplication({
      store: createSqliteStore(opened.handle, uuidGenerator),
      clock: systemClock,
      ids: uuidGenerator,
      reportError: (operation, error) =>
        console.error(`[living-map-mcp] ${operation} failed: ${error instanceof Error ? error.name : "unknown"}`),
    });
    ready = { backend: { status: "ready", app }, handle: opened.handle };
    return ready.backend;
  }
  if (opened.status === "incompatible") opened.handle.close();
  const reason =
    opened.status === "missing"
      ? "Living Map database not found. Open the Living Map desktop app first."
      : `Database schema v${opened.schema.current} is not supported (expected v${opened.schema.expected}). Open/update the Living Map desktop app first.`;
  console.error(`[living-map-mcp] ${reason}`);
  return { status: "unavailable", reason };
}

const server = createLivingMapMcpServer(resolveBackend, VERSION);
const transport = new StdioServerTransport();

function shutdown(): void {
  ready?.handle.close();
  process.exit(0);
}
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
