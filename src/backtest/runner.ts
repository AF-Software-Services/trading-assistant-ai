import type { Candle, CurrencyPair, Timeframe } from "../types/market.ts";
import { calculateATR } from "../engines/trend.ts";
import { calcLots } from "../bot/engine.ts";
import type { BotSignal } from "../bot/engine.ts";
import { detectTrendlineSignal, getTradingSession } from "../engines/trendline.ts";
import type { TrendlineTunables, TpMode, TradingSession } from "../engines/trendline.ts";
import { detectStructureSignal } from "../engines/structure-signal.ts";
import type { StructureTunables } from "../engines/structure-signal.ts";
import type { TradingService } from "../trading/service.ts";
import { pipFactor, PIP_VALUE_GBP } from "../engines/pip-value.ts";


export interface BacktestConfig {
  pairs: string[];
  fromMs: number;
  toMs: number;
  accountBalance: number;
  riskPercent: number;
  rewardRisk: number;
  minScore: number;
  maxOpenPositions:    number;
  allowDuplicatePairs: boolean;
  swingLookback:       number;
  tunables:             Partial<TrendlineTunables>;
  tpMode:               TpMode;
  requireCandleConfirmation: boolean;
  allowedSessions:      Record<TradingSession, boolean>;
}

export interface StructureBacktestConfig {
  pairs: string[];
  fromMs: number;
  toMs: number;
  accountBalance: number;
  riskPercent: number;
  rewardRisk: number;
  minScore: number;
  minConfluence:       number;
  maxOpenPositions:    number;
  allowDuplicatePairs: boolean;
  tunables:             Partial<StructureTunables>;
  tpMode:               TpMode;
  allowedSessions:      Record<TradingSession, boolean>;
}

// ProtoOATrendbarPeriod values for the timeframes the backtester/prefetch route need.
const CTRADER_PERIOD: Record<"4H" | "D" | "W", number> = { "4H": 10, "D": 12, "W": 13 };

// 14000 is cTrader's hard per-request cap — for 4H/D1/W1 that's years of history, always
// more than enough to cover a backtest window plus its lookback padding in one request.
const MAX_TRENDBARS = 14000;

async function fetchCandlesFromCTrader(
  pair: string,
  timeframe: "4H" | "D" | "W",
  toMs: number,
  trading: TradingService,
): Promise<Candle[]> {
  const symbolId = await trading.resolveSymbolId(pair);
  const bars = await trading.getTrendbars(symbolId, CTRADER_PERIOD[timeframe], MAX_TRENDBARS, toMs);
  return bars.map(b => ({
    timestamp: b.timestamp,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
    timeframe: timeframe as Timeframe,
    pair: pair as CurrencyPair,
  }));
}

// Cache key excludes date range — one cache entry covers all backtest periods, refreshed
// daily. "_v3" because this is a different data source/shape than the old Twelve Data
// cache — reusing the old key would silently mix candle shapes from two different feeds.
export function trendbarCacheKey(pair: string, timeframe: "4H" | "D" | "W"): string {
  return `candles_v3:${pair}:${timeframe}`;
}

export async function fetchCandles(
  pair: string,
  timeframe: "4H" | "D" | "W",
  toMs: number,
  trading: TradingService,
  kv?: KVNamespace,
): Promise<{ candles: Candle[]; fromCache: boolean }> {
  const cacheKey = trendbarCacheKey(pair, timeframe);

  if (kv) {
    const cached = await kv.get(cacheKey, "json") as Candle[] | null;
    if (cached && cached.length > 0) return { candles: cached, fromCache: true };
  }

  const candles = await fetchCandlesFromCTrader(pair, timeframe, toMs, trading);

  if (kv && candles.length > 0) {
    await kv.put(cacheKey, JSON.stringify(candles), { expirationTtl: 86400 });
  }

  return { candles, fromCache: false };
}

interface SafetyLineParams {
  anchorPrice: number;  // p1Price of the safety line
  anchorIndex: number;  // p1Index of the safety line (absolute bar index at detection time)
  slope:       number;  // price per bar
  entryBarIndex: number; // the bar index within the history at entry
}

function determineOutcome(
  trade: {
    pair: string;
    direction: "buy" | "sell";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    safetyLine?: SafetyLineParams; // trendline bot passes this; structure bot does not
  },
  forwardCandles: Candle[],
): { outcome: "tp" | "sl" | "expired"; closePrice: number; closeTime: number; pnlPips: number } {
  const { direction, entryPrice, takeProfit } = trade;
  const pf = pipFactor(trade.pair);

  for (let i = 0; i < Math.min(forwardCandles.length, 200); i++) {
    const c = forwardCandles[i]!;

    // Dynamic SL: if safety line params provided, project the line forward bar by bar.
    // The safety line naturally trails — ascending support rises each bar for a buy,
    // descending resistance falls each bar for a sell.
    // If no safety line, use the fixed initial stop loss.
    let currentSL = trade.stopLoss;
    if (trade.safetyLine) {
      const sl = trade.safetyLine;
      // Bar index of this forward candle = entry bar + 1 + i
      const barIndex = sl.entryBarIndex + 1 + i;
      currentSL = sl.anchorPrice + sl.slope * (barIndex - sl.anchorIndex);
      // SL can only move in trade's favour — clamp against initial stop
      if (direction === "buy"  && currentSL < trade.stopLoss) currentSL = trade.stopLoss;
      if (direction === "sell" && currentSL > trade.stopLoss) currentSL = trade.stopLoss;
    }

    if (direction === "buy") {
      if (c.close <= currentSL) {
        return { outcome: "sl", closePrice: currentSL, closeTime: c.timestamp, pnlPips: (currentSL - entryPrice) * pf };
      }
      if (c.high >= takeProfit) {
        return { outcome: "tp", closePrice: takeProfit, closeTime: c.timestamp, pnlPips: (takeProfit - entryPrice) * pf };
      }
    } else {
      if (c.close >= currentSL) {
        return { outcome: "sl", closePrice: currentSL, closeTime: c.timestamp, pnlPips: (entryPrice - currentSL) * pf };
      }
      if (c.low <= takeProfit) {
        return { outcome: "tp", closePrice: takeProfit, closeTime: c.timestamp, pnlPips: (entryPrice - takeProfit) * pf };
      }
    }
  }

  const last = forwardCandles[Math.min(199, forwardCandles.length - 1)];
  const lastPrice = last?.close ?? entryPrice;
  const expiredPips = direction === "buy"
    ? (lastPrice - entryPrice) * pf
    : (entryPrice - lastPrice) * pf;
  return { outcome: "expired", closePrice: lastPrice, closeTime: last?.timestamp ?? 0, pnlPips: expiredPips };
}

export interface BacktestResult {
  signals: BotSignal[];
  diagnostics: Record<string, number>;
  log: string[];
}

export async function runTrendlineBacktest(
  config: BacktestConfig,
  trading: TradingService,
  onProgress?: (msg: string) => void,
  kv?: KVNamespace,
): Promise<BacktestResult> {
  const allSignals: BotSignal[] = [];
  const rejections: Record<string, number> = {};
  const log: string[] = [];
  const progress = (msg: string) => { log.push(msg); onProgress?.(msg); };

  // Shared across all pairs — mirrors live bot constraints exactly.
  // openPositions tracks concurrent trades; lastSignalMs enforces the 4H cooldown per pair.
  const openPositions: Array<{ pair: string; closeTime: number }> = [];
  const lastSignalMs: Record<string, number> = {};
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  // Mirrors runBotScan's per-line blacklist: a loss on this exact trendline (same pair +
  // type + anchor timestamps) blocks re-entry on it for 24h, distinct from the pair-wide
  // cooldown above.
  const lineBlacklist: Array<{ pair: string; lineType: string; p1Ts: number; p2Ts: number; until: number }> = [];
  const LINE_BLACKLIST_MS = 24 * 60 * 60 * 1000;

  // Fetch every pair's candles in parallel rather than one-at-a-time — the account's
  // per-minute rate limit has real headroom now, so there's no need to pace requests out.
  progress(`Fetching data for ${config.pairs.length} pairs…`);
  const fetchResults = await Promise.all(config.pairs.map(async (pair) => {
    try {
      const [r4H, rD] = await Promise.all([
        fetchCandles(pair, "4H", config.toMs, trading, kv),
        fetchCandles(pair, "D",  config.toMs, trading, kv),
      ]);
      return { pair, candles4H: r4H.candles, candlesD: rD.candles, error: null as string | null };
    } catch (err) {
      return { pair, candles4H: [] as Candle[], candlesD: [] as Candle[], error: (err as Error).message };
    }
  }));

  for (const { pair, candles4H, candlesD, error } of fetchResults) {
    if (error) {
      progress(`Error fetching ${pair}: ${error}`);
      continue;
    }

    progress(`${pair}: 4H=${candles4H.length} D=${candlesD.length} candles`);

    const riskAmount = config.accountBalance * (config.riskPercent / 100);
    const pipVal     = PIP_VALUE_GBP[pair] ?? 7.50;

    const MIN_LOOKBACK = 80;

    // Precompute start/end indices in the full candles4H array — avoids filter() inside the loop
    let periodStart = candles4H.findIndex(c => c.timestamp >= config.fromMs);
    if (periodStart === -1) { progress(`${pair}: no candles in test period`); continue; }
    let periodEnd = candles4H.length;
    for (let k = periodStart; k < candles4H.length; k++) {
      if (candles4H[k]!.timestamp > config.toMs) { periodEnd = k; break; }
    }
    const inPeriodCount = periodEnd - periodStart;
    progress(`${pair}: ${inPeriodCount} 4H candles in test period`);

    for (let i = 0; i < inPeriodCount; i++) {
      // Yield every 20 bars to avoid CPU watchdog
      if (i % 20 === 0 && i > 0) await new Promise(r => setTimeout(r, 0));

      const absIdx = periodStart + i; // absolute index into candles4H

      // History: slice the last 200 bars up to and including this bar — O(1), no filter
      const histStart = Math.max(0, absIdx - 199);
      const history   = candles4H.slice(histStart, absIdx + 1);

      // Daily history: walk backward from end to find bars up to current timestamp
      const cutoff = candles4H[absIdx]!.timestamp;
      let dEnd = candlesD.length;
      for (let k = candlesD.length - 1; k >= 0; k--) {
        if (candlesD[k]!.timestamp <= cutoff) { dEnd = k + 1; break; }
      }
      const dHistory = candlesD.slice(Math.max(0, dEnd - 30), dEnd);

      if (history.length < MIN_LOOKBACK) {
        rejections["insufficient_data"] = (rejections["insufficient_data"] ?? 0) + 1;
        continue;
      }

      // ── Live-bot constraints (must match runBotScan exactly) ──────────────
      // Expire closed positions before checking capacity
      for (let j = openPositions.length - 1; j >= 0; j--) {
        if (openPositions[j]!.closeTime <= cutoff) openPositions.splice(j, 1);
      }
      // No second position on the same pair (unless bot allows it)
      if (!config.allowDuplicatePairs && openPositions.some(p => p.pair === pair)) {
        rejections["position_open"] = (rejections["position_open"] ?? 0) + 1;
        continue;
      }
      // Max concurrent positions across all pairs (from bot settings)
      if (openPositions.length >= config.maxOpenPositions) {
        rejections["max_positions"] = (rejections["max_positions"] ?? 0) + 1;
        continue;
      }
      // 4-hour cooldown per pair (matches live bot's KV cooldown key)
      if (cutoff - (lastSignalMs[pair] ?? 0) < FOUR_HOURS_MS) {
        rejections["cooldown"] = (rejections["cooldown"] ?? 0) + 1;
        continue;
      }

      const sig = detectTrendlineSignal(history, config.rewardRisk, config.swingLookback, dHistory, config.tunables, config.tpMode, config.requireCandleConfirmation);
      if (!sig) {
        // Secondary pass without daily bias — distinguishes "no pattern" from "bias filtered"
        const sigNoBias = detectTrendlineSignal(history, config.rewardRisk, config.swingLookback, undefined, config.tunables, config.tpMode, config.requireCandleConfirmation);
        if (sigNoBias) {
          rejections["daily_bias_filter"] = (rejections["daily_bias_filter"] ?? 0) + 1;
        } else {
          rejections["no_signal"] = (rejections["no_signal"] ?? 0) + 1;
        }
        continue;
      }

      if (sig.score < config.minScore) {
        rejections["score_too_low"] = (rejections["score_too_low"] ?? 0) + 1;
        continue;
      }

      const retestHourUtc = new Date(history[sig.retestIndex]!.timestamp).getUTCHours();
      if (!config.allowedSessions[getTradingSession(retestHourUtc)]) {
        rejections["session_filter"] = (rejections["session_filter"] ?? 0) + 1;
        continue;
      }

      const lineType = sig.actionLine.type;
      const lineP1Ts = history[sig.actionLine.p1Index]!.timestamp;
      const lineP2Ts = history[sig.actionLine.p2Index]!.timestamp;
      if (lineBlacklist.some(b => b.pair === pair && b.lineType === lineType && b.p1Ts === lineP1Ts && b.p2Ts === lineP2Ts && cutoff < b.until)) {
        rejections["line_blacklisted"] = (rejections["line_blacklisted"] ?? 0) + 1;
        continue;
      }

      const lots = calcLots(riskAmount, pair, sig.entryPrice, sig.stopLoss);
      if (lots <= 0) continue;

      // Forward candles: everything after this bar — slice, no filter
      const forwardCandles = candles4H.slice(absIdx + 1);
      // Anchor the safety line projection at the entry (retest) bar so the
      // projected SL starts at safetyAtEntry and drifts at the line's slope from there.
      const safetyLineParams = {
        anchorPrice:   sig.safetyAtEntry,   // level of the safety line at entry
        anchorIndex:   sig.retestIndex,     // entry bar is the anchor
        slope:         sig.safetyLine.slope,
        entryBarIndex: sig.retestIndex,
      };
      const outcomeResult  = determineOutcome(
        { pair, direction: sig.direction, entryPrice: sig.entryPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, safetyLine: safetyLineParams },
        forwardCandles,
      );

      // Register position and cooldown — mirrors what runBotScan writes to KV
      openPositions.push({ pair, closeTime: outcomeResult.closeTime });
      lastSignalMs[pair] = cutoff;

      // Blacklist this exact line for 24h if it just lost — mirrors runBotScan/monitor.ts
      if (outcomeResult.outcome === "sl") {
        lineBlacklist.push({ pair, lineType, p1Ts: lineP1Ts, p2Ts: lineP2Ts, until: outcomeResult.closeTime + LINE_BLACKLIST_MS });
      }

      const pnlGbp = outcomeResult.pnlPips * lots * pipVal;

      const signal: BotSignal = {
        id:               crypto.randomUUID(),
        botId:            "backtest-trendline",
        pair:             pair as CurrencyPair,
        direction:        sig.direction,
        entryPrice:       sig.entryPrice,
        stopLoss:         sig.stopLoss,
        takeProfit:       sig.takeProfit,
        lots,
        score:            sig.score,
        recommendationId: null,
        reasons:          sig.reasons,
        status:           "executed",
        createdAt:        cutoff,
        expiresAt:        cutoff + 4 * 60 * 60 * 1000,
        executedAt:       cutoff,
        ctraderPositionId: null,
        journalId:        null,
        rejectionReason:  null,
        errorMessage:     null,
        source:           "backtest",
        backtestRunId:    null, // set by routes.ts
        signalType:       "trendline_break_retest",
        signalTimeframe:  "4H",
        signalConfidence: sig.score,
        trend:            sig.direction === "buy" ? "bullish" : "bearish",
        structure:        null,
        mtfBias:          null,
        mtfLabel:         null,
        atr:              null,
        inAoi:            false,
        fibLabel:         null,
        tradeClass:       "trendline",
        zoneType:         null,
        patternType:      null,
        outcome:          outcomeResult.outcome,
        closePrice:       +outcomeResult.closePrice.toFixed(5),
        closeTime:        outcomeResult.closeTime,
        pnlPips:          +outcomeResult.pnlPips.toFixed(1),
        pnlGbp:           +pnlGbp.toFixed(2),
        lineType,
        lineP1Ts,
        lineP2Ts,
        zoneLow: null,
        zoneHigh: null,
      };

      allSignals.push(signal);
    }

    const pairCount = allSignals.filter(s => s.pair === pair).length;
    progress(`${pair}: ${pairCount} trendline signals`);
  }

  return { signals: allSignals, diagnostics: rejections, log };
}

export async function runStructureBacktest(
  config: StructureBacktestConfig,
  trading: TradingService,
  onProgress?: (msg: string) => void,
  kv?: KVNamespace,
): Promise<BacktestResult> {
  const allSignals: BotSignal[] = [];
  const rejections: Record<string, number> = {};
  const log: string[] = [];
  const progress = (msg: string) => { log.push(msg); onProgress?.(msg); };

  // Shared across all pairs — mirrors runTrendlineBacktest's live-bot-matching constraints.
  const openPositions: Array<{ pair: string; closeTime: number }> = [];
  const lastSignalMs: Record<string, number> = {};
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  progress(`Fetching data for ${config.pairs.length} pairs…`);
  const fetchResults = await Promise.all(config.pairs.map(async (pair) => {
    try {
      const [rW, rD, r4H] = await Promise.all([
        fetchCandles(pair, "W",  config.toMs, trading, kv),
        fetchCandles(pair, "D",  config.toMs, trading, kv),
        fetchCandles(pair, "4H", config.toMs, trading, kv),
      ]);
      return { pair, candlesW: rW.candles, candlesD: rD.candles, candles4H: r4H.candles, error: null as string | null };
    } catch (err) {
      return { pair, candlesW: [] as Candle[], candlesD: [] as Candle[], candles4H: [] as Candle[], error: (err as Error).message };
    }
  }));

  for (const { pair, candlesW, candlesD, candles4H, error } of fetchResults) {
    if (error) {
      progress(`Error fetching ${pair}: ${error}`);
      continue;
    }

    progress(`${pair}: W=${candlesW.length} D=${candlesD.length} 4H=${candles4H.length} candles`);

    const riskAmount = config.accountBalance * (config.riskPercent / 100);
    const pipVal     = PIP_VALUE_GBP[pair] ?? 7.50;

    const MIN_LOOKBACK = 50;

    let periodStart = candles4H.findIndex(c => c.timestamp >= config.fromMs);
    if (periodStart === -1) { progress(`${pair}: no candles in test period`); continue; }
    let periodEnd = candles4H.length;
    for (let k = periodStart; k < candles4H.length; k++) {
      if (candles4H[k]!.timestamp > config.toMs) { periodEnd = k; break; }
    }
    const inPeriodCount = periodEnd - periodStart;
    progress(`${pair}: ${inPeriodCount} 4H candles in test period`);

    for (let i = 0; i < inPeriodCount; i++) {
      if (i % 20 === 0 && i > 0) await new Promise(r => setTimeout(r, 0));

      const absIdx = periodStart + i;
      const history = candles4H.slice(Math.max(0, absIdx - 199), absIdx + 1);
      if (history.length < MIN_LOOKBACK) {
        rejections["insufficient_data"] = (rejections["insufficient_data"] ?? 0) + 1;
        continue;
      }

      const cutoff = candles4H[absIdx]!.timestamp;

      // Daily/weekly history: walk backward to find bars up to this bar's timestamp —
      // mirrors runTrendlineBacktest's dHistory windowing.
      let dEnd = candlesD.length;
      for (let k = candlesD.length - 1; k >= 0; k--) {
        if (candlesD[k]!.timestamp <= cutoff) { dEnd = k + 1; break; }
      }
      const dHistory = candlesD.slice(Math.max(0, dEnd - 90), dEnd);

      let wEnd = candlesW.length;
      for (let k = candlesW.length - 1; k >= 0; k--) {
        if (candlesW[k]!.timestamp <= cutoff) { wEnd = k + 1; break; }
      }
      const wHistory = candlesW.slice(Math.max(0, wEnd - 60), wEnd);

      // ── Live-bot constraints (must match runBotScan exactly) ──────────────
      for (let j = openPositions.length - 1; j >= 0; j--) {
        if (openPositions[j]!.closeTime <= cutoff) openPositions.splice(j, 1);
      }
      if (!config.allowDuplicatePairs && openPositions.some(p => p.pair === pair)) {
        rejections["position_open"] = (rejections["position_open"] ?? 0) + 1;
        continue;
      }
      if (openPositions.length >= config.maxOpenPositions) {
        rejections["max_positions"] = (rejections["max_positions"] ?? 0) + 1;
        continue;
      }
      if (cutoff - (lastSignalMs[pair] ?? 0) < FOUR_HOURS_MS) {
        rejections["cooldown"] = (rejections["cooldown"] ?? 0) + 1;
        continue;
      }

      const sig = detectStructureSignal(wHistory, dHistory, history, config.rewardRisk, config.minConfluence, config.tunables, config.tpMode);
      if (!sig) {
        rejections["no_signal"] = (rejections["no_signal"] ?? 0) + 1;
        continue;
      }

      if (sig.score < config.minScore) {
        rejections["score_too_low"] = (rejections["score_too_low"] ?? 0) + 1;
        continue;
      }

      const confirmedHourUtc = new Date(sig.confirmedAt).getUTCHours();
      if (!config.allowedSessions[getTradingSession(confirmedHourUtc)]) {
        rejections["session_filter"] = (rejections["session_filter"] ?? 0) + 1;
        continue;
      }

      const lots = calcLots(riskAmount, pair, sig.entryPrice, sig.stopLoss);
      if (lots <= 0) continue;

      const forwardCandles = candles4H.slice(absIdx + 1);
      const outcomeResult = determineOutcome(
        { pair, direction: sig.direction, entryPrice: sig.entryPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit },
        forwardCandles,
      );

      openPositions.push({ pair, closeTime: outcomeResult.closeTime });
      lastSignalMs[pair] = cutoff;

      const pnlGbp = outcomeResult.pnlPips * lots * pipVal;

      const signal: BotSignal = {
        id:               crypto.randomUUID(),
        botId:            "backtest-structure",
        pair:             pair as CurrencyPair,
        direction:        sig.direction,
        entryPrice:       sig.entryPrice,
        stopLoss:         sig.stopLoss,
        takeProfit:       sig.takeProfit,
        lots,
        score:            sig.score,
        recommendationId: null,
        reasons:          sig.reasons,
        status:           "executed",
        createdAt:        cutoff,
        expiresAt:        cutoff + 4 * 60 * 60 * 1000,
        executedAt:       cutoff,
        ctraderPositionId: null,
        journalId:        null,
        rejectionReason:  null,
        errorMessage:     null,
        source:           "backtest",
        backtestRunId:    null, // set by routes.ts
        signalType:       "structure_zone_bounce",
        signalTimeframe:  "4H",
        signalConfidence: sig.score,
        trend:            sig.direction === "buy" ? "bullish" : "bearish",
        structure:        null,
        mtfBias:          null,
        mtfLabel:         null,
        atr:              null,
        inAoi:            true,
        fibLabel:         null,
        tradeClass:       "structure",
        zoneType:         sig.zoneType,
        patternType:      sig.patternType,
        outcome:          outcomeResult.outcome,
        closePrice:       +outcomeResult.closePrice.toFixed(5),
        closeTime:        outcomeResult.closeTime,
        pnlPips:          +outcomeResult.pnlPips.toFixed(1),
        pnlGbp:           +pnlGbp.toFixed(2),
        lineType:         null,
        lineP1Ts:         null,
        lineP2Ts:         null,
        zoneLow:          sig.zoneLow,
        zoneHigh:         sig.zoneHigh,
      };

      allSignals.push(signal);
    }

    const pairCount = allSignals.filter(s => s.pair === pair).length;
    progress(`${pair}: ${pairCount} structure signals`);
  }

  return { signals: allSignals, diagnostics: rejections, log };
}

export function buildSummary(
  signals:     BotSignal[],
  diagnostics: Record<string, number> = {},
  log:         string[] = [],
) {
  const executed  = signals.filter(s => s.status === 'executed');
  const completed = executed.filter(s => s.outcome !== null);
  const rejected  = signals.filter(s => s.status === 'rejected').length;
  const wins      = completed.filter(s => s.outcome === "tp").length;
  const losses    = completed.filter(s => s.outcome === "sl").length;
  const totalPnl  = completed.reduce((sum, s) => sum + (s.pnlGbp ?? 0), 0);

  let peak = 0, cumPnl = 0, maxDrawdown = 0;
  for (const s of completed) {
    cumPnl += s.pnlGbp ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const pnls     = completed.map(s => s.pnlGbp ?? 0);
  const mean     = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const variance = pnls.length > 1
    ? pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnls.length - 1)
    : 0;
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  const pairs  = [...new Set(executed.map(s => s.pair))];
  const byPair: Record<string, { trades: number; wins: number; losses: number; pnlGbp: number }> = {};
  for (const pair of pairs) {
    const pt = completed.filter(s => s.pair === pair);
    byPair[pair] = {
      trades: pt.length,
      wins:   pt.filter(s => s.outcome === "tp").length,
      losses: pt.filter(s => s.outcome === "sl").length,
      pnlGbp: +pt.reduce((sum, s) => sum + (s.pnlGbp ?? 0), 0).toFixed(2),
    };
  }

  return {
    totalTrades:     completed.length,
    wins,
    losses,
    winRate:         completed.length > 0 ? +(wins / completed.length * 100).toFixed(1) : 0,
    totalPnl:        +totalPnl.toFixed(2),
    maxDrawdown:     +maxDrawdown.toFixed(2),
    sharpe:          +sharpe.toFixed(2),
    byPair,
    diagnostics,
    rejectedSignals: rejected,
    log,
  };
}
