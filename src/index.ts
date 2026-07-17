import { Hono } from "hono";
import { handleMcpRequest } from "./mcp/server.ts";
import { createApiRouter } from "./api/routes.ts";
import { createCTraderRouter } from "./ctrader/routes.ts";
import { createBotRouter }     from "./bot/routes.ts";
import { handleCronTrigger } from "./scheduler/cron.ts";
import { createBacktestRouter } from "./backtest/routes.ts";
import { createDashboardRouter } from "./dashboard/routes.ts";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
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

// ── cTrader integration ───────────────────────────────────────────────────────
const cTraderRouter = createCTraderRouter();
app.route("/", cTraderRouter);

// ── Bot ───────────────────────────────────────────────────────────────────────
const botRouter = createBotRouter();
app.route("/api/v1/bot", botRouter);

// ── Backtest ──────────────────────────────────────────────────────────────────
const backtestRouter = createBacktestRouter();
app.route("/", backtestRouter);

// ── Dashboard ─────────────────────────────────────────────────────────────────
const dashboardRouter = createDashboardRouter();
app.route("/", dashboardRouter);

// ── Cloudflare Worker export ──────────────────────────────────────────────────
export default {
  // HTTP fetch handler
  fetch: app.fetch,

  // Cron scheduled handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCronTrigger(event, env, ctx);
  },
} satisfies ExportedHandler<Env>;
