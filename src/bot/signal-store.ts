import type { CurrencyPair } from "../types/market.ts";

export interface BotSettings {
  mode:               "off" | "approval" | "autonomous";
  minConfidenceScore: number;
  minConfluence:      number;
  maxOpenPositions:   number;
  dailyLossLimitPct:  number;
  allowedSessions:    string[];
  pairs:              string[];
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
  source:             'live' | 'backtest';
  backtestRunId:      string | null;
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
  outcome:            'tp' | 'sl' | 'expired' | null;
  closePrice:         number | null;
  closeTime:          number | null;
  pnlPips:            number | null;
  pnlGbp:             number | null;
}

// ── KV helpers ────────────────────────────────────────────────────────────────

export async function getBotSettings(kv: KVNamespace): Promise<BotSettings> {
  const saved = await kv.get("bot:settings", "json") as Partial<BotSettings> | null;
  return {
    mode:               saved?.mode               ?? "off",
    minConfidenceScore: saved?.minConfidenceScore ?? 60,
    minConfluence:      saved?.minConfluence      ?? 2,
    maxOpenPositions:   saved?.maxOpenPositions   ?? 2,
    dailyLossLimitPct:  saved?.dailyLossLimitPct  ?? 2,
    allowedSessions:    saved?.allowedSessions    ?? ["london", "ny", "overlap_london_ny"],
    pairs:              saved?.pairs              ?? [],
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

export async function getBotSignal(db: D1Database, id: string): Promise<BotSignal | null> {
  const row = await db.prepare(
    "SELECT * FROM bot_signals WHERE id = ?"
  ).bind(id).first<Record<string, unknown>>();
  return row ? rowToSignal(row) : null;
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
