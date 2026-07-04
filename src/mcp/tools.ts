import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CurrencyPair, Timeframe } from "../types/market.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { createMarketDataProvider } from "../providers/factory.ts";
import { analyseMarketStructure } from "../engines/market-structure.ts";
import { detectZones, getZoneAlerts, markBrokenByPrice, detectReactionLevels, detectAreaOfInterest } from "../engines/support-resistance.ts";
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
import { fetchNewsForPair } from "../providers/news.ts";

// Re-export Env shape expected by tools
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  TWELVE_DATA_API_KEY: string;
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
  const provider = createMarketDataProvider({ provider: env.MARKET_DATA_PROVIDER, apiKey: env.TWELVE_DATA_API_KEY || undefined, kv: env.KV });

  // ── 1. analyse_pair ─────────────────────────────────────────────────────────
  server.tool(
    "analyse_pair",
    "Run full multi-timeframe analysis on a currency pair following the methodology: W→D→4H top-down, AOI gate, entry signals on D/4H/2H. Risk settings (accountBalance, riskPercent, rewardRisk) are automatically read from the user's saved Trading Assistant settings stored in KV — you do NOT need to pass them unless overriding. The tool always uses the user's real account size and risk % from their Trading Assistant app.",
    {
      pair:           z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe:      z.enum(["1H", "2H", "4H", "D", "W"]).optional().default("4H"),
      accountBalance: z.number().positive().optional().describe("Override only — normally read from saved settings"),
      riskPercent:    z.number().min(0.1).max(10).optional().describe("Override only — normally read from saved settings"),
      rewardRisk:     z.number().min(1).max(10).optional().describe("Override only — normally read from saved settings"),
    },
    async ({ pair, timeframe, accountBalance, riskPercent, rewardRisk }) => {
      const tf  = (timeframe ?? "4H") as Timeframe;

      // Load saved risk settings from KV; fall back to defaults if not set
      const savedSettings = await env.KV.get("user:risk_settings", "json") as
        { accountBalance?: number; riskPercent?: number; rewardRisk?: number } | null;
      const resolvedBalance = accountBalance ?? savedSettings?.accountBalance;
      const resolvedRiskPct = riskPercent    ?? savedSettings?.riskPercent;
      const rrRatio         = rewardRisk     ?? savedSettings?.rewardRisk ?? 1.2;

      // Fetch W, D, 4H, 2H in parallel — plus tick
      const [candles4H, candlesD, candlesW, tick] = await Promise.all([
        provider.getCandles(pair as CurrencyPair, "4H", 200),
        provider.getCandles(pair as CurrencyPair, "D",  100),
        provider.getCandles(pair as CurrencyPair, "W",   52),
        provider.getLatestPrice(pair as CurrencyPair),
      ]);
      // 2H fetched separately (may not always be needed — reuse 4H if tf=4H)
      const candles2H = (tf === "2H")
        ? await provider.getCandles(pair as CurrencyPair, "2H", 200)
        : await provider.getCandles(pair as CurrencyPair, "2H", 100);

      const candles = tf === "4H" ? candles4H : tf === "D" ? candlesD
        : tf === "W" ? candlesW : tf === "2H" ? candles2H
        : await provider.getCandles(pair as CurrencyPair, tf, 200);

      const atr     = calculateATR(candles4H);
      const zonesW  = markBrokenByPrice(detectZones(candlesW,  "W",  atr), tick.mid, atr);
      const aoi     = detectAreaOfInterest(candlesW, atr);

      // AOI hard gate: price must be inside (or approaching within 1.5 ATR) the AOI
      // to progress to entry signals. Report status clearly.
      const priceInAOI      = aoi && tick.mid >= aoi.low && tick.mid <= aoi.high;
      const priceNearAOI    = aoi && !priceInAOI &&
        Math.abs(tick.mid - (aoi.bias === "bullish" ? aoi.low : aoi.high)) <= atr * 1.5;
      const aoiGatePassed   = priceInAOI || priceNearAOI;

      const structure = analyseMarketStructure(candles, tf);
      const zones     = markBrokenByPrice(detectZones(candles, tf, atr), tick.mid, atr);
      const trend     = analyseTrend(candles, structure);
      const alerts    = getZoneAlerts(tick.mid, zones, atr);

      // ── Multi-timeframe entry signal detection ──────────────────────────────
      // Check D, 4H, 2H separately. Each confirmed closed candle on its own TF
      // is valid. Multiple TFs confirming = stronger signal.
      const makeFormingCandle = (candleSet: typeof candles4H, tfLabel: Timeframe) => {
        const last = candleSet[candleSet.length - 1]!;
        return { timestamp: Date.now(), open: last.close,
          high: Math.max(last.close, tick.mid), low: Math.min(last.close, tick.mid),
          close: tick.mid, timeframe: tfLabel, pair: pair as CurrencyPair };
      };

      const signalsD  = detectAllSignals([...candlesD,  makeFormingCandle(candlesD,  "D")].slice(-22), zones);
      const signals4H = detectAllSignals([...candles4H, makeFormingCandle(candles4H, "4H")].slice(-22), zones);
      const signals2H = detectAllSignals([...candles2H, makeFormingCandle(candles2H, "2H")].slice(-22), zones);

      // Combine all signals, tag with which TFs confirmed
      const allSignalMap = new Map<string, { signal: typeof signalsD[0]; timeframes: Timeframe[] }>();
      const ENTRY_TYPES = new Set(["bullish_engulfing","bearish_engulfing","morning_star","evening_star","shooting_star","hammer"]);

      for (const [sig, tfLabel] of [
        ...signalsD.map(s => [s, "D"] as const),
        ...signals4H.map(s => [s, "4H"] as const),
        ...signals2H.map(s => [s, "2H"] as const),
      ]) {
        if (!ENTRY_TYPES.has(sig.type)) continue;
        // Group signals of same type within 2 ATR of each other as one multi-TF confirmation
        const key = `${sig.type}:${Math.round(sig.price / (atr * 2))}`;
        const existing = allSignalMap.get(key);
        if (existing) {
          if (!existing.timeframes.includes(tfLabel)) existing.timeframes.push(tfLabel);
          if (sig.confidence > existing.signal.confidence) existing.signal = sig;
        } else {
          allSignalMap.set(key, { signal: sig, timeframes: [tfLabel] });
        }
      }

      // Build confirmed entry signals with multi-TF bonus
      const entrySignals = [...allSignalMap.values()].map(({ signal, timeframes }) => {
        const tfBonus = (timeframes.length - 1) * 8; // +8% per additional TF
        return {
          ...signal,
          confidence: Math.min(100, signal.confidence + tfBonus),
          confirmedOn: timeframes.sort(),
          multiTfConfirmed: timeframes.length > 1,
          strength: timeframes.length >= 3 ? "strong" : timeframes.length === 2 ? "moderate" : "single-tf",
        };
      }).sort((a, b) => b.confidence - a.confidence);

      // Most recent valid entry signal
      const latestEntry = entrySignals[entrySignals.length - 1] ?? null;

      // AOI gate status message
      const aoiStatus = !aoi
        ? "NO AOI — weekly structure lacks 3+ confluent zones. Analysis-only mode."
        : priceInAOI
          ? `INSIDE AOI (${aoi.low.toFixed(5)}–${aoi.high.toFixed(5)}) — entry signals valid`
          : priceNearAOI
            ? `APPROACHING AOI (${aoi.low.toFixed(5)}–${aoi.high.toFixed(5)}) — within 1.5×ATR, prepare`
            : `OUTSIDE AOI (${aoi.low.toFixed(5)}–${aoi.high.toFixed(5)}) — wait for price to enter before acting on signals`;

      // Data freshness
      const lastClosed = candles[candles.length - 1]!;
      const tfMs: Record<string, number> = { "1H": 3600000, "2H": 7200000, "4H": 14400000, "D": 86400000, "W": 604800000 };
      const candleAgeHours = +((Date.now() - lastClosed.timestamp) / 3600000).toFixed(1);
      const expectedMaxAgeHours = (tfMs[tf] ?? 86400000) * 2 / 3600000;
      const isStale = candleAgeHours > expectedMaxAgeHours;
      const dataFreshness = {
        lastClosedCandle: new Date(lastClosed.timestamp).toISOString(),
        lastClosedCandleAgeHours: candleAgeHours,
        currentPrice: tick.mid, analysedAt: new Date().toISOString(), isStale,
        warning: isStale ? `Last closed ${tf} candle is ${candleAgeHours}h old.` : null,
      };

      const riskAmount = resolvedBalance && resolvedRiskPct ? resolvedBalance * (resolvedRiskPct / 100) : undefined;
      const recs = await generateRecommendation({
        pair: pair as CurrencyPair, provider,
        candles4H, candlesD, candlesW, livePrice: tick.mid,
        accountSize: resolvedBalance, maxRisk: riskAmount, rrRatio,
      });

      const patterns4H = detectAllPatterns(candles4H, pair, "4H");
      const patternsD  = detectAllPatterns(candlesD,  pair, "D");
      const patterns   = [...patterns4H, ...patternsD];
      const reactionLevels = detectReactionLevels(candles, atr, 10);

      return json({
        pair, timeframe: tf, dataFreshness,
        aoi, aoiStatus, aoiGatePassed,
        structure, zones, zonesW, reactionLevels,
        trend, patterns,
        entrySignals,           // multi-TF confirmed signals
        signals: entrySignals,  // backward-compat alias
        zoneAlerts: alerts,
        recommendations: recs,
        rewardRiskRatio: rrRatio,
        riskSettings: {
          accountBalance: resolvedBalance ?? null,
          riskPercent:    resolvedRiskPct ?? null,
          maxRiskAmount:  riskAmount ?? null,
          rewardRisk:     rrRatio,
          source: (accountBalance || riskPercent) ? "override" : savedSettings ? "saved" : "default",
          warning: !resolvedBalance || !resolvedRiskPct
            ? "⚠️ NO RISK SETTINGS SAVED — position sizing and R:R calculations are using defaults. Tell the user to open the Trading Assistant UI and check their ⚙ Risk settings, or call set_risk_settings to save them now."
            : null,
        },
      });
    }
  );

  // ── 2. get_risk_settings ─────────────────────────────────────────────────────
  server.tool(
    "get_risk_settings",
    "Read the user's saved risk settings from their Trading Assistant app: account balance, risk per trade %, and minimum R:R ratio. Call this if you need to know the user's current settings without running a full analysis.",
    {},
    async () => {
      const settings = await env.KV.get("user:risk_settings", "json") as
        { accountBalance?: number; riskPercent?: number; rewardRisk?: number } | null;
      if (!settings) {
        return json({
          configured: false,
          message: "No risk settings saved yet. The user can set these in the ⚙ Risk dropdown in the Trading Assistant UI.",
          defaults: { accountBalance: null, riskPercent: null, rewardRisk: 1.2 },
        });
      }
      const maxRisk = settings.accountBalance && settings.riskPercent
        ? settings.accountBalance * (settings.riskPercent / 100) : null;
      return json({
        configured: true,
        accountBalance: settings.accountBalance ?? null,
        riskPercent:    settings.riskPercent    ?? null,
        rewardRisk:     settings.rewardRisk      ?? 1.2,
        maxRiskPerTrade: maxRisk,
        summary: maxRisk
          ? `Account £${settings.accountBalance?.toLocaleString()}, risking ${settings.riskPercent}% (£${maxRisk.toFixed(2)}) per trade, min R:R ${settings.rewardRisk ?? 1.2}`
          : "Settings partially configured — accountBalance or riskPercent missing.",
      });
    }
  );

  // ── 3. set_risk_settings ─────────────────────────────────────────────────────
  server.tool(
    "set_risk_settings",
    "Save the user's risk settings so they are automatically applied to all future analyses. Only saves fields that are provided — omit a field to leave it unchanged.",
    {
      accountBalance: z.number().positive().optional().describe("Total account size in £"),
      riskPercent:    z.number().min(0.1).max(10).optional().describe("Risk per trade as % of account"),
      rewardRisk:     z.number().min(1).max(10).optional().describe("Minimum R:R ratio (default 1.2)"),
    },
    async ({ accountBalance, riskPercent, rewardRisk }) => {
      const existing = await env.KV.get("user:risk_settings", "json") as
        { accountBalance?: number; riskPercent?: number; rewardRisk?: number } | null ?? {};
      const updated = {
        ...existing,
        ...(accountBalance !== undefined && { accountBalance }),
        ...(riskPercent    !== undefined && { riskPercent }),
        ...(rewardRisk     !== undefined && { rewardRisk }),
      };
      await env.KV.put("user:risk_settings", JSON.stringify(updated));
      const maxRisk = updated.accountBalance && updated.riskPercent
        ? updated.accountBalance * (updated.riskPercent / 100) : null;
      return json({
        saved: true,
        settings: updated,
        maxRiskPerTrade: maxRisk,
        summary: maxRisk
          ? `Saved: Account £${updated.accountBalance?.toLocaleString()}, ${updated.riskPercent}% risk = £${maxRisk.toFixed(2)} per trade, R:R ${updated.rewardRisk ?? 1.2}`
          : "Saved (partial — provide both accountBalance and riskPercent to enable position sizing).",
      });
    }
  );

  // ── 4. analyse_all_pairs ─────────────────────────────────────────────────────
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
    "Get recent candlestick signals (engulfing patterns, hammers) for a pair and timeframe. Returns signals from the last 20 candles only, including any signal on the current forming candle.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("4H"),
    },
    async ({ pair, timeframe }) => {
      const tf = (timeframe ?? "4H") as Timeframe;
      const [candles, tick] = await Promise.all([
        provider.getCandles(pair as CurrencyPair, tf, 100),
        provider.getLatestPrice(pair as CurrencyPair),
      ]);
      const atr   = calculateATR(candles);
      const zones = markBrokenByPrice(detectZones(candles, tf, atr), tick.mid, atr);

      // Append forming candle so the current incomplete bar is included
      const lastClosed = candles[candles.length - 1]!;
      const forming = {
        timestamp: Date.now(),
        open:  lastClosed.close,
        high:  Math.max(lastClosed.close, tick.mid),
        low:   Math.min(lastClosed.close, tick.mid),
        close: tick.mid,
        timeframe: tf,
        pair: pair as CurrencyPair,
      };
      const candlesWithForming = [...candles, forming];

      // Only look at last 20 candles so June signals don't dominate
      const recentSlice = candlesWithForming.slice(-22); // +2 for context
      const signals = detectAllSignals(recentSlice, zones);

      return json({
        pair,
        timeframe: tf,
        currentPrice: tick.mid,
        signals,
        count: signals.length,
      });
    }
  );

  // ── 6. get_patterns ──────────────────────────────────────────────────────────
  server.tool(
    "get_patterns",
    "Detect chart patterns (Head & Shoulders, Inverse H&S) for a pair across 4H and Daily timeframes. Returns pattern type, status (forming/confirmed), neckline, confidence, and price target.",
    {
      pair: z.enum(["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"]),
    },
    async ({ pair }) => {
      const [candles4H, candlesD] = await Promise.all([
        provider.getCandles(pair as CurrencyPair, "4H", 200),
        provider.getCandles(pair as CurrencyPair, "D",  100),
      ]);
      const patterns4H = detectAllPatterns(candles4H, pair, "4H");
      const patternsD  = detectAllPatterns(candlesD,  pair, "D");
      const patterns   = [...patterns4H, ...patternsD];
      return json({ pair, patterns, count: patterns.length });
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
        `Score Breakdown (${rec.scoreBreakdown.tradeClass}):`,
        `  HTF Alignment:      ${rec.scoreBreakdown.htfAlignment}/30`,
        `  Discount/Premium:   ${rec.scoreBreakdown.discountPremium}/25`,
        `  Trigger Signal:     ${rec.scoreBreakdown.triggerSignal}/20`,
        `  Structure Intact:   ${rec.scoreBreakdown.structureIntact}/15`,
        `  R:R Quality:        ${rec.scoreBreakdown.rrQuality}/10`,
        `  TOTAL:              ${rec.scoreBreakdown.total}/100`,
        ...(rec.scoreBreakdown.blockers.length > 0 ? [`  Blockers: ${rec.scoreBreakdown.blockers.join("; ")}`] : []),
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
        lastSig ? `Last Signal: ${lastSig.type} (confidence: ${lastSig.confidence}%)` : `Last Signal: None detected`,
        ``,
        `Open the chart link above to view candlesticks, S/R zones, and set up a trade idea.`,
      ];

      return text(lines.join("\n"));
    }
  );

  // ── 15. get_news ─────────────────────────────────────────────────────────────
  server.tool(
    "get_news",
    "Get recent news headlines and sentiment for a currency pair, pulled from DailyFX and ForexLive RSS feeds. Cached 1 hour. Use this to provide fundamental context alongside technical analysis — upcoming central bank decisions, economic data releases, and macro themes affecting the pair.",
    {
      pair: z.enum(PHASE1_PAIRS as [CurrencyPair, ...CurrencyPair[]]).describe("Currency pair"),
    },
    async ({ pair }) => {
      const news = await fetchNewsForPair(pair, env.KV);
      const sentimentLine = `Overall news sentiment for ${pair}: ${news.sentiment.overall.toUpperCase()} (${news.sentiment.bullish} bullish, ${news.sentiment.bearish} bearish, ${news.sentiment.neutral} neutral across ${news.items.length} headlines).`;
      const headlines = news.items.map((item, i) => {
        const ago = item.pubDate
          ? (() => {
              const ms = Date.now() - new Date(item.pubDate).getTime();
              const h = Math.floor(ms / 3_600_000);
              const d = Math.floor(h / 24);
              return d > 0 ? `${d}d ago` : h > 0 ? `${h}h ago` : "< 1h ago";
            })()
          : "";
        return `${i + 1}. [${item.sentiment.toUpperCase()}] ${item.title} (${item.source}${ago ? `, ${ago}` : ""})`;
      }).join("\n");
      return json({
        pair,
        sentimentSummary: sentimentLine,
        sentiment: news.sentiment,
        headlines: news.items.map(i => ({
          title: i.title,
          source: i.source,
          pubDate: i.pubDate,
          sentiment: i.sentiment,
          link: i.link,
          description: i.description,
        })),
        formattedHeadlines: headlines,
        cachedAt: news.cachedAt,
        note: "News is cached for 1 hour. Sentiment is derived from keywords in headlines — treat as a rough directional guide, not a precise score.",
      });
    }
  );

  // ── 16. run_scheduled_scan ───────────────────────────────────────────────────
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
