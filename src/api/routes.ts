import { Hono } from "hono";
import type { CurrencyPair, Timeframe } from "../types/market.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { createMarketDataProvider } from "../providers/factory.ts";
import { analyseMarketStructure } from "../engines/market-structure.ts";
import { detectZones } from "../engines/support-resistance.ts";
import { detectAllSignals } from "../engines/candlestick.ts";
import { detectAllPatterns } from "../engines/pattern.ts";
import { analyseTrend, calculateATR } from "../engines/trend.ts";
import { generateRecommendation, generateAllRecommendations } from "../engines/recommendation.ts";
import { reviewRecommendation, reviewAllOpen } from "../engines/trade-management.ts";
import { getStrategyStats, getPairPerformance } from "../engines/analytics.ts";
import {
  getOpenRecommendations,
  getRecommendation,
  updateRecommendationStatus,
  saveRecommendation,
  saveSignal,
  saveScanRun,
  saveZones,
} from "../storage/d1.ts";
import { setCachedAnalysis, setLastScanTime } from "../storage/kv.ts";
import type { ScanRun } from "../storage/d1.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function createApiRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // GET /api/v1/pairs
  app.get("/pairs", (c) => {
    return c.json({ pairs: PHASE1_PAIRS });
  });

  // POST /api/v1/analyse/:pair
  app.post("/analyse/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) {
      return c.json({ error: `Unknown pair: ${pair}` }, 400);
    }
    const body = await c.req.json<{ timeframe?: Timeframe }>().catch(() => ({}));
    const tf: Timeframe = body.timeframe ?? "4H";
    const provider  = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const candles   = await provider.getCandles(pair, tf, 200);
    const atr       = calculateATR(candles);
    const structure = analyseMarketStructure(candles, tf);
    const zones     = detectZones(candles, tf, atr);
    const trend     = analyseTrend(candles, structure);
    const signals   = detectAllSignals(candles, zones);
    const rec       = await generateRecommendation({ pair, provider });
    return c.json({ pair, timeframe: tf, structure, zones, trend, signals: signals.slice(-5), recommendation: rec });
  });

  // POST /api/v1/analyse  (all pairs)
  app.post("/analyse", async (c) => {
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const recs = await generateAllRecommendations(PHASE1_PAIRS, provider);
    return c.json({ recommendations: recs, count: recs.length, generatedAt: Date.now() });
  });

  // GET /api/v1/structure/:pair
  app.get("/structure/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);
    const tf: Timeframe = (c.req.query("timeframe") as Timeframe | undefined) ?? "4H";
    const provider  = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const candles   = await provider.getCandles(pair, tf, 200);
    const structure = analyseMarketStructure(candles, tf);
    return c.json(structure);
  });

  // GET /api/v1/zones/:pair
  app.get("/zones/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);
    const tf: Timeframe = (c.req.query("timeframe") as Timeframe | undefined) ?? "D";
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const candles  = await provider.getCandles(pair, tf, 200);
    const atr      = calculateATR(candles);
    const zones    = detectZones(candles, tf, atr);
    return c.json({ pair, timeframe: tf, zones, count: zones.length });
  });

  // GET /api/v1/signals/:pair
  app.get("/signals/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);
    const tf: Timeframe = (c.req.query("timeframe") as Timeframe | undefined) ?? "4H";
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const candles  = await provider.getCandles(pair, tf, 100);
    const atr      = calculateATR(candles);
    const zones    = detectZones(candles, tf, atr);
    const signals  = detectAllSignals(candles, zones);
    return c.json({ pair, timeframe: tf, signals: signals.slice(-10), count: signals.length });
  });

  // GET /api/v1/patterns/:pair
  app.get("/patterns/:pair", async (c) => {
    const pair = c.req.param("pair") as CurrencyPair;
    if (!PHASE1_PAIRS.includes(pair)) return c.json({ error: "Unknown pair" }, 400);
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const candles  = await provider.getCandles(pair, "D", 100);
    const patterns = detectAllPatterns(candles);
    return c.json({ pair, patterns, note: "Pattern detection planned for v2." });
  });

  // GET /api/v1/recommendations
  app.get("/recommendations", async (c) => {
    const recs = await getOpenRecommendations(c.env.DB);
    return c.json({ recommendations: recs, count: recs.length });
  });

  // GET /api/v1/recommendations/:id
  app.get("/recommendations/:id", async (c) => {
    const rec = await getRecommendation(c.env.DB, c.req.param("id"));
    if (!rec) return c.json({ error: "Not found" }, 404);
    return c.json(rec);
  });

  // GET /api/v1/recommendations/:id/explain
  app.get("/recommendations/:id/explain", async (c) => {
    const rec = await getRecommendation(c.env.DB, c.req.param("id"));
    if (!rec) return c.json({ error: "Not found" }, 404);
    return c.json({
      id: rec.id,
      pair: rec.pair,
      direction: rec.direction,
      confidence: rec.confidence,
      action: rec.action,
      status: rec.status,
      setupType: rec.setupType,
      entryZone: rec.entryZone,
      stopIdea: rec.stopIdea,
      target1: rec.target1,
      target2: rec.target2,
      rewardRiskRatio: rec.rewardRiskRatio,
      riskAmount: rec.riskAmount,
      rewardAmount: rec.rewardAmount,
      scoreBreakdown: rec.scoreBreakdown,
      reasons: rec.reasons,
      invalidationConditions: rec.invalidationConditions,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
    });
  });

  // POST /api/v1/recommendations/:id/review
  app.post("/recommendations/:id/review", async (c) => {
    const rec = await getRecommendation(c.env.DB, c.req.param("id"));
    if (!rec) return c.json({ error: "Not found" }, 404);
    const provider   = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const suggestion = await reviewRecommendation(rec, provider);
    return c.json({ recommendation: rec, suggestion });
  });

  // POST /api/v1/recommendations/:id/close
  app.post("/recommendations/:id/close", async (c) => {
    const rec = await getRecommendation(c.env.DB, c.req.param("id"));
    if (!rec) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{ reason: string }>().catch(() => ({ reason: "Manual close" }));
    await updateRecommendationStatus(c.env.DB, c.req.param("id"), "closed", body.reason);
    return c.json({ success: true, id: c.req.param("id"), reason: body.reason });
  });

  // GET /api/v1/history
  app.get("/history", async (c) => {
    const pair      = c.req.query("pair");
    const direction = c.req.query("direction");
    const minConf   = c.req.query("min_confidence");
    const limit     = parseInt(c.req.query("limit") ?? "50", 10);

    let query = `SELECT * FROM recommendations WHERE 1=1`;
    const binds: (string | number)[] = [];
    if (pair)      { query += ` AND pair = ?`;        binds.push(pair); }
    if (direction) { query += ` AND direction = ?`;   binds.push(direction); }
    if (minConf)   { query += ` AND confidence >= ?`; binds.push(parseInt(minConf, 10)); }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    binds.push(limit);

    const rows = await c.env.DB.prepare(query).bind(...binds).all<Record<string, unknown>>();
    return c.json({ results: rows.results, count: rows.results.length });
  });

  // GET /api/v1/statistics
  app.get("/statistics", async (c) => {
    const strategy  = await getStrategyStats(c.env.DB);
    const pairStats = await Promise.all(PHASE1_PAIRS.map(p => getPairPerformance(c.env.DB, p)));
    return c.json({ strategy, pairs: pairStats });
  });

  // POST /api/v1/scan
  app.post("/scan", async (c) => {
    const start    = Date.now();
    const provider = createMarketDataProvider({ provider: c.env.MARKET_DATA_PROVIDER });
    const recs     = await generateAllRecommendations(PHASE1_PAIRS, provider);

    for (const rec of recs) {
      await saveRecommendation(c.env.DB, rec);
      const candles = await provider.getCandles(rec.pair, "4H", 200);
      const atr     = calculateATR(candles);
      const structure = analyseMarketStructure(candles, "4H");
      const zones     = detectZones(candles, "4H", atr);
      const trend     = analyseTrend(candles, structure);
      await setCachedAnalysis(c.env.KV, rec.pair, {
        pair: rec.pair, timeframe: "4H", structure, zones, trend, cachedAt: Date.now(),
      });
      const signals = detectAllSignals(candles, zones);
      for (const sig of signals.slice(-3)) await saveSignal(c.env.DB, sig);
      await saveZones(c.env.DB, zones);
    }

    const scanRun: ScanRun = {
      id: generateUUID(),
      sessionName: "api_scan",
      pairsScanned: PHASE1_PAIRS,
      recommendationsGenerated: recs.length,
      createdAt: start,
      durationMs: Date.now() - start,
    };
    await saveScanRun(c.env.DB, scanRun);
    await setLastScanTime(c.env.KV, "api_scan", start);

    return c.json({
      message: "Scan complete",
      pairsScanned: PHASE1_PAIRS.length,
      recommendationsGenerated: recs.length,
      durationMs: Date.now() - start,
      recommendations: recs,
    });
  });

  return app;
}
