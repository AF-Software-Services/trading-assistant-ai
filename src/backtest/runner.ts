import type { Candle, CurrencyPair, Timeframe } from "../types/market.ts";
import { calculateATR } from "../engines/trend.ts";
import { calcLots } from "../bot/engine.ts";
import type { BotSignal } from "../bot/engine.ts";
import { detectTrendlineSignal } from "../engines/trendline.ts";

// Approximate GBP pip value per standard lot
const PIP_VALUE_GBP: Record<string, number> = {
  "EUR/USD": 7.50,
  "GBP/USD": 7.50,
  "USD/JPY": 7.50,
  "AUD/USD": 7.50,
  "EUR/GBP": 10.00,
  "GBP/CAD": 5.50,
};

function pipFactor(pair: string): number {
  return pair.includes("JPY") ? 100 : 10000;
}


export interface BacktestConfig {
  pairs: string[];
  fromMs: number;
  toMs: number;
  accountBalance: number;
  riskPercent: number;
  rewardRisk: number;
  minScore: number;
  maxOpenPositions: number;
}

interface TwelveDataCandle {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

function toMs(datetime: string): number {
  // "2024-01-15 04:00:00" or "2024-01-15"
  return new Date(datetime.replace(" ", "T") + (datetime.includes(":") ? "Z" : "T00:00:00Z")).getTime();
}

function convertCandles(raw: TwelveDataCandle[], pair: string, tf: Timeframe): Candle[] {
  return raw
    .map(c => ({
      timestamp: toMs(c.datetime),
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
      timeframe: tf,
      pair: pair as CurrencyPair,
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // oldest first
}

async function fetchCandlesFromAPI(
  pair: string,
  interval: string,
  startDate: string,
  endDate: string,
  apiKey: string,
): Promise<Candle[]> {
  // Retry up to 3 times on 429, with 15s backoff — no preventive delays
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&start_date=${startDate}&end_date=${endDate}&outputsize=5000&apikey=${apiKey}`;
    const res = await fetch(url);
    if (res.status === 429) {
      if (attempt < 2) { await delay(15000); continue; }
      throw new Error(`Twelve Data HTTP 429 for ${pair} ${interval} (rate limited after retries)`);
    }
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${pair} ${interval}`);
    const data = await res.json() as { values?: TwelveDataCandle[]; code?: number; message?: string };
    if (!data.values || data.values.length === 0) {
      if (data.message) throw new Error(`Twelve Data error: ${data.message}`);
      return [];
    }
    const tf = interval === "1day" ? "D" : interval === "1week" ? "W" : interval === "4h" ? "4H" : "1H";
    return convertCandles(data.values, pair, tf as Timeframe);
  }
  return [];
}

async function fetchCandles(
  pair: string,
  interval: string,
  startDate: string,
  endDate: string,
  apiKey: string,
  kv?: KVNamespace,
): Promise<{ candles: Candle[]; fromCache: boolean }> {
  // Cache key excludes date range — one cache entry covers all backtest periods.
  // TTL is 24h so data refreshes daily.
  const cacheKey = `candles_v2:${pair}:${interval}`;

  if (kv) {
    const cached = await kv.get(cacheKey, "json") as Candle[] | null;
    if (cached && cached.length > 0) return { candles: cached, fromCache: true };
  }

  const candles = await fetchCandlesFromAPI(pair, interval, startDate, endDate, apiKey);

  if (kv && candles.length > 0) {
    await kv.put(cacheKey, JSON.stringify(candles), { expirationTtl: 86400 * 7 });
  }

  return { candles, fromCache: false };
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  apiKey: string,
  onProgress?: (msg: string) => void,
  kv?: KVNamespace,
): Promise<BacktestResult> {
  const allSignals: BotSignal[] = [];
  const rejections: Record<string, number> = {};
  const log: string[] = [];
  const progress = (msg: string) => { log.push(msg); onProgress?.(msg); };

  const lookbackMs = 200 * 7 * 24 * 60 * 60 * 1000;
  const fetchFrom  = new Date(config.fromMs - lookbackMs).toISOString().slice(0, 10);
  const fetchTo    = new Date(config.toMs).toISOString().slice(0, 10);

  // Shared across all pairs — mirrors live bot constraints exactly.
  // openPositions tracks concurrent trades; lastSignalMs enforces the 4H cooldown per pair.
  const openPositions: Array<{ pair: string; closeTime: number }> = [];
  const lastSignalMs: Record<string, number> = {};
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  for (const pair of config.pairs) {
    progress(`Fetching data for ${pair}…`);

    let candles4H: Candle[];
    let candlesD:  Candle[];
    try {
      const r4H = await fetchCandles(pair, "4h",   fetchFrom, fetchTo, apiKey, kv);
      if (!r4H.fromCache) await delay(8000);
      const rD  = await fetchCandles(pair, "1day", fetchFrom, fetchTo, apiKey, kv);
      if (!rD.fromCache)  await delay(8000);
      candles4H = r4H.candles;
      candlesD  = rD.candles;
    } catch (err) {
      progress(`Error fetching ${pair}: ${(err as Error).message}`);
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
      // No second position on the same pair
      if (openPositions.some(p => p.pair === pair)) {
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

      const sig = detectTrendlineSignal(history, config.rewardRisk, 5, dHistory);
      if (!sig) {
        // Secondary pass without daily bias — distinguishes "no pattern" from "bias filtered"
        const sigNoBias = detectTrendlineSignal(history, config.rewardRisk, 5, undefined);
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
      };

      allSignals.push(signal);
    }

    const pairCount = allSignals.filter(s => s.pair === pair).length;
    progress(`${pair}: ${pairCount} trendline signals`);
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
