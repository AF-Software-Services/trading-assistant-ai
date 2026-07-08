import { PHASE1_PAIRS }                    from "../types/market.ts";
import type { CurrencyPair }               from "../types/market.ts";
import type { BotInstance }                from "./bot-types.ts";
import { createMarketDataProvider }        from "../providers/factory.ts";
import { detectTrendlineSignal }           from "../engines/trendline.ts";
import { storeTrendlineTrailState }        from "./monitor.ts";
import { TradingService }                   from "../trading/service.ts";
import { createJournalEntry, buildFeaturesFromContext } from "../storage/journal.ts";

export interface BotSettings {
  mode:               "off" | "approval" | "autonomous";
  minConfidenceScore: number;   // 0-100, default 65
  minConfluence:      number;   // S/R levels required for AOI, default 2
  maxOpenPositions:   number;   // default 2
  dailyLossLimitPct:  number;   // default 2
  allowedSessions:    string[]; // which UTC sessions to trade
  pairs:              string[]; // subset of PHASE1_PAIRS to trade, empty = all
}

export interface BotSignal {
  id:                 string;
  botId:              string;
  pair:               CurrencyPair;
  direction:          "buy" | "sell";
  entryPrice:         number;
  stopLoss:           number;
  takeProfit:         number;
  lots:               number;
  score:              number;
  recommendationId:   string | null;
  reasons:            string[];
  status:             "pending" | "approved" | "rejected" | "executed" | "expired" | "failed";
  createdAt:          number;
  expiresAt:          number;
  executedAt:         number | null;
  ctraderPositionId:  number | null;
  journalId:          string | null;
  rejectionReason:    string | null;
  errorMessage:       string | null;
  // Source
  source:             'live' | 'backtest';
  backtestRunId:      string | null;
  // ML features
  signalType:         string | null;
  signalTimeframe:    string | null;
  signalConfidence:   number | null;
  trend:              string | null;
  structure:          string | null;
  mtfBias:            string | null;
  mtfLabel:           string | null;
  atr:                number | null;
  inAoi:              boolean;
  fibLabel:           string | null;
  tradeClass:         string | null;
  zoneType:           string | null;
  patternType:        string | null;
  // Outcome (filled when trade closes)
  outcome:            'tp' | 'sl' | 'expired' | null;
  closePrice:         number | null;
  closeTime:          number | null;
  pnlPips:            number | null;
  pnlGbp:             number | null;
}

export interface BotRunResult {
  pairsScanned:   number;
  signalsFound:   number;
  signalsQueued:  number;  // approval mode
  signalsExecuted:number;  // autonomous mode
  signalsFailed:  number;
  errors:         string[];
  warnings?:      string[];
}

// Approximate GBP pip value per standard lot — conservative, slightly under real value
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
  const stopPips  = Math.abs(entryPrice - stopLoss) * pipFactor(pair);
  const pipVal    = PIP_VALUE_GBP[pair] ?? 7.50;
  if (stopPips <= 0 || pipVal <= 0) return 0.01;
  const raw = riskAmountGBP / (stopPips * pipVal);
  // Round down to 0.01 lot precision, clamp between 0.01 and 10 lots
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

// ── KV helpers ────────────────────────────────────────────────────────────────

export async function getBotSettings(kv: KVNamespace): Promise<BotSettings> {
  const saved = await kv.get("bot:settings", "json") as Partial<BotSettings> | null;
  return {
    mode:              saved?.mode              ?? "off",
    minConfidenceScore: saved?.minConfidenceScore ?? 60,
    minConfluence:      saved?.minConfluence      ?? 2,
    maxOpenPositions:  saved?.maxOpenPositions  ?? 2,
    dailyLossLimitPct: saved?.dailyLossLimitPct ?? 2,
    allowedSessions:   saved?.allowedSessions   ?? ["london", "ny", "overlap_london_ny"],
    pairs:             saved?.pairs             ?? [],
  };
}

export async function saveBotSettings(kv: KVNamespace, settings: Partial<BotSettings>): Promise<BotSettings> {
  const current = await getBotSettings(kv);
  const updated = { ...current, ...settings };
  await kv.put("bot:settings", JSON.stringify(updated));
  return updated;
}

// ── D1 helpers ────────────────────────────────────────────────────────────────

export async function saveBotSignal(db: D1Database, signal: BotSignal): Promise<void> {
  await db.prepare(
    `INSERT INTO bot_signals
       (id, bot_id, pair, direction, entry_price, stop_loss, take_profit, lots, score,
        recommendation_id, reasons_json, status, created_at, expires_at,
        executed_at, ctrader_position_id, journal_id, rejection_reason, error_message,
        source, backtest_run_id,
        signal_type, signal_timeframe, signal_confidence,
        trend, structure, mtf_bias, mtf_label, atr, in_aoi,
        fib_label, trade_class, zone_type, pattern_type,
        outcome, close_price, close_time, pnl_pips, pnl_gbp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status               = excluded.status,
       executed_at          = excluded.executed_at,
       ctrader_position_id  = excluded.ctrader_position_id,
       journal_id           = excluded.journal_id,
       rejection_reason     = excluded.rejection_reason,
       error_message        = excluded.error_message,
       outcome              = excluded.outcome,
       close_price          = excluded.close_price,
       close_time           = excluded.close_time,
       pnl_pips             = excluded.pnl_pips,
       pnl_gbp              = excluded.pnl_gbp`
  ).bind(
    signal.id, signal.botId, signal.pair, signal.direction,
    signal.entryPrice, signal.stopLoss, signal.takeProfit,
    signal.lots, signal.score,
    signal.recommendationId ?? null,
    JSON.stringify(signal.reasons),
    signal.status,
    signal.createdAt, signal.expiresAt,
    signal.executedAt ?? null,
    signal.ctraderPositionId ?? null,
    signal.journalId ?? null,
    signal.rejectionReason ?? null,
    signal.errorMessage ?? null,
    signal.source,
    signal.backtestRunId ?? null,
    signal.signalType ?? null,
    signal.signalTimeframe ?? null,
    signal.signalConfidence ?? null,
    signal.trend ?? null,
    signal.structure ?? null,
    signal.mtfBias ?? null,
    signal.mtfLabel ?? null,
    signal.atr ?? null,
    signal.inAoi ? 1 : 0,
    signal.fibLabel ?? null,
    signal.tradeClass ?? null,
    signal.zoneType ?? null,
    signal.patternType ?? null,
    signal.outcome ?? null,
    signal.closePrice ?? null,
    signal.closeTime ?? null,
    signal.pnlPips ?? null,
    signal.pnlGbp ?? null,
  ).run();
}

export async function recordBotSignalOutcome(
  db: D1Database,
  id: string,
  outcome: 'tp' | 'sl' | 'expired',
  closePrice: number,
  closeTime: number,
  pnlPips: number,
  pnlGbp: number,
): Promise<void> {
  await db.prepare(
    `UPDATE bot_signals
     SET outcome     = ?,
         close_price = ?,
         close_time  = ?,
         pnl_pips    = ?,
         pnl_gbp     = ?
     WHERE id = ?`
  ).bind(outcome, closePrice, closeTime, pnlPips, pnlGbp, id).run();
}

export async function getBotSignals(
  db: D1Database,
  opts: { status?: string; limit?: number; source?: string; botId?: string } = {}
): Promise<BotSignal[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
  if (opts.source) { conditions.push("source = ?"); params.push(opts.source); }
  if (opts.botId)  { conditions.push("bot_id = ?"); params.push(opts.botId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(opts.limit ?? 50);
  const rows = await db.prepare(
    `SELECT * FROM bot_signals ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...params).all<Record<string, unknown>>();
  return rows.results.map(rowToSignal);
}

export async function updateBotSignalStatus(
  db: D1Database,
  id: string,
  status: BotSignal["status"],
  extra: Partial<Pick<BotSignal, "executedAt" | "ctraderPositionId" | "journalId" | "rejectionReason" | "errorMessage">> = {}
): Promise<void> {
  await db.prepare(
    `UPDATE bot_signals
     SET status              = ?,
         executed_at         = COALESCE(?, executed_at),
         ctrader_position_id = COALESCE(?, ctrader_position_id),
         journal_id          = COALESCE(?, journal_id),
         rejection_reason    = COALESCE(?, rejection_reason),
         error_message       = COALESCE(?, error_message)
     WHERE id = ?`
  ).bind(
    status,
    extra.executedAt          ?? null,
    extra.ctraderPositionId   ?? null,
    extra.journalId           ?? null,
    extra.rejectionReason     ?? null,
    extra.errorMessage        ?? null,
    id
  ).run();
}

function rowToSignal(row: Record<string, unknown>): BotSignal {
  return {
    id:                row["id"]                   as string,
    botId:             (row["bot_id"]              as string | null) ?? "legacy",
    pair:              row["pair"]                 as CurrencyPair,
    direction:         row["direction"]            as "buy" | "sell",
    entryPrice:        row["entry_price"]          as number,
    stopLoss:          row["stop_loss"]            as number,
    takeProfit:        row["take_profit"]          as number,
    lots:              row["lots"]                 as number,
    score:             row["score"]                as number,
    recommendationId:  (row["recommendation_id"]  as string | null) ?? null,
    reasons:           JSON.parse(row["reasons_json"] as string) as string[],
    status:            row["status"]               as BotSignal["status"],
    createdAt:         row["created_at"]           as number,
    expiresAt:         row["expires_at"]           as number,
    executedAt:        (row["executed_at"]         as number | null) ?? null,
    ctraderPositionId: (row["ctrader_position_id"] as number | null) ?? null,
    journalId:         (row["journal_id"]          as string | null) ?? null,
    rejectionReason:   (row["rejection_reason"]    as string | null) ?? null,
    errorMessage:      (row["error_message"]       as string | null) ?? null,
    source:            ((row["source"] as string | null) ?? "live") as 'live' | 'backtest',
    backtestRunId:     (row["backtest_run_id"]     as string | null) ?? null,
    signalType:        (row["signal_type"]         as string | null) ?? null,
    signalTimeframe:   (row["signal_timeframe"]    as string | null) ?? null,
    signalConfidence:  (row["signal_confidence"]   as number | null) ?? null,
    trend:             (row["trend"]               as string | null) ?? null,
    structure:         (row["structure"]           as string | null) ?? null,
    mtfBias:           (row["mtf_bias"]            as string | null) ?? null,
    mtfLabel:          (row["mtf_label"]           as string | null) ?? null,
    atr:               (row["atr"]                 as number | null) ?? null,
    inAoi:             !!(row["in_aoi"]            as number | null),
    fibLabel:          (row["fib_label"]           as string | null) ?? null,
    tradeClass:        (row["trade_class"]         as string | null) ?? null,
    zoneType:          (row["zone_type"]           as string | null) ?? null,
    patternType:       (row["pattern_type"]        as string | null) ?? null,
    outcome:           (row["outcome"]             as 'tp' | 'sl' | 'expired' | null) ?? null,
    closePrice:        (row["close_price"]         as number | null) ?? null,
    closeTime:         (row["close_time"]          as number | null) ?? null,
    pnlPips:           (row["pnl_pips"]            as number | null) ?? null,
    pnlGbp:            (row["pnl_gbp"]             as number | null) ?? null,
  };
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

  // Log to journal with full feature capture
  const features = buildFeaturesFromContext({
    signalType:     signal.reasons[0] ?? "bot_signal",
    rrRatio:        Math.abs(signal.takeProfit - signal.entryPrice) / Math.abs(signal.entryPrice - signal.stopLoss),
    stopPips:       Math.abs(signal.entryPrice - signal.stopLoss) * pipFactor(signal.pair),
    totalScore:     signal.score,
    aoiConfirmed:   true,  // bot only trades AOI-confirmed setups
    candles4h:      [],
    candlesD:       [],
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

  // cooldown key uses signal.botId so each bot has its own per-pair cooldown
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

  // Resolve settings: prefer botInstance, fall back to legacy KV settings
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

  // Session gate (skipped for manual scans)
  const session = getCurrentSession();
  if (!env.skipSessionGate) {
    const settings = await getBotSettings(env.KV);
    if (!settings.allowedSessions.includes(session)) {
      result.errors.push(`Session ${session} not in allowed list`);
      return result;
    }
  }

  // Risk settings — bot-level overrides system-level
  const riskSettings = await env.KV.get("user:risk_settings", "json") as
    { accountBalance?: number; riskPercent?: number; rewardRisk?: number } | null;
  const accountBalance = riskSettings?.accountBalance ?? 1000;
  const botSettings    = env.botInstance?.settings ?? {};
  const riskPercent    = (botSettings["riskPercent"] as number | undefined) ?? riskSettings?.riskPercent ?? 1;
  const rrRatio        = (botSettings["rewardRisk"]  as number | undefined) ?? riskSettings?.rewardRisk  ?? 1.5;
  const riskAmount     = accountBalance * riskPercent / 100;

  // cTrader connection — required for autonomous, optional for approval
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

  // Cancel and expire old pending signals that had limit orders placed
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

  // Expire pending signals that were never executed (approval mode, not yet approved)
  await env.DB.prepare(
    `UPDATE bot_signals SET status = 'expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).bind(Date.now()).run();

  const provider = createMarketDataProvider({
    provider: env.MARKET_DATA_PROVIDER,
    apiKey: env.TWELVE_DATA_API_KEY || undefined,
    kv: env.KV,
  });

  const targetPairs = targetPairsOverride ?? (PHASE1_PAIRS as CurrencyPair[]);

  for (const pair of targetPairs) {
    result.pairsScanned++;

    try {
      // Skip if already have a position on this pair
      if (openPositionPairs.has(pair)) continue;

      // Skip if at max positions (2 per bot)
      if (openCount >= 2) break;

      // Check cooldown — don't trade same pair twice in 4 hours (per bot)
      const lastExecuted = await env.KV.get(`bot:last_executed:${botId}:${pair}`);
      if (lastExecuted && Date.now() - parseInt(lastExecuted) < 4 * 60 * 60 * 1000) continue;

      // ── Trendline Bot ───────────────────────────────────────────────────────
      if (botType === "trendline") {
        const [candles4H, candlesD] = await Promise.all([
          provider.getCandles(pair, "4H",   200),
          provider.getCandles(pair, "1day",  30),
        ]);
        const tlSig = detectTrendlineSignal(candles4H, rrRatio, 5, candlesD);

        if (!tlSig) {
          // Secondary pass without daily bias — distinguishes "no pattern" from "bias filtered"
          const tlNoBias = detectTrendlineSignal(candles4H, rrRatio, 5, undefined);
          if (tlNoBias) {
            // Pattern exists but filtered by daily bias — save as rejected for review
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
            // Store safety line so monitor can project it forward each tick
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

        continue; // next pair
      }
    } catch (e) {
      result.errors.push(`${pair}: ${(e as Error).message}`);
    }
  }

  return result;
}
