import { Hono } from "hono";
import {
  getBotSignal,
  getBotSignals,
  updateBotSignalStatus,
  executeSignal,
  runBotScan,
} from "./engine.ts";
import { monitorPositions } from "./monitor.ts";
import { TradingService }                from "../trading/service.ts";
import { getAccount, seedDefaultAccount } from "../ctrader/account-types.ts";
import {
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  seedBotsFromLegacyKV,
  BOT_TYPE_REGISTRY,
} from "./bot-types.ts";
import type { BotInstance, BotTypeId } from "./bot-types.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import type { CurrencyPair } from "../types/market.ts";
import { saveScanRun } from "../storage/d1.ts";
import type { ScanRun } from "../storage/d1.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  TWELVE_DATA_API_KEY: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
}

export function createBotRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // ── GET /api/v1/bot/types ─────────────────────────────────────────────────────
  app.get("/types", (c) => {
    return c.json(BOT_TYPE_REGISTRY);
  });

  // ── GET /api/v1/bot/bots ──────────────────────────────────────────────────────
  app.get("/bots", async (c) => {
    await seedBotsFromLegacyKV(c.env.DB, c.env.KV);
    const bots = await listBots(c.env.DB);
    return c.json(bots);
  });

  // ── POST /api/v1/bot/bots ─────────────────────────────────────────────────────
  app.post("/bots", async (c) => {
    const body = await c.req.json<{
      name?:      string;
      type?:      string;
      pairs?:     string[];
      accountId?: string | null;
    }>().catch(() => null);
    if (!body?.type) return c.json({ error: "type is required" }, 400);

    const typeDef = BOT_TYPE_REGISTRY.find(t => t.id === body.type);
    if (!typeDef) return c.json({ error: `Unknown bot type: ${body.type}` }, 400);

    const pairs = (body.pairs ?? []).filter(p =>
      PHASE1_PAIRS.includes(p as CurrencyPair)
    ) as CurrencyPair[];

    const bot = await createBot(c.env.DB, {
      id:        crypto.randomUUID(),
      name:      body.name ?? typeDef.displayName,
      type:      typeDef.id as BotTypeId,
      mode:      "off",
      pairs,
      accountId: body.accountId ?? null,
      settings:  { ...typeDef.defaultSettings },
    });

    return c.json(bot, 201);
  });

  // ── PUT /api/v1/bot/bots/:id ──────────────────────────────────────────────────
  app.put("/bots/:id", async (c) => {
    const id   = c.req.param("id");
    const body = await c.req.json<Partial<BotInstance>>().catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);

    if (body.mode && !["off", "approval", "autonomous"].includes(body.mode)) {
      return c.json({ error: "mode must be off | approval | autonomous" }, 400);
    }

    const updated = await updateBot(c.env.DB, id, {
      name:      body.name,
      mode:      body.mode,
      pairs:     body.pairs,
      settings:  body.settings,
      accountId: body.accountId,
    });

    if (!updated) return c.json({ error: "Bot not found" }, 404);
    return c.json(updated);
  });

  // ── DELETE /api/v1/bot/bots/:id ───────────────────────────────────────────────
  app.delete("/bots/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await deleteBot(c.env.DB, id);
    if (!ok) return c.json({ error: "Bot not found" }, 404);
    return c.json({ success: true, id });
  });

  // ── POST /api/v1/bot/bots/:id/scan ────────────────────────────────────────────
  app.post("/bots/:id/scan", async (c) => {
    const id  = c.req.param("id");
    const bot = await getBot(c.env.DB, id);
    if (!bot) return c.json({ error: "Bot not found" }, 404);

    try {
      const result = await runBotScan({
        DB:                    c.env.DB,
        KV:                    c.env.KV,
        MARKET_DATA_PROVIDER:  c.env.MARKET_DATA_PROVIDER,
        TWELVE_DATA_API_KEY:   c.env.TWELVE_DATA_API_KEY,
        CTRADER_CLIENT_ID:     c.env.CTRADER_CLIENT_ID,
        CTRADER_CLIENT_SECRET: c.env.CTRADER_CLIENT_SECRET,
        CTRADER_ACCOUNT_ID:    c.env.CTRADER_ACCOUNT_ID,
        botInstance:           bot,
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── GET /api/v1/bot/signals ───────────────────────────────────────────────────
  app.get("/signals", async (c) => {
    const status = c.req.query("status");
    const botId  = c.req.query("botId");
    const limit  = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const signals = await getBotSignals(c.env.DB, {
      status: status ?? undefined,
      botId:  botId  ?? undefined,
      limit,
    });
    return c.json({ signals, count: signals.length });
  });

  // ── POST /api/v1/bot/signals/:id/approve ─────────────────────────────────────
  app.post("/signals/:id/approve", async (c) => {
    const id     = c.req.param("id");
    const signal = await getBotSignal(c.env.DB, id);
    if (!signal) return c.json({ error: "Signal not found" }, 404);
    if (signal.status !== "pending") return c.json({ error: `Signal is ${signal.status}, not pending` }, 409);
    if (signal.expiresAt < Date.now()) {
      await updateBotSignalStatus(c.env.DB, id, "expired");
      return c.json({ error: "Signal has expired" }, 410);
    }

    // Use the signal's bot account if set, otherwise fall back to legacy global token
    let trading: TradingService;
    try {
      const bot         = await getBot(c.env.DB, signal.botId);
      const botAccount  = bot?.accountId ? await getAccount(c.env.DB, bot.accountId) : null;
      trading = botAccount
        ? await TradingService.connectToAccount(c.env, botAccount)
        : await TradingService.connect(c.env);
    } catch {
      return c.json({ error: "cTrader not connected" }, 401);
    }

    await updateBotSignalStatus(c.env.DB, id, "approved");

    try {
      await executeSignal(signal, c.env.DB, c.env.KV, trading);
      return c.json({ success: true, id });
    } catch (e) {
      await updateBotSignalStatus(c.env.DB, id, "failed", { errorMessage: (e as Error).message });
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── POST /api/v1/bot/signals/:id/reject ──────────────────────────────────────
  app.post("/signals/:id/reject", async (c) => {
    const id   = c.req.param("id");
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
    await updateBotSignalStatus(c.env.DB, id, "rejected", {
      rejectionReason: body.reason ?? "Manually rejected",
    });
    return c.json({ success: true, id });
  });

  // ── POST /api/v1/bot/scan ─────────────────────────────────────────────────────
  // Scan ALL active bots
  app.post("/scan", async (c) => {
    await seedBotsFromLegacyKV(c.env.DB, c.env.KV);
    const bots = await listBots(c.env.DB);
    const activeBots = bots.filter(b => b.mode !== "off");

    if (activeBots.length === 0) {
      return c.json({ error: "No active bots" });
    }

    const scanStart = Date.now();
    const results: Record<string, unknown> = {};
    let totalFound = 0, totalQueued = 0, totalExecuted = 0;
    let scanError: string | null = null;

    for (const bot of activeBots) {
      try {
        const r = await runBotScan({
          DB:                    c.env.DB,
          KV:                    c.env.KV,
          MARKET_DATA_PROVIDER:  c.env.MARKET_DATA_PROVIDER,
          TWELVE_DATA_API_KEY:   c.env.TWELVE_DATA_API_KEY,
          CTRADER_CLIENT_ID:     c.env.CTRADER_CLIENT_ID,
          CTRADER_CLIENT_SECRET: c.env.CTRADER_CLIENT_SECRET,
          CTRADER_ACCOUNT_ID:    c.env.CTRADER_ACCOUNT_ID,
          botInstance:           bot,
        });
        results[bot.id] = r;
        totalFound    += r.signalsFound    ?? 0;
        totalQueued   += r.signalsQueued   ?? 0;
        totalExecuted += r.signalsExecuted ?? 0;
      } catch (e) {
        const msg = (e as Error).message;
        results[bot.id] = { error: msg };
        scanError = scanError ? `${scanError}; ${msg}` : msg;
      }
    }

    await saveScanRun(c.env.DB, {
      id:                       crypto.randomUUID(),
      sessionName:              "manual_scan",
      pairsScanned:             PHASE1_PAIRS,
      recommendationsGenerated: 0,
      createdAt:                scanStart,
      durationMs:               Date.now() - scanStart,
      signalsFound:             totalFound,
      signalsQueued:            totalQueued,
      signalsExecuted:          totalExecuted,
      error:                    scanError,
    });

    return c.json(results);
  });

  // ── POST /api/v1/bot/monitor ──────────────────────────────────────────────────
  // Runs the same position-reconciliation pass as the cron job (detect closed
  // trades, record win/loss outcomes, trail stops) on demand. The cron only fires
  // hourly, so a trade that closes in between sits unrecorded in the Journal/
  // Dashboard until the next tick — the frontend calls this on page load so those
  // views reflect real trades as soon as possible instead of waiting on cron cadence.
  app.post("/monitor", async (c) => {
    try {
      await monitorPositions({
        DB:                    c.env.DB,
        KV:                    c.env.KV,
        CTRADER_CLIENT_ID:     c.env.CTRADER_CLIENT_ID,
        CTRADER_CLIENT_SECRET: c.env.CTRADER_CLIENT_SECRET,
        CTRADER_ACCOUNT_ID:    c.env.CTRADER_ACCOUNT_ID,
        MARKET_DATA_PROVIDER:  c.env.MARKET_DATA_PROVIDER,
        TWELVE_DATA_API_KEY:   c.env.TWELVE_DATA_API_KEY,
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── GET /api/v1/bot/cron-log ─────────────────────────────────────────────────
  app.get("/cron-log", async (c) => {
    const limit  = Math.min(Math.max(parseInt(c.req.query("limit")  ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const [{ results }, countRow] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, session_name, pairs_scanned, recommendations_generated, created_at, duration_ms,
                signals_found, signals_queued, signals_executed, error
         FROM scan_runs ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(limit, offset).all(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scan_runs`).first<{ count: number }>(),
    ]);

    return c.json({ results, total: countRow?.count ?? 0, limit, offset });
  });

  // ── GET /api/v1/bot/status ────────────────────────────────────────────────────
  app.get("/status", async (c) => {
    await seedBotsFromLegacyKV(c.env.DB, c.env.KV);
    await seedDefaultAccount(c.env.DB, c.env.KV, c.env.CTRADER_ACCOUNT_ID);
    const [bots, pending, recent] = await Promise.all([
      listBots(c.env.DB),
      getBotSignals(c.env.DB, { status: "pending", limit: 20 }),
      getBotSignals(c.env.DB, { limit: 10, source: "live" }),
    ]);
    const token = await c.env.KV.get("ctrader:access_token");
    return c.json({
      bots,
      connected:      !!token,
      pendingSignals: pending.length,
      recentSignals:  recent,
    });
  });

  return app;
}
