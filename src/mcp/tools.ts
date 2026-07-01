import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// Re-export Env shape expected by tools
export interface Env {
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

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

export function registerTools(server: McpServer, env: Env): void {
  const provider = createMarketDataProvider({ provider: env.MARKET_DATA_PROVIDER });

  // ── 1. analyse_pair ─────────────────────────────────────────────────────────
  server.tool(
    "analyse_pair",
    "Run full analysis on a currency pair: market structure, S/R zones, trend, candlestick signals, and a trade recommendation.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("4H"),
    },
    async ({ pair, timeframe }) => {
      const tf = (timeframe ?? "4H") as Timeframe;
      const candles = await provider.getCandles(pair as CurrencyPair, tf, 200);
      const atr     = calculateATR(candles);
      const structure = analyseMarketStructure(candles, tf);
      const zones     = detectZones(candles, tf, atr);
      const trend     = analyseTrend(candles, structure);
      const signals   = detectAllSignals(candles, zones);
      const rec       = await generateRecommendation({ pair: pair as CurrencyPair, provider });

      return json({ pair, timeframe: tf, structure, zones, trend, signals: signals.slice(-5), recommendation: rec });
    }
  );

  // ── 2. analyse_all_pairs ────────────────────────────────────────────────────
  server.tool(
    "analyse_all_pairs",
    "Run full analysis on all 6 Phase 1 currency pairs and return recommendations.",
    {},
    async () => {
      const recs = await generateAllRecommendations(PHASE1_PAIRS, provider);
      return json({ recommendations: recs, count: recs.length, generatedAt: Date.now() });
    }
  );

  // ── 3. get_market_structure ──────────────────────────────────────────────────
  server.tool(
    "get_market_structure",
    "Get market structure (trend, swing points, HH/HL/LH/LL) for a pair and timeframe.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("4H"),
    },
    async ({ pair, timeframe }) => {
      const tf = (timeframe ?? "4H") as Timeframe;
      const candles   = await provider.getCandles(pair as CurrencyPair, tf, 200);
      const structure = analyseMarketStructure(candles, tf);
      return json(structure);
    }
  );

  // ── 4. get_support_resistance ────────────────────────────────────────────────
  server.tool(
    "get_support_resistance",
    "Get support and resistance zones for a pair and timeframe.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("D"),
    },
    async ({ pair, timeframe }) => {
      const tf = (timeframe ?? "D") as Timeframe;
      const candles = await provider.getCandles(pair as CurrencyPair, tf, 200);
      const atr     = calculateATR(candles);
      const zones   = detectZones(candles, tf, atr);
      return json({ pair, timeframe: tf, zones, count: zones.length });
    }
  );

  // ── 5. get_candlestick_signals ───────────────────────────────────────────────
  server.tool(
    "get_candlestick_signals",
    "Get recent candlestick signals (engulfing patterns) for a pair and timeframe.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("4H"),
    },
    async ({ pair, timeframe }) => {
      const tf = (timeframe ?? "4H") as Timeframe;
      const candles = await provider.getCandles(pair as CurrencyPair, tf, 100);
      const atr     = calculateATR(candles);
      const struct  = analyseMarketStructure(candles, tf);
      const zones   = detectZones(candles, tf, atr);
      const signals = detectAllSignals(candles, zones);
      return json({ pair, timeframe: tf, signals: signals.slice(-10), count: signals.length });
    }
  );

  // ── 6. get_patterns ──────────────────────────────────────────────────────────
  server.tool(
    "get_patterns",
    "Get chart patterns (double top/bottom, H&S) for a pair. Note: pattern detection is in v1 placeholder state — patterns will be available in v2.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
    },
    async ({ pair }) => {
      const candles  = await provider.getCandles(pair as CurrencyPair, "D", 100);
      const patterns = detectAllPatterns(candles);
      return json({
        pair,
        patterns,
        note: "Pattern detection is planned for v2. Currently returns empty array.",
      });
    }
  );

  // ── 7. get_trade_recommendations ─────────────────────────────────────────────
  server.tool(
    "get_trade_recommendations",
    "Get all current open trade recommendations stored in the database.",
    {},
    async () => {
      const recs = await getOpenRecommendations(env.DB);
      return json({ recommendations: recs, count: recs.length });
    }
  );

  // ── 8. explain_signal ────────────────────────────────────────────────────────
  server.tool(
    "explain_signal",
    "Get a human-readable explanation of a trade recommendation including full reasoning and invalidation conditions.",
    {
      recommendation_id: z.string().uuid(),
    },
    async ({ recommendation_id }) => {
      const rec = await getRecommendation(env.DB, recommendation_id);
      if (!rec) return text(`No recommendation found with id: ${recommendation_id}`);

      const lines = [
        `=== Trade Recommendation: ${rec.pair} ${rec.direction.toUpperCase()} ===`,
        `ID:         ${rec.id}`,
        `Setup:      ${rec.setupType}`,
        `Confidence: ${rec.confidence}/100`,
        `Action:     ${rec.action}`,
        `Status:     ${rec.status}`,
        ``,
        `Entry Zone: ${rec.entryZone.low.toFixed(5)} – ${rec.entryZone.high.toFixed(5)}`,
        `Stop Idea:  ${rec.stopIdea.toFixed(5)}`,
        `Target 1:   ${rec.target1.toFixed(5)}`,
        ...(rec.target2 ? [`Target 2:   ${rec.target2.toFixed(5)}`] : []),
        `R:R Ratio:  ${rec.rewardRiskRatio.toFixed(2)}`,
        `Risk:       £${rec.riskAmount.toFixed(2)}`,
        `Reward:     £${rec.rewardAmount.toFixed(2)}`,
        ``,
        `Score Breakdown:`,
        `  SR Strength:        ${rec.scoreBreakdown.srStrength}/20`,
        `  TF Importance:      ${rec.scoreBreakdown.timeframeImportance}/15`,
        `  Candlestick Signal: ${rec.scoreBreakdown.candlestickSignal}/20`,
        `  Market Structure:   ${rec.scoreBreakdown.marketStructure}/15`,
        `  Trend Alignment:    ${rec.scoreBreakdown.trendAlignment}/15`,
        `  Pattern:            ${rec.scoreBreakdown.patternConfirmation}/10`,
        `  R:R Potential:      ${rec.scoreBreakdown.rewardRiskPotential}/5`,
        `  TOTAL:              ${rec.scoreBreakdown.total}/100`,
        ``,
        `Reasons:`,
        ...rec.reasons.map(r => `  • ${r}`),
        ``,
        `Invalidation Conditions:`,
        ...rec.invalidationConditions.map(c => `  ✗ ${c}`),
        ``,
        `Created:  ${new Date(rec.createdAt).toISOString()}`,
        `Expires:  ${new Date(rec.expiresAt).toISOString()}`,
      ];
      return text(lines.join("\n"));
    }
  );

  // ── 9. get_open_recommendations ──────────────────────────────────────────────
  server.tool(
    "get_open_recommendations",
    "Get open recommendations with live management suggestions.",
    {},
    async () => {
      const recs        = await getOpenRecommendations(env.DB);
      const suggestions = await reviewAllOpen(recs, provider);
      return json({ recommendations: recs, managementSuggestions: suggestions });
    }
  );

  // ── 10. review_recommendation ────────────────────────────────────────────────
  server.tool(
    "review_recommendation",
    "Trigger a trade management review for a specific recommendation.",
    {
      recommendation_id: z.string().uuid(),
      notes: z.string().optional(),
    },
    async ({ recommendation_id, notes }) => {
      const rec = await getRecommendation(env.DB, recommendation_id);
      if (!rec) return text(`No recommendation found with id: ${recommendation_id}`);
      const suggestion = await reviewRecommendation(rec, provider);
      return json({ recommendation: rec, suggestion, notes });
    }
  );

  // ── 11. close_recommendation ─────────────────────────────────────────────────
  server.tool(
    "close_recommendation",
    "Mark a recommendation as closed with a given reason.",
    {
      recommendation_id: z.string().uuid(),
      reason: z.string(),
    },
    async ({ recommendation_id, reason }) => {
      const rec = await getRecommendation(env.DB, recommendation_id);
      if (!rec) return text(`No recommendation found with id: ${recommendation_id}`);
      await updateRecommendationStatus(env.DB, recommendation_id, "closed", reason);
      return text(`Recommendation ${recommendation_id} closed. Reason: ${reason}`);
    }
  );

  // ── 12. search_history ───────────────────────────────────────────────────────
  server.tool(
    "search_history",
    "Search historical recommendations with optional filters.",
    {
      pair:           z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]).optional(),
      direction:      z.enum(["buy", "sell", "neutral"]).optional(),
      min_confidence: z.number().min(0).max(100).optional(),
      limit:          z.number().min(1).max(200).optional().default(50),
    },
    async ({ pair, direction, min_confidence, limit }) => {
      let query = `SELECT * FROM recommendations WHERE 1=1`;
      const binds: (string | number)[] = [];
      if (pair)           { query += ` AND pair = ?`;       binds.push(pair); }
      if (direction)      { query += ` AND direction = ?`;  binds.push(direction); }
      if (min_confidence) { query += ` AND confidence >= ?`; binds.push(min_confidence); }
      query += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit ?? 50);

      const stmt = env.DB.prepare(query);
      const rows = await stmt.bind(...binds).all<Record<string, unknown>>();
      return json({ results: rows.results, count: rows.results.length });
    }
  );

  // ── 13. get_statistics ───────────────────────────────────────────────────────
  server.tool(
    "get_statistics",
    "Get overall strategy statistics and per-pair performance metrics.",
    {},
    async () => {
      const strategy = await getStrategyStats(env.DB);
      const pairStats = await Promise.all(
        PHASE1_PAIRS.map(p => getPairPerformance(env.DB, p))
      );
      return json({ strategy, pairs: pairStats });
    }
  );

  // ── 14. open_chart ───────────────────────────────────────────────────────────
  server.tool(
    "open_chart",
    "Return a URL to open the trading chart UI for a specific pair and timeframe, along with a brief analysis summary.",
    {
      pair:      z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]).optional().default("EUR/USD"),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("1H"),
    },
    async ({ pair, timeframe }) => {
      const p  = (pair      ?? "EUR/USD") as CurrencyPair;
      const tf = (timeframe ?? "1H")      as Timeframe;

      const encodedPair = encodeURIComponent(p);
      const chartUrl = `https://trading-assistant-ai.andrew-dobson.workers.dev/?pair=${encodedPair}&timeframe=${tf}`;

      // Run quick analysis
      const candles   = await provider.getCandles(p, "1H", 200);
      const atr       = calculateATR(candles);
      const structure = analyseMarketStructure(candles, tf);
      const zones     = detectZones(candles, tf, atr);
      const trend     = analyseTrend(candles, structure);
      const signals   = detectAllSignals(candles, zones);
      const lastSig   = signals[signals.length - 1];

      const trendLabel = trend.bias === "uptrend"   ? "▲ UPTREND"
                       : trend.bias === "downtrend" ? "▼ DOWNTREND"
                       :                              "◆ RANGE";

      const lines = [
        `Chart URL: ${chartUrl}`,
        ``,
        `=== ${p} — ${tf} Analysis ===`,
        `Trend:    ${trendLabel}`,
        `Zones:    ${zones.length} active (${zones.filter(z => z.type === "resistance").length} resistance, ${zones.filter(z => z.type === "support").length} support)`,
        lastSig ? `Last Signal: ${lastSig.type} ${lastSig.direction} (confidence: ${lastSig.confidence}%)` : `Last Signal: None detected`,
        ``,
        `Open the chart link above to view candlesticks, S/R zones, and set up a trade idea.`,
      ];

      return text(lines.join("\n"));
    }
  );

  // ── 15. run_scheduled_scan ───────────────────────────────────────────────────
  server.tool(
    "run_scheduled_scan",
    "Trigger a full scan of all currency pairs, generate recommendations, and persist results.",
    {},
    async () => {
      const start = Date.now();
      const recs  = await generateAllRecommendations(PHASE1_PAIRS, provider);

      // Persist recommendations
      for (const rec of recs) {
        await saveRecommendation(env.DB, rec);

        // Cache analysis
        const candles = await provider.getCandles(rec.pair, "4H", 200);
        const atr     = calculateATR(candles);
        const structure = analyseMarketStructure(candles, "4H");
        const zones     = detectZones(candles, "4H", atr);
        const trend     = analyseTrend(candles, structure);
        await setCachedAnalysis(env.KV, rec.pair, {
          pair: rec.pair, timeframe: "4H", structure, zones, trend, cachedAt: Date.now(),
        });

        // Save signals
        const signals = detectAllSignals(candles, zones);
        for (const sig of signals.slice(-3)) {
          await saveSignal(env.DB, sig);
        }

        // Save zones
        await saveZones(env.DB, zones);
      }

      const scanRun: ScanRun = {
        id: generateUUID(),
        sessionName: "manual_scan",
        pairsScanned: PHASE1_PAIRS,
        recommendationsGenerated: recs.length,
        createdAt: start,
        durationMs: Date.now() - start,
      };
      await saveScanRun(env.DB, scanRun);
      await setLastScanTime(env.KV, "manual_scan", start);

      return json({
        message: "Scan complete",
        pairsScanned: PHASE1_PAIRS.length,
        recommendationsGenerated: recs.length,
        durationMs: Date.now() - start,
        recommendations: recs,
      });
    }
  );
}
