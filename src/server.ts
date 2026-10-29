import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { registerMauticTools } from "./mautic-catalog.js";
import type { Runtime } from "./runtime.js";

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: CONNECTOR_NAME, version: CONNECTOR_VERSION });
  registerMauticTools(server, runtime);
  return server;
}
