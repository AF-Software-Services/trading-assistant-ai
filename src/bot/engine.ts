import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";
import type { BotInstance }                from "./bot-types.ts";
import { createMarketDataProvider }        from "../providers/factory.ts";
import type { MarketDataProvider }         from "../providers/interface.ts";
import { pipFactor, PIP_VALUE_GBP }        from "../engines/pip-value.ts";
import { detectTrendlineSignal, pickTrendlineTunables, getTradingSession } from "../engines/trendline.ts";
import type { TradingSession }             from "../engines/trendline.ts";
import { detectStructureSignal, pickStructureTunables } from "../engines/structure-signal.ts";
import { detectFibonacciSignal, pickFibonacciTunables } from "../engines/fibonacci-signal.ts";
import { detectSessionBreakoutSignal, pickSessionBreakoutTunables } from "../engines/session-breakout.ts";
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

type Env = {
  DB: D1Database;
  KV: KVNamespace;
  MARKET_DATA_PROVIDER: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
};

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

// ── Shared candle cache ────────────────────────────────────────────────────────
// Multiple active bots very often target the same pair — sometimes the exact same bot type
// with the exact same timeframe/count (e.g. two trendline bots covering the same 19 pairs).
// Candle history isn't account-specific, so whichever bot's connection fetches a given
// (pair, timeframe, count) combination first can serve every other bot that needs the same
// data this scan, instead of each bot independently refetching it. Scoped to a single
// runBotScans() call — never persisted, so every scan tick still sees fully fresh data.
class ScanCandleCache implements MarketDataProvider {
  private cache = new Map<string, Promise<Candle[]>>();
  constructor(private provider: MarketDataProvider) {}

  getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const key = `${pair}:${timeframe}:${count}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.provider.getCandles(pair, timeframe, count);
      this.cache.set(key, entry);
    }
    return entry;
  }

  getLatestPrice(pair: CurrencyPair): Promise<PriceTick> {
    return this.provider.getLatestPrice(pair);
  }
}

// ── Per-bot scan context ──────────────────────────────────────────────────────
// Everything about a bot that's independent of which pair is being evaluated — account
// connection, sizing, tuning, open-position state — resolved once per bot per scan run,
// then reused across every pair that bot targets.
interface BotContext {
  botInstance:         BotInstance | undefined;
  botId:               string;
  botType:             string;
  mode:                "off" | "approval" | "autonomous";
  minConfidenceScore:  number;
  minConfluence:       number;
  maxOpenPositions:    number;
  allowDuplicatePairs: boolean;
  targetPairs:         CurrencyPair[];
  riskAmount:          number;
  rrRatio:             number;
  tunables:            ReturnType<typeof pickTrendlineTunables>;
  swingLookback:       number;
  tpMode:              "rr" | "atLevel";
  requireCandleConfirmation: boolean;
  structureTunables:   ReturnType<typeof pickStructureTunables>;
  allowedSessions:     Record<TradingSession, boolean>;
  trading:             TradingService | null;
  openPositionPairs:   Set<string>;
  openCount:           number;
  dxyFilter:           DxyFilter;
  result:              BotRunResult;
}

async function buildBotContext(
  env: Env,
  botInstance: BotInstance | undefined,
): Promise<{ ctx: BotContext } | { doneResult: BotRunResult }> {
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
  // No fallback — a bot scans exactly the pairs it's configured with, even if that's none.
  // Silently substituting some other pair list when this is empty (as the old code did)
  // means a bot's actual coverage can silently diverge from what its own settings say.
  let targetPairs: CurrencyPair[];

  if (botInstance) {
    const bot = botInstance;
    mode                = bot.mode;
    minConfidenceScore  = bot.settings.minConfidenceScore  as number;
    minConfluence       = bot.settings.minConfluence       as number;
    maxOpenPositions    = bot.settings.maxOpenPositions    as number;
    allowDuplicatePairs = bot.settings.allowDuplicatePairs as boolean;
    botId               = bot.id;
    botType             = bot.type;
    targetPairs         = bot.pairs;
  } else {
    const settings = await getBotSettings(env.KV);
    mode                = settings.mode;
    minConfidenceScore  = settings.minConfidenceScore;
    minConfluence       = settings.minConfluence;
    maxOpenPositions    = settings.maxOpenPositions;
    allowDuplicatePairs = settings.allowDuplicatePairs;
    botId               = "legacy";
    botType             = "trendline";
    targetPairs         = settings.pairs as CurrencyPair[];
  }

  if (mode === "off") {
    result.errors.push("Bot is OFF");
    return { doneResult: result };
  }

  const [riskSettings, dxySettings] = await Promise.all([
    env.KV.get("user:risk_settings", "json") as Promise<{ riskPercent?: number; rewardRisk?: number } | null>,
    env.KV.get("user:dxy_filter_settings", "json") as Promise<Partial<DxyFilterConfig> | null>,
  ]);
  // Bot-level sizing overrides global risk settings; fall back to global if not yet saved on the bot.
  const riskPercent = botInstance
    ? (botInstance.settings["riskPercent"] as number | undefined) ?? (riskSettings?.riskPercent ?? 1)
    : riskSettings?.riskPercent ?? 1;
  const rrRatio = botInstance
    ? (botInstance.settings["rewardRisk"] as number | undefined) ?? (riskSettings?.rewardRisk ?? 1.5)
    : riskSettings?.rewardRisk ?? 1.5;

  // Trade-setup tuning — only meaningful per-bot; the legacy (no botInstance) path always
  // ran on the hardcoded defaults, so it keeps doing that here.
  const tunables = botInstance ? pickTrendlineTunables(botInstance.settings) : {};
  const swingLookback = (botInstance?.settings["swingLookback"] as number | undefined) ?? 5;
  const tpMode = ((botInstance?.settings["tpMode"] as string | undefined) === "atLevel" ? "atLevel" : "rr") as "rr" | "atLevel";
  const requireCandleConfirmation = botInstance?.settings["requireCandleConfirmation"] === true;
  const structureTunables = botInstance ? pickStructureTunables(botInstance.settings) : {};
  const allowedSessions: Record<TradingSession, boolean> = {
    asian:  botInstance?.settings["allowAsianSession"]  !== false,
    london: botInstance?.settings["allowLondonSession"] !== false,
    ny:     botInstance?.settings["allowNySession"]     !== false,
  };

  // Connect to the bot's assigned account; fall back to legacy global token
  const botAccount = botInstance?.accountId
    ? await getAccount(env.DB, botInstance.accountId)
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
        return { doneResult: result };
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
    return { doneResult: result };
  } else {
    // Candle data itself now comes from cTrader too, so scanning is impossible without a
    // connection even in approval mode (previously an independent data vendor made this work).
    result.errors.push("cTrader not connected — cannot fetch candle data to scan");
    return { doneResult: result };
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

  // Master toggle defaults to { enabled: false } (DEFAULT_DXY_FILTER_CONFIG) until the user
  // explicitly saves settings via PUT /api/v1/settings/dxy-filter — an existing bot's behavior
  // is provably unchanged until then, regardless of its own per-bot useDxyFilter setting.
  const dxyFilter = new DxyFilter(dxySettings ?? {});
  if (dxyFilter.isEnabled()) {
    dxyFilter.onPositionsChanged(openPositionsForExposure);
  }

  return {
    ctx: {
      botInstance, botId, botType, mode,
      minConfidenceScore, minConfluence, maxOpenPositions, allowDuplicatePairs,
      targetPairs, riskAmount, rrRatio, tunables, swingLookback, tpMode,
      requireCandleConfirmation, structureTunables, allowedSessions,
      trading, openPositionPairs, openCount, dxyFilter, result,
    },
  };
}

// ── Per-(bot, pair) signal detection + execution ──────────────────────────────
// Everything that used to be inside runBotScan's per-pair loop body, now parameterized over
// a pre-built BotContext and a shared candle cache instead of a bot-owned provider.
async function scanPairForBot(
  env:   Env,
  ctx:   BotContext,
  pair:  CurrencyPair,
  cache: ScanCandleCache,
): Promise<void> {
  const { botId, botType, mode, result } = ctx;

  if (botType === "trendline") {
    const [candles4H, candlesD] = await Promise.all([
      cache.getCandles(pair, "4H", 200),
      cache.getCandles(pair, "D", 30),
    ]);
    const tlSig = detectTrendlineSignal(candles4H, ctx.rrRatio, ctx.swingLookback, candlesD, ctx.tunables, ctx.tpMode, ctx.requireCandleConfirmation);

    if (!tlSig) {
      const tlNoBias = detectTrendlineSignal(candles4H, ctx.rrRatio, ctx.swingLookback, undefined, ctx.tunables, ctx.tpMode, ctx.requireCandleConfirmation);
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
      return;
    }
    if (tlSig.score < ctx.minConfidenceScore) return;

    const retestHourUtc = new Date(candles4H[tlSig.retestIndex]!.timestamp).getUTCHours();
    if (!ctx.allowedSessions[getTradingSession(retestHourUtc)]) return;

    const lineType = tlSig.actionLine.type;
    const lineP1Ts = candles4H[tlSig.actionLine.p1Index]!.timestamp;
    const lineP2Ts = candles4H[tlSig.actionLine.p2Index]!.timestamp;
    const lineBlacklisted = await hasRecentLossOnLine(env.DB, pair, lineType, lineP1Ts, lineP2Ts, Date.now() - LINE_BLACKLIST_MS);
    if (lineBlacklisted) return;

    // DXY direction veto — inert unless both this bot's useDxyFilter and the filter's
    // own separate master toggle are on (both default off).
    if (ctx.botInstance?.settings["useDxyFilter"] === true) {
      const dxyGate = ctx.dxyFilter.isTradeAllowed(pair, tlSig.direction, botId);
      if (!dxyGate.allowed) return;
    }

    result.signalsFound++;

    const lots = calcLots(ctx.riskAmount, pair, tlSig.entryPrice, tlSig.stopLoss);
    if (lots <= 0) return;

    if (ctx.botInstance?.settings["useDxyFilter"] === true) {
      const notionalGBP = estimateNotionalGBP(pair, lots, tlSig.entryPrice);
      if (ctx.dxyFilter.wouldBreachExposure(pair, tlSig.direction, notionalGBP)) return;
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
        if (!ctx.trading) throw new Error("No cTrader token");
        await saveBotSignal(env.DB, signal);
        await executeSignal(signal, env.DB, env.KV, ctx.trading, "limit");
        await storeTrendlineTrailState(env.KV, signal.id, tlSig.safetyLine, Date.now(), signal.stopLoss);
        ctx.openCount++;
        ctx.openPositionPairs.add(pair);
        result.signalsExecuted++;
      } catch (e) {
        const msg = (e as Error).message;
        await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
        result.signalsFailed++;
        result.errors.push(`${pair} ${tlSig.direction}: ${msg}`);
      }
    }

    return;
  }

  if (botType === "structure") {
    const [candlesW, candlesD, candles4H] = await Promise.all([
      cache.getCandles(pair, "W", 60),
      cache.getCandles(pair, "D", 90),
      cache.getCandles(pair, "4H", 200),
    ]);
    const stSig = detectStructureSignal(candlesW, candlesD, candles4H, ctx.rrRatio, ctx.minConfluence, ctx.structureTunables, ctx.tpMode);
    if (!stSig) return;
    if (stSig.score < ctx.minConfidenceScore) return;

    const confirmedHourUtc = new Date(stSig.confirmedAt).getUTCHours();
    if (!ctx.allowedSessions[getTradingSession(confirmedHourUtc)]) return;

    result.signalsFound++;

    const lots = calcLots(ctx.riskAmount, pair, stSig.entryPrice, stSig.stopLoss);
    if (lots <= 0) return;

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
        if (!ctx.trading) throw new Error("No cTrader token");
        await saveBotSignal(env.DB, signal);
        await executeSignal(signal, env.DB, env.KV, ctx.trading, "market");
        ctx.openCount++;
        ctx.openPositionPairs.add(pair);
        result.signalsExecuted++;
      } catch (e) {
        const msg = (e as Error).message;
        await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
        result.signalsFailed++;
        result.errors.push(`${pair} ${stSig.direction}: ${msg}`);
      }
    }

    return;
  }

  if (botType === "fibonacci") {
    const candles4H = await cache.getCandles(pair, "4H", 200);
    const minReward = (ctx.botInstance?.settings["minReward"] as number | undefined) ?? 1.5;
    const fibTunables = ctx.botInstance ? pickFibonacciTunables(ctx.botInstance.settings) : {};
    const fibSig = detectFibonacciSignal(candles4H, ctx.rrRatio, minReward, fibTunables);
    if (!fibSig) return;
    if (fibSig.score < ctx.minConfidenceScore) return;

    const confirmedHourUtc = new Date(fibSig.confirmedAt).getUTCHours();
    if (!ctx.allowedSessions[getTradingSession(confirmedHourUtc)]) return;

    // Cross-bot deconfliction — skip if a trendline-bot position is already open on this
    // pair/account, unless this fibonacci bot explicitly opts into concurrency. Separate
    // from allowDuplicatePairs, which only governs duplicates within this same bot.
    if (ctx.botInstance?.settings["allowConcurrentWithTrendlineBot"] !== true) {
      const trendlineOpen = await hasOpenPositionFromBotType(env.DB, pair, "trendline", ctx.botInstance?.accountId ?? null);
      if (trendlineOpen) return;
    }

    // DXY direction veto — inert unless both this bot's useDxyFilter and the filter's
    // own separate master toggle are on (both default off).
    if (ctx.botInstance?.settings["useDxyFilter"] === true) {
      const dxyGate = ctx.dxyFilter.isTradeAllowed(pair, fibSig.direction, botId);
      if (!dxyGate.allowed) return;
    }

    result.signalsFound++;

    const lots = calcLots(ctx.riskAmount, pair, fibSig.entryPrice, fibSig.stopLoss);
    if (lots <= 0) return;

    if (ctx.botInstance?.settings["useDxyFilter"] === true) {
      const notionalGBP = estimateNotionalGBP(pair, lots, fibSig.entryPrice);
      if (ctx.dxyFilter.wouldBreachExposure(pair, fibSig.direction, notionalGBP)) return;
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
        if (!ctx.trading) throw new Error("No cTrader token");
        await saveBotSignal(env.DB, signal);
        await executeSignal(signal, env.DB, env.KV, ctx.trading, "market");
        ctx.openCount++;
        ctx.openPositionPairs.add(pair);
        result.signalsExecuted++;
      } catch (e) {
        const msg = (e as Error).message;
        await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
        result.signalsFailed++;
        result.errors.push(`${pair} ${fibSig.direction}: ${msg}`);
      }
    }

    return;
  }

  if (botType === "session-breakout") {
    const candles1H = await cache.getCandles(pair, "1H", 200);
    const sbTunables = ctx.botInstance ? pickSessionBreakoutTunables(ctx.botInstance.settings) : {};
    const sbSig = detectSessionBreakoutSignal(candles1H, sbTunables);
    if (!sbSig) return;
    if (sbSig.score < ctx.minConfidenceScore) return;

    result.signalsFound++;

    const lots = calcLots(ctx.riskAmount, pair, sbSig.entryPrice, sbSig.stopLoss);
    if (lots <= 0) return;

    const signal: BotSignal = {
      id:               crypto.randomUUID(),
      botId,
      pair,
      direction:        sbSig.direction,
      entryPrice:       sbSig.entryPrice,
      stopLoss:         sbSig.stopLoss,
      takeProfit:       sbSig.takeProfit,
      lots,
      score:            sbSig.score,
      recommendationId: null,
      reasons:          sbSig.reasons,
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
      signalType:       "session_breakout",
      signalTimeframe:  "1H",
      signalConfidence: sbSig.score,
      trend:            sbSig.direction === "buy" ? "bullish" : "bearish",
      structure:        null,
      mtfBias:          null,
      mtfLabel:         null,
      atr:              null,
      inAoi:            false,
      fibLabel:         null,
      tradeClass:       "session-breakout",
      zoneType:         null,
      patternType:      null,
      outcome:          null,
      closePrice:       null,
      closeTime:        null,
      pnlPips:          null,
      pnlGbp:           null,
      lineType:         null,
      lineP1Ts:         null,
      lineP2Ts:         null,
      zoneLow:          sbSig.sessionLow,
      zoneHigh:         sbSig.sessionHigh,
    };

    if (mode === "approval") {
      await saveBotSignal(env.DB, signal);
      result.signalsQueued++;
    } else {
      try {
        if (!ctx.trading) throw new Error("No cTrader token");
        await saveBotSignal(env.DB, signal);
        await executeSignal(signal, env.DB, env.KV, ctx.trading, "market");
        ctx.openCount++;
        ctx.openPositionPairs.add(pair);
        result.signalsExecuted++;
      } catch (e) {
        const msg = (e as Error).message;
        await updateBotSignalStatus(env.DB, signal.id, "failed", { errorMessage: msg });
        result.signalsFailed++;
        result.errors.push(`${pair} ${sbSig.direction}: ${msg}`);
      }
    }

    return;
  }
}

// ── Main orchestrator — pair-outer, bot-inner ─────────────────────────────────
// Every bot's account/sizing/tuning context is resolved once up front (buildBotContext),
// then every pair any bot targets is visited once, evaluating each bot that targets it in
// turn. Two bots sharing a pair (same type or different) now share one candle fetch per
// (pair, timeframe, count) instead of each independently refetching it, and — since there's
// no per-bot network round-trip between them any more — effectively evaluate and enter that
// pair at the same instant rather than however many pairs apart the old bot-outer loop order
// happened to put them.
export async function runBotScans(
  env:  Env,
  bots: (BotInstance | undefined)[],
): Promise<Map<string, BotRunResult>> {
  const results  = new Map<string, BotRunResult>();
  const contexts = new Map<string, BotContext>();

  for (const bot of bots) {
    const key = bot?.id ?? "legacy";
    const built = await buildBotContext(env, bot);
    if ("doneResult" in built) { results.set(key, built.doneResult); continue; }
    contexts.set(key, built.ctx);
  }

  // One shared connection for the whole scan's candle fetching — candle history isn't
  // account-specific, so any bot's connected TradingService can serve every bot's data needs
  // this tick. Each bot still places its own trades through its own account's connection
  // (ctx.trading), unaffected by this.
  const sharedTrading = [...contexts.values()]
    .map(c => c.trading)
    .find((t): t is TradingService => t !== null);
  const cache = sharedTrading
    ? new ScanCandleCache(createMarketDataProvider({ provider: env.MARKET_DATA_PROVIDER, trading: sharedTrading }))
    : null;

  if (cache) {
    for (const ctx of contexts.values()) {
      if (!ctx.dxyFilter.isEnabled()) continue;
      try { await ctx.dxyFilter.refreshRegime(cache); } catch { /* isTradeAllowed degrades gracefully with no regime set */ }
    }
  }

  const allPairs = new Set<CurrencyPair>();
  for (const ctx of contexts.values()) for (const pair of ctx.targetPairs) allPairs.add(pair);

  for (const pair of allPairs) {
    for (const ctx of contexts.values()) {
      if (!ctx.targetPairs.includes(pair)) continue;

      ctx.result.pairsScanned++;
      try {
        if (!ctx.allowDuplicatePairs && ctx.openPositionPairs.has(pair)) continue;
        if (ctx.openCount >= ctx.maxOpenPositions) continue;

        const lastExecuted = await env.KV.get(`bot:last_executed:${ctx.botId}:${pair}`);
        if (lastExecuted && Date.now() - parseInt(lastExecuted) < 4 * 60 * 60 * 1000) continue;

        if (!cache) throw new Error("cTrader not connected — no data source available to fetch candles");
        await scanPairForBot(env, ctx, pair, cache);
      } catch (e) {
        ctx.result.errors.push(`${pair}: ${(e as Error).message}`);
      }
    }
  }

  for (const [key, ctx] of contexts) results.set(key, ctx.result);
  return results;
}

// Back-compat single-bot entry point — used by the per-bot manual "Scan" button, where
// there's nothing to batch against.
export async function runBotScan(env: Env & { botInstance?: BotInstance }): Promise<BotRunResult> {
  const { botInstance, ...rest } = env;
  const key = botInstance?.id ?? "legacy";
  const results = await runBotScans(rest, [botInstance]);
  return results.get(key) ?? {
    pairsScanned: 0, signalsFound: 0, signalsQueued: 0, signalsExecuted: 0, signalsFailed: 0,
    errors: ["Unknown error — no result produced"],
  };
}
