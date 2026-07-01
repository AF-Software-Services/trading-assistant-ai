import { Hono } from "hono";
import { handleMcpRequest } from "./mcp/server.ts";
import { createApiRouter } from "./api/routes.ts";
import { handleCronTrigger } from "./scheduler/cron.ts";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
}

const app = new Hono<{ Bindings: Env }>();

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (c) => {
  return c.json({
    name: "Trading Assistant AI",
    version: "1.0.0",
    status: "ok",
    environment: c.env.ENVIRONMENT,
    provider: c.env.MARKET_DATA_PROVIDER,
    timestamp: Date.now(),
  });
});

// ── MCP server endpoints ──────────────────────────────────────────────────────
// Accepts both GET (for SSE/discovery) and POST (for tool calls)
app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw, c.env);
});

// ── REST API ──────────────────────────────────────────────────────────────────
const apiRouter = createApiRouter();
app.route("/api/v1", apiRouter);

// ── Cloudflare Worker export ──────────────────────────────────────────────────
export default {
  // HTTP fetch handler
  fetch: app.fetch,

  // Cron scheduled handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCronTrigger(event, env, ctx);
  },
} satisfies ExportedHandler<Env>;
