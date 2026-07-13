import { Hono } from "hono";
import type { CurrencyPair, Timeframe } from "../types/market.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { createMarketDataProvider } from "../providers/factory.ts";
import { analyseMarketStructure } from "../engines/market-structure.ts";
import { detectZones, getZoneAlerts } from "../engines/support-resistance.ts";
import { detectAllSignals } from "../engines/candlestick.ts";
import { detectAllPatterns } from "../engines/pattern.ts";
import { analyseTrend, calculateATR } from "../engines/trend.ts";
import { detectTrendlineOverlays } from "../engines/trendline.ts";
import { fetchNewsForPair } from "../providers/news.ts";
import type { PairNews } from "../providers/news.ts";
import {
  createJournalEntry,
  updateJournalOutcome,
  getJournalEntry,
  getJournalEntries,
  getJournalStats,
  buildFeaturesFromContext,
} from "../storage/journal.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  TWELVE_DATA_API_KEY: string;
}

export function createApiRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // GET /api/v1/pairs
  app.get("/pairs", (c) => {
    return c.json({ pairs: PHASE1_PAIRS });
  });

  // GET /api/v1/trendlines/:pair
  app.get("/trendlines/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);
    const tf: Timeframe = (c.req.query("timeframe") as Timeframe | undefined) ?? "4H";
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER, apiKey: c.env.TWELVE_DATA_API_KEY || undefined, kv: c.env.KV });
    const [candles, dailyCandles] = await Promise.all([
      provider.getCandles(pair, tf, 200),
      provider.getCandles(pair, "D", 100),
    ]);
    const result = detectTrendlineOverlays(candles, dailyCandles);
    return c.json({ pair, timeframe: tf, ...result });
  });

  // ── GET /api/v1/price/:pair ──────────────────────────────────────────────────
  app.get("/price/:pair", async (c) => {
    const pair = decodeURIComponent(c.req.param("pair")) as CurrencyPair;
    try {
      const p    = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER, apiKey: c.env.TWELVE_DATA_API_KEY || undefined, kv: c.env.KV });
      const tick = await p.getLatestPrice(pair);
      return c.json({ pair, mid: tick.mid, bid: tick.bid, ask: tick.ask });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── GET /api/v1/candles/:pair ────────────────────────────────────────────────
  // Proxies Twelve Data, caches in KV for 5 minutes.
  app.get("/candles/:pair", async (c) => {
    const pair      = decodeURIComponent(c.req.param("pair"));
    const timeframe = (c.req.query("timeframe") ?? "1H") as string;
    const count     = parseInt(c.req.query("count") ?? "200", 10);

    // Timeframe mapping
    const tfMap: Record<string, string> = { "1H": "1h", "4H": "4h", "D": "1day", "W": "1week" };
    const interval = tfMap[timeframe] ?? "1h";

    const cacheKey = `candles:${pair}:${timeframe}`;

    // Try KV cache first
    const cached = await c.env.KV.get(cacheKey, "json") as { candles: unknown[] } | null;
    if (cached) return c.json(cached);

    const apiKey = c.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return c.json({ error: "TWELVE_DATA_API_KEY not configured" }, 503);
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&outputsize=${count}&apikey=${apiKey}&format=JSON`;
    const resp = await fetch(url);
    if (!resp.ok) return c.json({ error: `Twelve Data HTTP ${resp.status} for ${pair}` }, 502);

    const raw = await resp.json() as {
      status?: string;
      code?: number;
      message?: string;
      values?: Array<{ datetime: string; open: string; high: string; low: string; close: string }>;
    };
    if (raw.status === "error" || raw.code) {
      return c.json({ error: `Twelve Data: ${raw.message ?? "unknown error"} (pair=${pair}, code=${raw.code})` }, 502);
    }

    const values = raw.values ?? [];
    // Twelve Data returns newest first — reverse to oldest-first
    const candles = values.slice().reverse().map(v => ({
      timestamp: new Date(v.datetime.includes("T") ? v.datetime : v.datetime + "Z").getTime(),
      open:  parseFloat(v.open),
      high:  parseFloat(v.high),
      low:   parseFloat(v.low),
      close: parseFloat(v.close),
    }));

    const result = { pair, timeframe, candles };
    // Cache for 5 minutes
    await c.env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
    return c.json(result);
  });

  // ── GET /api/v1/analysis/:pair ───────────────────────────────────────────────
  // Run all engines on 1H data, return trend/zones/signals/scores.
  app.get("/analysis/:pair", async (c) => {
    const pair = decodeURIComponent(c.req.param("pair")) as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);

    const tf = (c.req.query("timeframe") as Timeframe | undefined) ?? "4H";
    const accountBalance = c.req.query("accountBalance") ? parseFloat(c.req.query("accountBalance")!) : undefined;
    const riskPercent    = c.req.query("riskPercent")    ? parseFloat(c.req.query("riskPercent")!)    : undefined;
    const maxRisk        = accountBalance && riskPercent ? accountBalance * (riskPercent / 100) : undefined;
    const provider  = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER, apiKey: c.env.TWELVE_DATA_API_KEY || undefined, kv: c.env.KV });

    // Helper: read from the candles route's KV cache, falling back to Twelve Data.
    // This avoids double-billing the rate limit when the chart already fetched candles.
    const getCandlesCached = async (p: string, timeframe: string, count: number) => {
      const key = `candles:${p}:${timeframe}`;
      const hit = await c.env.KV.get(key, "json") as { candles: import("../types/market.ts").Candle[] } | null;
      if (hit) return hit.candles;
      const fresh = await provider.getCandles(p as import("../types/market.ts").CurrencyPair, timeframe as import("../types/market.ts").Timeframe, count);
      // Write back to the shared KV cache so the chart benefits too
      await c.env.KV.put(key, JSON.stringify({ pair: p, timeframe, candles: fresh }), { expirationTtl: 300 });
      return fresh;
    };

    let candles, candles4H, candlesD, candlesW, tick;
    try {
      candles   = await getCandlesCached(pair, tf, 200);
      candles4H = tf === "4H" ? candles : await getCandlesCached(pair, "4H", 200);
      candlesD  = await getCandlesCached(pair, "D", 100);
      candlesW  = await getCandlesCached(pair, "W",  52);
      tick      = await provider.getLatestPrice(pair);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Data fetch failed: ${msg}` }, 503);
    }
    const atr       = calculateATR(candles);
    const atr4H     = calculateATR(candles4H);
    const structure = analyseMarketStructure(candles, tf);
    const zones     = detectZones(candles, tf, atr);
    const trend      = analyseTrend(candles, structure);
    const signals    = detectAllSignals(candles, zones);
    const patterns   = detectAllPatterns(candles4H);
    const zoneAlerts = getZoneAlerts(tick.mid, zones, atr);

    // Higher-timeframe zones for TP targeting — swing trades aim at W/D levels
    const zonesD = detectZones(candlesD, "D", atr4H);
    const zonesW = detectZones(candlesW, "W", atr4H);
    const htfZones = [...zonesW, ...zonesD];

    // Derive buy/sell scores: buy = alignment with uptrend, sell = downtrend
    const trendBias = trend.bias;
    const recentSigs = signals.slice(-10);
    const bullishTypes = new Set(["bullish_engulfing", "hammer"]);
    const bullishCount = recentSigs.filter(s => bullishTypes.has(s.type)).length;
    const bearishCount = recentSigs.filter(s => !bullishTypes.has(s.type)).length;

    let buyScore  = trendBias === "uptrend"   ? 60 : trendBias === "range" ? 40 : 20;
    let sellScore = trendBias === "downtrend" ? 60 : trendBias === "range" ? 40 : 20;
    buyScore  = Math.min(100, buyScore  + bullishCount * 8);
    sellScore = Math.min(100, sellScore + bearishCount * 8);

    // Suggest stop distance: 1× ATR on 4H candles, expressed in pips
    const pipFactor = pair.includes("JPY") ? 100 : 10000;
    const suggestedStopPips = Math.round(atr4H * pipFactor);

    return c.json({
      pair,
      trend: trendBias,
      zones,
      htfZones,
      structure,
      signals: signals.slice(-10),
      buyScore,
      sellScore,
      patterns,
      atr: atr4H,
      suggestedStopPips,
      zoneAlerts,
    });
  });

  // ── POST /api/v1/journal ─────────────────────────────────────────────────────
  // Log a new manual trade entry with optional feature context for ML.
  app.post("/journal", async (c) => {
    const body = await c.req.json<{
      pair: string;
      direction: "buy" | "sell";
      timeframe?: string;
      entryPrice: number;
      stopLoss: number;
      target: number;
      confidence?: number;
      notes?: string;
      recommendationId?: string;
      features?: Record<string, unknown>;
    }>().catch(() => null);

    if (!body || !body.pair || !body.direction || !body.entryPrice || !body.stopLoss || !body.target) {
      return c.json({ error: "pair, direction, entryPrice, stopLoss, target required" }, 400);
    }

    const now = new Date();
    const features = buildFeaturesFromContext({
      ...(body.features ?? {}),
      candles4h: [],
      candlesD: [],
    });

    const id = await createJournalEntry(c.env.DB, {
      recommendationId: body.recommendationId ?? null,
      pair: body.pair as any,
      direction: body.direction,
      timeframe: body.timeframe ?? "4H",
      entryPrice: body.entryPrice,
      stopLoss: body.stopLoss,
      target: body.target,
      confidence: body.confidence ?? 0,
      session: features.session,
      dayOfWeek: now.getUTCDay(),
      features,
      notes: body.notes ?? null,
      createdAt: Date.now(),
    });

    return c.json({ id, createdAt: Date.now() }, 201);
  });

  // ── GET /api/v1/journal ──────────────────────────────────────────────────────
  app.get("/journal", async (c) => {
    const pair     = c.req.query("pair");
    const openOnly = c.req.query("open") === "1";
    const limit    = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const offset   = Number(c.req.query("offset") ?? "0");

    const entries = await getJournalEntries(c.env.DB, { pair, openOnly, limit, offset });
    return c.json({ entries, count: entries.length });
  });

  // ── GET /api/v1/journal/stats ─────────────────────────────────────────────────
  app.get("/journal/stats", async (c) => {
    const stats = await getJournalStats(c.env.DB);
    return c.json(stats);
  });

  // ── GET /api/v1/journal/:id ───────────────────────────────────────────────────
  app.get("/journal/:id", async (c) => {
    const entry = await getJournalEntry(c.env.DB, c.req.param("id"));
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json(entry);
  });

  // ── PATCH /api/v1/journal/:id/outcome ────────────────────────────────────────
  // Mark a trade as win/loss/breakeven with exit price.
  app.patch("/journal/:id/outcome", async (c) => {
    const body = await c.req.json<{
      result: "win" | "loss" | "breakeven";
      exitPrice: number;
      notes?: string;
    }>().catch(() => null);

    if (!body || !body.result || !body.exitPrice) {
      return c.json({ error: "result and exitPrice required" }, 400);
    }

    try {
      await updateJournalOutcome(c.env.DB, c.req.param("id"), body);
      const updated = await getJournalEntry(c.env.DB, c.req.param("id"));
      return c.json(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 404);
    }
  });

  // ── GET/PUT /api/v1/settings/risk ───────────────────────────────────────────
  // Persists risk settings so the MCP tools can read them without UI context.
  app.get("/settings/risk", async (c) => {
    const raw = await c.env.KV.get("user:risk_settings", "json") as
      { riskPercent?: number; rewardRisk?: number; accountBalance?: number } | null;
    // accountBalance used to be a manually-entered figure stored here; it's now always
    // read live from the connected cTrader account, so strip any stale leftover value.
    const { accountBalance: _stale, ...settings } = raw ?? {};
    return c.json(settings);
  });

  app.put("/settings/risk", async (c) => {
    const body = await c.req.json<{ riskPercent?: number; rewardRisk?: number }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    const existing = await c.env.KV.get("user:risk_settings", "json") as
      { riskPercent?: number; rewardRisk?: number; accountBalance?: number } | null ?? {};
    const { accountBalance: _stale, ...rest } = existing;
    const updated = { ...rest, ...body };
    await c.env.KV.put("user:risk_settings", JSON.stringify(updated));
    return c.json({ saved: true, settings: updated });
  });

  // ── GET /api/v1/news/:pair ───────────────────────────────────────────────────
  // Returns recent RSS headlines relevant to a currency pair, cached 1hr in KV.
  app.get("/news/:pair", async (c) => {
    const pair = decodeURIComponent(c.req.param("pair"));
    if (!PHASE1_PAIRS.includes(pair as any)) return c.json({ error: "Unknown pair" }, 400);
    try {
      const news = await fetchNewsForPair(pair, c.env.KV);
      return c.json(news);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `News fetch failed: ${msg}` }, 503);
    }
  });

  // ── GET /chart → redirect to index (assets fallback) ────────────────────────
  app.get("/chart", (c) => {
    return c.redirect("/");
  });

  return app;
}
