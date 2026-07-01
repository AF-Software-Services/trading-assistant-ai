import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.ts";
import type { Env } from "./tools.ts";

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = new McpServer({
    name: "trading-assistant-ai",
    version: "1.0.0",
  });

  registerTools(server, env);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — required for Cloudflare Workers
  });

  await server.connect(transport);

  return transport.handleRequest(request);
}
