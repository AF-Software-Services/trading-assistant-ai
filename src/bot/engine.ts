import { PHASE1_PAIRS }                    from "../types/market.ts";
import type { CurrencyPair }               from "../types/market.ts";
import type { BotInstance }                from "./bot-types.ts";
import { createMarketDataProvider }        from "../providers/factory.ts";
import { detectTrendlineSignal }           from "../engines/trendline.ts";
import { storeTrendlineTrailState }        from "./monitor.ts";
import { TradingService }                  from "../trading/service.ts";
import { createJournalEntry, buildFeaturesFromContext } from "../storage/journal.ts";
import type { BotSignal }                  from "./signal-store.ts";
import {
  getBotSettings,
  saveBotSignal,
  getBotSignals,
  updateBotSignalStatus,
} from "./signal-store.ts";

// Re-export store types and functions so existing callers need no import changes.
export type { BotSignal, BotSettings } from "./signal-store.ts";
export {
  getBotSettings, saveBotSettings,
  getBotSignal,   getBotSignals,  updateBotSignalStatus,
  recordBotSignalOutcome, saveBotSignal,
} from "./signal-store.ts";

export interface BotRunResult {
  pairsScanned:    number;
  signalsFound:    number;
  signalsQueued:   number;
  signalsExecuted: number;
  signalsFailed:   number;
  errors:          string[];
  warnings?:       string[];
}

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

export function calcLots(riskAmountGBP: number, pair: string, entryPrice: number, stopLoss: number): number {
  const stopPips = Math.abs(entryPrice - stopLoss) * pipFactor(pair);
  const pipVal   = PIP_VALUE_GBP[pair] ?? 7.50;
  if (stopPips <= 0 || pipVal <= 0) return 0.01;
  const raw = riskAmountGBP / (stopPips * pipVal);
  return Math.max(0.01, Math.min(10, Math.floor(raw * 100) / 100));
}

function getCurrentSession(): string {
  const h = new Date().getUTCHours();
  if (h >= 7  && h < 9)  return "overlap_asian_london";
  if (h >= 9  && h < 12) return "london";
  if (h >= 12 && h < 13) return "overlap_london_ny";
  if (h >= 13 && h < 17) return "ny";
  if (h >= 17 && h < 21) return "ny_late";
  return "asian";
}

// ── Execute a signal via cTrader ──────────────────────────────────────────────

export async function executeSignal(
  signal:  BotSignal,
  db:      D1Database,
  kv:      KVNamespace,
  trading: TradingService,
): Promise<void> {
  const { orderId } = await trading.placeOrder({
    pair:       signal.pair,
    direction:  signal.direction,
    lots:       signal.lots,
    limitPrice: signal.entryPrice,
    stopLoss:   signal.stopLoss,
    takeProfit: signal.takeProfit,
  });

  const features = buildFeaturesFromContext({
    signalType:   signal.reasons[0] ?? "bot_signal",
    rrRatio:      Math.abs(signal.takeProfit - signal.entryPrice) / Math.abs(signal.entryPrice - signal.stopLoss),
    stopPips:     Math.abs(signal.entryPrice - signal.stopLoss) * pipFactor(signal.pair),
    totalScore:   signal.score,
    aoiConfirmed: true,
    candles4h:    [],
    candlesD:     [],
  });

  const now = new Date();
  const journalId = await createJournalEntry(db, {
    recommendationId: signal.recommendationId,
    pair:             signal.pair,
    direction:        signal.direction,
    timeframe:        "4H",
    entryPrice:       signal.entryPrice,
    stopLoss:         signal.stopLoss,
    target:           signal.takeProfit,
    confidence:       signal.score,
    session:          features.session,
    dayOfWeek:        now.getUTCDay(),
    features,
    notes:            `Bot ${signal.ctraderPositionId ? "executed" : "queued"} — ${signal.reasons.join("; ")}`,
    createdAt:        Date.now(),
  });

  await kv.put(`bot:last_executed:${signal.botId}:${signal.pair}`, String(Date.now()));

  await updateBotSignalStatus(db, signal.id, "executed", {
    executedAt:        Date.now(),
    ctraderPositionId: orderId || null,
    journalId,
  });
}

// ── Main bot scan ─────────────────────────────────────────────────────────────

export async function runBotScan(env: {
  DB: D1Database;
  KV: KVNamespace;
  MARKET_DATA_PROVIDER: string;
  TWELVE_DATA_API_KEY?: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
  skipSessionGate?: boolean;
  botInstance?: BotInstance;
}): Promise<BotRunResult> {
  const result: BotRunResult = {
    pairsScanned: 0, signalsFound: 0,
    signalsQueued: 0, signalsExecuted: 0, signalsFailed: 0, errors: [],
  };

  let mode: "off" | "approval" | "autonomous";
  let minConfidenceScore: number;
  let minConfluence: number;
  let botId: string;
  let botType: string;
  let targetPairsOverride: CurrencyPair[] | null = null;

  if (env.botInstance) {
    const bot = env.botInstance;
    mode               = bot.mode;
    minConfidenceScore = (bot.settings.minConfidenceScore as number) ?? 60;
    minConfluence      = (bot.settings.minConfluence      as number) ?? 2;
    botId              = bot.id;
    botType            = bot.type;
    targetPairsOverride = bot.pairs.length > 0 ? bot.pairs : null;
  } else {
    const settings = await getBotSettings(env.KV);
    mode               = settings.mode;
    minConfidenceScore = settings.minConfidenceScore;
    minConfluence      = settings.minConfluence;
    botId              = "legacy";
    botType            = "trendline";
    targetPairsOverride = settings.pairs.length > 0 ? settings.pairs as CurrencyPair[] : null;
  }

  if (mode === "off") {
    result.errors.push("Bot is OFF");
    return result;
  }

  const session = getCurrentSession();
  if (!env.skipSessionGate) {
    const settings = await getBotSettings(env.KV);
    if (!settings.allowedSessions.includes(session)) {
      result.errors.push(`Session ${session} not in allowed list`);
      return result;
    }
  }

  const riskSettings = await env.KV.get("user:risk_settings", "json") as
    { accountBalance?: number; riskPercent?: number; rewardRisk?: number } | null;
  const accountBalance = riskSettings?.accountBalance ?? 1000;
  const botSettings    = env.botInstance?.settings ?? {};
  const riskPercent    = (botSettings["riskPercent"] as number | undefined) ?? riskSettings?.riskPercent ?? 1;
  const rrRatio        = (botSettings["rewardRisk"]  as number | undefined) ?? riskSettings?.rewardRisk  ?? 1.5;
  const riskAmount     = accountBalance * riskPercent / 100;

  const trading = await TradingService.tryConnect(env);
  let openPositionPairs: Set<string> = new Set();
  let openCount = 0;

  if (trading) {
    try {
      const positions = await trading.getPositions();
      openCount = positions.length;
      openPositionPairs = new Set(positions.map(p => p.symbol));
    } catch (e) {
      if (mode === "autonomous") {
        result.errors.push(`cTrader unavailable: ${(e as Error).message}`);
        return result;
      }
      result.warnings = result.warnings ?? [];
      result.warnings.push(`cTrader position check skipped: ${(e as Error).message}`);
    }
  } else if (mode === "autonomous") {
    result.errors.push("cTrader not connected — cannot execute autonomously");
    return result;
  }

  if (trading) {
    const expiring = await env.DB.prepare(
      `SELECT id, ctrader_position_id FROM bot_signals
       WHERE status = 'executed' AND expires_at < ? AND ctrader_position_id IS NOT NULL`
    ).bind(Date.now()).all<{ id: string; ctrader_position_id: number }>();

    for (const row of expiring.results) {
      try {
        await trading.cancelOrder(row.ctrader_position_id);
      } catch { /* order may already be filled or gone */ }
      await updateBotSignalStatus(env.DB, row.id, "expired");
    }
  }

  await env.DB.prepare(
    `UPDATE bot_signals SET status = 'expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).bind(Date.now()).run();

  const provider = createMarketDataProvider({
    provider: env.MARKET_DATA_PROVIDER,
    apiKey:   env.TWELVE_DATA_API_KEY || undefined,
    kv:       env.KV,
  });

  const targetPairs = targetPairsOverride ?? (PHASE1_PAIRS as CurrencyPair[]);

  for (const pair of targetPairs) {
    result.pairsScanned++;

    try {
      if (openPositionPairs.has(pair)) continue;
      if (openCount >= 2) break;

      const lastExecuted = await env.KV.get(`bot:last_executed:${botId}:${pair}`);
      if (lastExecuted && Date.now() - parseInt(lastExecuted) < 4 * 60 * 60 * 1000) continue;

      if (botType === "trendline") {
        const [candles4H, candlesD] = await Promise.all([
          provider.getCandles(pair, "4H",   200),
          provider.getCandles(pair, "1day",  30),
        ]);
        const tlSig = detectTrendlineSignal(candles4H, rrRatio, 5, candlesD);

        if (!tlSig) {
          const tlNoBias = detectTrendlineSignal(candles4H, rrRatio, 5, undefined);
          if (tlNoBias) {
            await saveBotSignal(env.DB, {
              id: crypto.randomUUID(), botId, pair,
              direction:         tlNoBias.direction,
              entryPrice:        tlNoBias.entryPrice,
              stopLoss:          tlNoBias.stopLoss,
              takeProfit:        tlNoBias.takeProfit,
              lots:              0,
              score:             tlNoBias.score,
              recommendationId:  null,
              reasons:           tlNoBias.reasons,
              status:            "rejected",
              createdAt:         Date.now(),
              expiresAt:         Date.now() + 4 * 60 * 60 * 1000,
              executedAt:        null,
              ctraderPositionId: null,
              journalId:         null,
              rejectionReason:   "daily_bias_filter",
              errorMessage:      null,
              source:            "live",
              backtestRunId:     null,
              signalType:        "trendline_break_retest",
              signalTimeframe:   "4H",
              signalConfidence:  tlNoBias.score,
              trend:             tlNoBias.direction === "buy" ? "bullish" : "bearish",
              structure:         null, mtfBias: null, mtfLabel: null,
              atr:               null, inAoi: false, fibLabel: null,
              tradeClass:        "trendline", zoneType: null, patternType: null,
              outcome: null, closePrice: null, closeTime: null, pnlPips: null, pnlGbp: null,
            });
          }
          continue;
        }
        if (tlSig.score < minConfidenceScore) continue;

        result.signalsFound++;

        const lots = calcLots(riskAmount, pair, tlSig.entryPrice, tlSig.stopLoss);
        if (lots <= 0) continue;

        const signal: BotSignal = {
          id:               crypto.randomUUID(),
          botId,
          pair,
          direction:        tlSig.direction,
          entryPrice:       tlSig.entryPrice,
          stopLoss:         tlSig.stopLoss,
          takeProfit:       tlSig.takeProfit,
          lots,
          score:            tlSig.score,
          recommendationId: null,
          reasons:          tlSig.reasons,
          status:           "pending",
          createdAt:        Date.now(),
          expiresAt:        Date.now() + 4 * 60 * 60 * 1000,
          executedAt:       null,
          ctraderPositionId: null,
          journalId:        null,
          rejectionReason:  null,
          errorMessage:     null,
          source:           'live',
          backtestRunId:    null,
          signalType:       "trendline_break_retest",
          signalTimeframe:  "4H",
          signalConfidence: tlSig.score,
          trend:            tlSig.direction === "buy" ? "bullish" : "bearish",
          structure:        null,
          mtfBias:          null,
          mtfLabel:         null,
          atr:              null,
          inAoi:            false,
          fibLabel:         null,
          tradeClass:       "trendline",
          zoneType:         null,
          patternType:      null,
          outcome:          null,
          closePrice:       null,
          closeTime:        null,
          pnlPips:          null,
          pnlGbp:           null,
        };

        if (mode === "approval") {
          await saveBotSignal(env.DB, signal);
          result.signalsQueued++;
        } else {
          try {
            if (!trading) throw new Error("No cTrader token");
            await saveBotSignal(env.DB, signal);
            await executeSignal(signal, env.DB, env.KV, trading);
            await storeTrendlineTrailState(env.KV, signal.id, tlSig.safetyLine, Date.now(), signal.stopLoss);
            openCount++;
            openPositionPairs.add(pair);
            result.signalsExecuted++;
          } catch (e) {
            const msg = (e as Error).message;
            await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
            result.signalsFailed++;
            result.errors.push(`${pair} ${tlSig.direction}: ${msg}`);
          }
        }

        continue;
      }
    } catch (e) {
      result.errors.push(`${pair}: ${(e as Error).message}`);
    }
  }

  return result;
}
