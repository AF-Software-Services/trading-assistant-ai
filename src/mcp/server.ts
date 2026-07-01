import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.ts";
import type { Env } from "./tools.ts";

/**
 * Handle an incoming MCP request using the StreamableHTTP transport.
 * Creates a new stateless server instance per request — appropriate for
 * Cloudflare Workers which do not have long-lived in-memory state.
 */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = new McpServer({
    name: "trading-assistant-ai",
    version: "1.0.0",
  });

  registerTools(server, env);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const response = await transport.handleRequest(request);
  return response;
}
