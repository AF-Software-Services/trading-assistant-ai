import { PHASE1_PAIRS }                    from "../types/market.ts";
import type { CurrencyPair }               from "../types/market.ts";
import type { BotInstance }                from "./bot-types.ts";
import { createMarketDataProvider }        from "../providers/factory.ts";
import { pipFactor, PIP_VALUE_GBP }        from "../engines/pip-value.ts";
import { detectTrendlineSignal, pickTrendlineTunables, getTradingSession } from "../engines/trendline.ts";
import type { TradingSession }             from "../engines/trendline.ts";
import { detectStructureSignal, pickStructureTunables } from "../engines/structure-signal.ts";
import { detectFibonacciSignal, pickFibonacciTunables } from "../engines/fibonacci-signal.ts";
import { DxyFilter, estimateNotionalGBP } from "../engines/dxy-filter.ts";
import type { DxyFilterConfig, OpenPositionForExposure } from "../engines/dxy-filter.ts";
import { storeTrendlineTrailState }        from "./monitor.ts";
import { TradingService }                  from "../trading/service.ts";
import { getAccount, updateAccountBalance, getPrimaryAccountBalance } from "../ctrader/account-types.ts";
import { createJournalEntry, buildFeaturesFromContext } from "../storage/journal.ts";
import type { BotSignal }                  from "./signal-store.ts";
import {
  getBotSettings,
  saveBotSignal,
  getBotSignals,
  updateBotSignalStatus,
  hasRecentLossOnLine,
  hasOpenPositionFromBotType,
} from "./signal-store.ts";

const LINE_BLACKLIST_MS = 24 * 60 * 60 * 1000;

// Re-export store types and functions so existing callers need no import changes.
export type { BotSignal, BotSettings } from "./signal-store.ts";
export {
  getBotSettings, saveBotSettings,
  getBotSignal,   getBotSignals,  updateBotSignalStatus,
  recordBotSignalOutcome, saveBotSignal, clearBotSignalJournalId,
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

export function calcLots(riskAmountGBP: number, pair: string, entryPrice: number, stopLoss: number): number {
  const stopPips = Math.abs(entryPrice - stopLoss) * pipFactor(pair);
  const pipVal   = PIP_VALUE_GBP[pair] ?? 7.50;
  if (stopPips <= 0 || pipVal <= 0) return 0.01;
  const raw = riskAmountGBP / (stopPips * pipVal);
  return Math.max(0.01, Math.min(10, Math.floor(raw * 100) / 100));
}

// ── Execute a signal via cTrader ──────────────────────────────────────────────

// orderType "limit" (default) matches trendline's retest entries, which anticipate price
// reaching signal.entryPrice. "market" is for signals that already confirm price is there
// right now (e.g. the structure bot's zone-bounce entries) — a limit order at a stale
// snapshot price would either fill immediately anyway or, worse, sit and wait for a pullback
// the strategy never intended.
export async function executeSignal(
  signal:  BotSignal,
  db:      D1Database,
  kv:      KVNamespace,
  trading: TradingService,
  orderType: "market" | "limit" = "limit",
): Promise<void> {
  const { orderId } = await trading.placeOrder({
    pair:       signal.pair,
    direction:  signal.direction,
    lots:       signal.lots,
    ...(orderType === "limit" ? { limitPrice: signal.entryPrice } : {}),
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
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
  botInstance?: BotInstance;
}): Promise<BotRunResult> {
  const result: BotRunResult = {
    pairsScanned: 0, signalsFound: 0,
    signalsQueued: 0, signalsExecuted: 0, signalsFailed: 0, errors: [],
  };

  let mode: "off" | "approval" | "autonomous";
  let minConfidenceScore: number;
  let minConfluence: number;
  let maxOpenPositions: number;
  let allowDuplicatePairs: boolean;
  let botId: string;
  let botType: string;
  let targetPairsOverride: CurrencyPair[] | null = null;

  if (env.botInstance) {
    const bot = env.botInstance;
    mode               = bot.mode;
    minConfidenceScore  = bot.settings.minConfidenceScore  as number;
    minConfluence       = bot.settings.minConfluence       as number;
    maxOpenPositions    = bot.settings.maxOpenPositions    as number;
    allowDuplicatePairs = bot.settings.allowDuplicatePairs as boolean;
    botId               = bot.id;
    botType            = bot.type;
    targetPairsOverride = bot.pairs.length > 0 ? bot.pairs : null;
  } else {
    const settings = await getBotSettings(env.KV);
    mode               = settings.mode;
    minConfidenceScore  = settings.minConfidenceScore;
    minConfluence       = settings.minConfluence;
    maxOpenPositions    = settings.maxOpenPositions;
    allowDuplicatePairs = settings.allowDuplicatePairs;
    botId               = "legacy";
    botType            = "trendline";
    targetPairsOverride = settings.pairs.length > 0 ? settings.pairs as CurrencyPair[] : null;
  }

  if (mode === "off") {
    result.errors.push("Bot is OFF");
    return result;
  }

  const [riskSettings, dxySettings] = await Promise.all([
    env.KV.get("user:risk_settings", "json") as Promise<{ riskPercent?: number; rewardRisk?: number } | null>,
    env.KV.get("user:dxy_filter_settings", "json") as Promise<Partial<DxyFilterConfig> | null>,
  ]);
  // Bot-level sizing overrides global risk settings; fall back to global if not yet saved on the bot.
  const riskPercent = env.botInstance
    ? (env.botInstance.settings["riskPercent"] as number | undefined) ?? (riskSettings?.riskPercent ?? 1)
    : riskSettings?.riskPercent ?? 1;
  const rrRatio = env.botInstance
    ? (env.botInstance.settings["rewardRisk"] as number | undefined) ?? (riskSettings?.rewardRisk ?? 1.5)
    : riskSettings?.rewardRisk ?? 1.5;

  // Trade-setup tuning — only meaningful per-bot; the legacy (no botInstance) path always
  // ran on the hardcoded defaults, so it keeps doing that here.
  const tunables = env.botInstance ? pickTrendlineTunables(env.botInstance.settings) : {};
  const swingLookback = (env.botInstance?.settings["swingLookback"] as number | undefined) ?? 5;
  const tpMode = ((env.botInstance?.settings["tpMode"] as string | undefined) === "atLevel" ? "atLevel" : "rr") as "rr" | "atLevel";
  const requireCandleConfirmation = env.botInstance?.settings["requireCandleConfirmation"] === true;
  const structureTunables = env.botInstance ? pickStructureTunables(env.botInstance.settings) : {};
  const allowedSessions: Record<TradingSession, boolean> = {
    asian:  env.botInstance?.settings["allowAsianSession"]  !== false,
    london: env.botInstance?.settings["allowLondonSession"] !== false,
    ny:     env.botInstance?.settings["allowNySession"]     !== false,
  };

  // Connect to the bot's assigned account; fall back to legacy global token
  const botAccount = env.botInstance?.accountId
    ? await getAccount(env.DB, env.botInstance.accountId)
    : null;
  const trading = botAccount
    ? await TradingService.tryConnectToAccount(env, botAccount)
    : await TradingService.tryConnect(env);
  let openPositionPairs: Set<string> = new Set();
  let openCount = 0;
  // Feeds DxyFilter.onPositionsChanged() for the exposure cap — scoped to this account only,
  // same as everything else here (cross-account aggregation is a known, documented gap, not
  // solved by this filter; see dxy-filter.ts).
  let openPositionsForExposure: OpenPositionForExposure[] = [];

  // Size trades off the account's real balance, not a manually-typed guess.
  // Fetched fresh each scan (we already pay the TCP round-trip for the positions check below);
  // fall back to the cached value on the bot's own account, then any connected account, then a safe default.
  let accountBalance = botAccount?.balance ?? await getPrimaryAccountBalance(env.DB) ?? 1000;

  if (trading) {
    try {
      const positions = await trading.getPositions();
      openCount = positions.length;
      openPositionPairs = new Set(positions.map(p => p.symbol));
      openPositionsForExposure = positions.map(p => ({
        pair: p.symbol, direction: p.direction, lots: p.lots, price: p.currentPrice ?? p.openPrice,
      }));
    } catch (e) {
      if (mode === "autonomous") {
        result.errors.push(`cTrader unavailable: ${(e as Error).message}`);
        return result;
      }
      result.warnings = result.warnings ?? [];
      result.warnings.push(`cTrader position check skipped: ${(e as Error).message}`);
    }

    try {
      const { balance } = await trading.getBalance();
      accountBalance = balance;
      if (botAccount) await updateAccountBalance(env.DB, botAccount.id, balance, Date.now());
    } catch { /* keep cached/fallback accountBalance */ }
  } else if (mode === "autonomous") {
    result.errors.push("cTrader not connected — cannot execute autonomously");
    return result;
  } else {
    // Candle data itself now comes from cTrader too, so scanning is impossible without a
    // connection even in approval mode (previously an independent data vendor made this work).
    result.errors.push("cTrader not connected — cannot fetch candle data to scan");
    return result;
  }

  const riskAmount = accountBalance * riskPercent / 100;

  // Note: closing out finished signals (recording tp/sl outcome, or leaving a genuinely
  // never-filled order alone) is monitorPositions()'s job (bot/monitor.ts) — it runs every
  // cron tick right after this scan and does it correctly by checking trade history. An
  // earlier version of this function also tried to expire/cancel stale signals here, but
  // ran first in the same tick and would blindly attempt to "cancel" positions that had
  // simply filled and closed normally, mislabeling real completed trades as expired.

  await env.DB.prepare(
    `UPDATE bot_signals SET status = 'expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).bind(Date.now()).run();

  const provider = createMarketDataProvider({
    provider: env.MARKET_DATA_PROVIDER,
    trading,
  });

  const targetPairs = targetPairsOverride ?? (PHASE1_PAIRS as CurrencyPair[]);

  // Master toggle defaults to { enabled: false } (DEFAULT_DXY_FILTER_CONFIG) until the user
  // explicitly saves settings via PUT /api/v1/settings/dxy-filter — an existing bot's behavior
  // is provably unchanged until then, regardless of its own per-bot useDxyFilter setting.
  const dxyFilter = new DxyFilter(dxySettings ?? {});
  if (dxyFilter.isEnabled()) {
    await dxyFilter.refreshRegime(provider);
    dxyFilter.onPositionsChanged(openPositionsForExposure);
  }

  for (const pair of targetPairs) {
    result.pairsScanned++;

    try {
      if (!allowDuplicatePairs && openPositionPairs.has(pair)) continue;
      if (openCount >= maxOpenPositions) break;

      const lastExecuted = await env.KV.get(`bot:last_executed:${botId}:${pair}`);
      if (lastExecuted && Date.now() - parseInt(lastExecuted) < 4 * 60 * 60 * 1000) continue;

      if (botType === "trendline") {
        const [candles4H, candlesD] = await Promise.all([
          provider.getCandles(pair, "4H", 200),
          provider.getCandles(pair, "D", 30),
        ]);
        const tlSig = detectTrendlineSignal(candles4H, rrRatio, swingLookback, candlesD, tunables, tpMode, requireCandleConfirmation);

        if (!tlSig) {
          const tlNoBias = detectTrendlineSignal(candles4H, rrRatio, swingLookback, undefined, tunables, tpMode, requireCandleConfirmation);
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
              lineType: tlNoBias.actionLine.type,
              lineP1Ts: candles4H[tlNoBias.actionLine.p1Index]!.timestamp,
              lineP2Ts: candles4H[tlNoBias.actionLine.p2Index]!.timestamp,
              zoneLow: null, zoneHigh: null,
            });
          }
          continue;
        }
        if (tlSig.score < minConfidenceScore) continue;

        const retestHourUtc = new Date(candles4H[tlSig.retestIndex]!.timestamp).getUTCHours();
        if (!allowedSessions[getTradingSession(retestHourUtc)]) continue;

        const lineType = tlSig.actionLine.type;
        const lineP1Ts = candles4H[tlSig.actionLine.p1Index]!.timestamp;
        const lineP2Ts = candles4H[tlSig.actionLine.p2Index]!.timestamp;
        const lineBlacklisted = await hasRecentLossOnLine(env.DB, pair, lineType, lineP1Ts, lineP2Ts, Date.now() - LINE_BLACKLIST_MS);
        if (lineBlacklisted) continue;

        // DXY direction veto — inert unless both this bot's useDxyFilter and the filter's
        // own separate master toggle are on (both default off).
        if (env.botInstance?.settings["useDxyFilter"] === true) {
          const dxyGate = dxyFilter.isTradeAllowed(pair, tlSig.direction, botId);
          if (!dxyGate.allowed) continue;
        }

        result.signalsFound++;

        const lots = calcLots(riskAmount, pair, tlSig.entryPrice, tlSig.stopLoss);
        if (lots <= 0) continue;

        if (env.botInstance?.settings["useDxyFilter"] === true) {
          const notionalGBP = estimateNotionalGBP(pair, lots, tlSig.entryPrice);
          if (dxyFilter.wouldBreachExposure(pair, tlSig.direction, notionalGBP)) continue;
        }

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
          lineType,
          lineP1Ts,
          lineP2Ts,
          zoneLow: null,
          zoneHigh: null,
        };

        if (mode === "approval") {
          await saveBotSignal(env.DB, signal);
          result.signalsQueued++;
        } else {
          try {
            if (!trading) throw new Error("No cTrader token");
            await saveBotSignal(env.DB, signal);
            await executeSignal(signal, env.DB, env.KV, trading, "limit");
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

      if (botType === "structure") {
        const [candlesW, candlesD, candles4H] = await Promise.all([
          provider.getCandles(pair, "W", 60),
          provider.getCandles(pair, "D", 90),
          provider.getCandles(pair, "4H", 200),
        ]);
        const stSig = detectStructureSignal(candlesW, candlesD, candles4H, rrRatio, minConfluence, structureTunables, tpMode);
        if (!stSig) continue;
        if (stSig.score < minConfidenceScore) continue;

        const confirmedHourUtc = new Date(stSig.confirmedAt).getUTCHours();
        if (!allowedSessions[getTradingSession(confirmedHourUtc)]) continue;

        result.signalsFound++;

        const lots = calcLots(riskAmount, pair, stSig.entryPrice, stSig.stopLoss);
        if (lots <= 0) continue;

        const signal: BotSignal = {
          id:               crypto.randomUUID(),
          botId,
          pair,
          direction:        stSig.direction,
          entryPrice:       stSig.entryPrice,
          stopLoss:         stSig.stopLoss,
          takeProfit:       stSig.takeProfit,
          lots,
          score:            stSig.score,
          recommendationId: null,
          reasons:          stSig.reasons,
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
          signalType:       "structure_zone_bounce",
          signalTimeframe:  "4H",
          signalConfidence: stSig.score,
          trend:            stSig.direction === "buy" ? "bullish" : "bearish",
          structure:        null,
          mtfBias:          null,
          mtfLabel:         null,
          atr:              null,
          inAoi:            true,
          fibLabel:         null,
          tradeClass:       "structure",
          zoneType:         stSig.zoneType,
          patternType:      stSig.patternType,
          outcome:          null,
          closePrice:       null,
          closeTime:        null,
          pnlPips:          null,
          pnlGbp:           null,
          lineType:         null,
          lineP1Ts:         null,
          lineP2Ts:         null,
          zoneLow:          stSig.zoneLow,
          zoneHigh:         stSig.zoneHigh,
        };

        if (mode === "approval") {
          await saveBotSignal(env.DB, signal);
          result.signalsQueued++;
        } else {
          try {
            if (!trading) throw new Error("No cTrader token");
            await saveBotSignal(env.DB, signal);
            await executeSignal(signal, env.DB, env.KV, trading, "market");
            openCount++;
            openPositionPairs.add(pair);
            result.signalsExecuted++;
          } catch (e) {
            const msg = (e as Error).message;
            await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
            result.signalsFailed++;
            result.errors.push(`${pair} ${stSig.direction}: ${msg}`);
          }
        }

        continue;
      }

      if (botType === "fibonacci") {
        const candles4H = await provider.getCandles(pair, "4H", 200);
        const minReward = (env.botInstance?.settings["minReward"] as number | undefined) ?? 1.5;
        const fibTunables = env.botInstance ? pickFibonacciTunables(env.botInstance.settings) : {};
        const fibSig = detectFibonacciSignal(candles4H, rrRatio, minReward, fibTunables);
        if (!fibSig) continue;
        if (fibSig.score < minConfidenceScore) continue;

        const confirmedHourUtc = new Date(fibSig.confirmedAt).getUTCHours();
        if (!allowedSessions[getTradingSession(confirmedHourUtc)]) continue;

        // Cross-bot deconfliction — skip if a trendline-bot position is already open on this
        // pair/account, unless this fibonacci bot explicitly opts into concurrency. Separate
        // from allowDuplicatePairs, which only governs duplicates within this same bot.
        if (env.botInstance?.settings["allowConcurrentWithTrendlineBot"] !== true) {
          const trendlineOpen = await hasOpenPositionFromBotType(env.DB, pair, "trendline", env.botInstance?.accountId ?? null);
          if (trendlineOpen) continue;
        }

        // DXY direction veto — inert unless both this bot's useDxyFilter and the filter's
        // own separate master toggle are on (both default off).
        if (env.botInstance?.settings["useDxyFilter"] === true) {
          const dxyGate = dxyFilter.isTradeAllowed(pair, fibSig.direction, botId);
          if (!dxyGate.allowed) continue;
        }

        result.signalsFound++;

        const lots = calcLots(riskAmount, pair, fibSig.entryPrice, fibSig.stopLoss);
        if (lots <= 0) continue;

        if (env.botInstance?.settings["useDxyFilter"] === true) {
          const notionalGBP = estimateNotionalGBP(pair, lots, fibSig.entryPrice);
          if (dxyFilter.wouldBreachExposure(pair, fibSig.direction, notionalGBP)) continue;
        }

        const signal: BotSignal = {
          id:               crypto.randomUUID(),
          botId,
          pair,
          direction:        fibSig.direction,
          entryPrice:       fibSig.entryPrice,
          stopLoss:         fibSig.stopLoss,
          takeProfit:       fibSig.takeProfit,
          lots,
          score:            fibSig.score,
          recommendationId: null,
          reasons:          fibSig.reasons,
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
          signalType:       "fibonacci_pullback",
          signalTimeframe:  "4H",
          signalConfidence: fibSig.score,
          trend:            fibSig.direction === "buy" ? "bullish" : "bearish",
          structure:        null,
          mtfBias:          null,
          mtfLabel:         null,
          atr:              null,
          inAoi:            false,
          fibLabel:         `${fibSig.patternType}`,
          tradeClass:       "fibonacci",
          zoneType:         null,
          patternType:      fibSig.patternType,
          outcome:          null,
          closePrice:       null,
          closeTime:        null,
          pnlPips:          null,
          pnlGbp:           null,
          lineType:         null,
          lineP1Ts:         null,
          lineP2Ts:         null,
          zoneLow:          fibSig.legOriginPrice,
          zoneHigh:         fibSig.legExtremePrice,
        };

        if (mode === "approval") {
          await saveBotSignal(env.DB, signal);
          result.signalsQueued++;
        } else {
          try {
            if (!trading) throw new Error("No cTrader token");
            await saveBotSignal(env.DB, signal);
            await executeSignal(signal, env.DB, env.KV, trading, "market");
            openCount++;
            openPositionPairs.add(pair);
            result.signalsExecuted++;
          } catch (e) {
            const msg = (e as Error).message;
            await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
            result.signalsFailed++;
            result.errors.push(`${pair} ${fibSig.direction}: ${msg}`);
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
