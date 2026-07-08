import type { CurrencyPair } from "../types/market.ts";

export interface TradeFeatures {
  // MTF alignment
  mtfScore: number;           // 0-3 (how many TFs aligned)
  mtfAligned: boolean;        // true if Weekly + Daily agree

  // Entry signal
  signalType: string;         // 'morning_star', 'hammer', 'shooting_star', etc.
  signalConfidence: number;   // 0-1

  // Zone context at entry
  zoneStrength: number;       // 0-100
  zoneType: string;           // 'support' | 'resistance'
  zoneTimeframe: string;      // 'W' | 'D' | '4H'
  aoiConfirmed: boolean;

  // Risk parameters
  rrRatio: number;
  atrPips: number;
  stopPips: number;

  // Timing
  session: string;            // 'london' | 'ny' | 'asian' | 'overlap'
  dayOfWeek: number;          // 0=Sun..6=Sat
  hour: number;               // UTC hour 0-23

  // Market structure
  swingStructure: string;     // 'uptrend' | 'downtrend' | 'ranging'
  trendStrength: number;      // 0-1

  // News context
  newsSentiment: string;      // 'bullish' | 'bearish' | 'neutral'
  newsCount: number;

  // Overall score
  totalScore: number;         // recommendation confidence 0-100

  // Candle snapshots for future deep learning (normalised OHLC as ratio to ATR)
  candles4h: Array<{ o: number; h: number; l: number; c: number }>;
  candlesD: Array<{ o: number; h: number; l: number; c: number }>;
}

export interface JournalEntry {
  id: string;
  recommendationId: string | null;
  pair: CurrencyPair;
  direction: "buy" | "sell";
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  confidence: number;
  session: string;
  dayOfWeek: number;
  features: TradeFeatures | null;
  notes: string | null;
  result: "win" | "loss" | "breakeven" | null;
  exitPrice: number | null;
  pnlPips: number | null;
  rrAchieved: number | null;
  pnl: number | null;
  createdAt: number;
  closedAt: number | null;
}

export interface JournalStats {
  totalTrades: number;
  completedTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;           // 0-1
  avgRrAchieved: number;
  avgRrTargeted: number;
  totalPnlPips: number;
  byPair: Record<string, { trades: number; wins: number; winRate: number }>;
  bySignal: Record<string, { trades: number; wins: number; winRate: number }>;
  bySession: Record<string, { trades: number; wins: number; winRate: number }>;
  byDayOfWeek: Record<number, { trades: number; wins: number; winRate: number }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSession(hour: number): string {
  // UTC hours approximate session times
  if (hour >= 7 && hour < 9) return "overlap_asian_london";
  if (hour >= 9 && hour < 12) return "london";
  if (hour >= 12 && hour < 13) return "overlap_london_ny";
  if (hour >= 13 && hour < 17) return "ny";
  if (hour >= 17 && hour < 21) return "ny_late";
  if (hour >= 23 || hour < 3) return "asian";
  return "off_hours";
}

export function buildFeaturesFromContext(ctx: {
  mtfScore?: number;
  mtfAligned?: boolean;
  signalType?: string;
  signalConfidence?: number;
  zoneStrength?: number;
  zoneType?: string;
  zoneTimeframe?: string;
  aoiConfirmed?: boolean;
  rrRatio?: number;
  atrPips?: number;
  stopPips?: number;
  swingStructure?: string;
  trendStrength?: number;
  newsSentiment?: string;
  newsCount?: number;
  totalScore?: number;
  candles4h?: Array<{ open: number; high: number; low: number; close: number }>;
  candlesD?: Array<{ open: number; high: number; low: number; close: number }>;
}): TradeFeatures {
  const now = new Date();
  const hour = now.getUTCHours();

  // Normalise candles to last-close-relative values so prices are scale-invariant
  const normalise = (
    candles: Array<{ open: number; high: number; low: number; close: number }>,
    limit: number
  ) => {
    const slice = candles.slice(-limit);
    const ref = slice[slice.length - 1]?.close ?? 1;
    return slice.map(c => ({
      o: Number(((c.open  - ref) / ref * 10000).toFixed(1)),
      h: Number(((c.high  - ref) / ref * 10000).toFixed(1)),
      l: Number(((c.low   - ref) / ref * 10000).toFixed(1)),
      c: Number(((c.close - ref) / ref * 10000).toFixed(1)),
    }));
  };

  return {
    mtfScore:         ctx.mtfScore         ?? 0,
    mtfAligned:       ctx.mtfAligned       ?? false,
    signalType:       ctx.signalType       ?? "unknown",
    signalConfidence: ctx.signalConfidence ?? 0,
    zoneStrength:     ctx.zoneStrength     ?? 0,
    zoneType:         ctx.zoneType         ?? "unknown",
    zoneTimeframe:    ctx.zoneTimeframe    ?? "unknown",
    aoiConfirmed:     ctx.aoiConfirmed     ?? false,
    rrRatio:          ctx.rrRatio          ?? 0,
    atrPips:          ctx.atrPips          ?? 0,
    stopPips:         ctx.stopPips         ?? 0,
    session:          getSession(hour),
    dayOfWeek:        now.getUTCDay(),
    hour,
    swingStructure:   ctx.swingStructure   ?? "unknown",
    trendStrength:    ctx.trendStrength    ?? 0,
    newsSentiment:    ctx.newsSentiment    ?? "neutral",
    newsCount:        ctx.newsCount        ?? 0,
    totalScore:       ctx.totalScore       ?? 0,
    candles4h:        normalise(ctx.candles4h ?? [], 10),
    candlesD:         normalise(ctx.candlesD  ?? [], 5),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createJournalEntry(
  db: D1Database,
  entry: Omit<JournalEntry, "id" | "result" | "exitPrice" | "pnlPips" | "rrAchieved" | "pnl" | "closedAt">
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO trade_journal (
         id, recommendation_id, pair, direction, timeframe,
         entry_price, stop_loss, target, confidence,
         session, day_of_week, features_json, notes,
         result, exit_price, pnl_pips, rr_achieved, pnl,
         created_at, closed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`
    )
    .bind(
      id,
      entry.recommendationId ?? null,
      entry.pair,
      entry.direction,
      entry.timeframe ?? "4H",
      entry.entryPrice,
      entry.stopLoss,
      entry.target,
      entry.confidence,
      entry.session,
      entry.dayOfWeek,
      entry.features ? JSON.stringify(entry.features) : null,
      entry.notes ?? null,
      entry.createdAt,
    )
    .run();
  return id;
}

export async function updateJournalOutcome(
  db: D1Database,
  id: string,
  outcome: { result: "win" | "loss" | "breakeven"; exitPrice: number; notes?: string }
): Promise<void> {
  const entry = await getJournalEntry(db, id);
  if (!entry) throw new Error(`Journal entry ${id} not found`);

  const pipFactor = entry.pair.includes("JPY") ? 100 : 10000;
  const d = entry.direction === "buy" ? 1 : -1;
  const pnlPips = (outcome.exitPrice - entry.entryPrice) * pipFactor * d;
  const stopPips = Math.abs(entry.entryPrice - entry.stopLoss) * pipFactor;
  const rrAchieved = stopPips > 0 ? pnlPips / stopPips : 0;

  await db
    .prepare(
      `UPDATE trade_journal
       SET result = ?, exit_price = ?, pnl_pips = ?, rr_achieved = ?,
           closed_at = ?, notes = COALESCE(?, notes)
       WHERE id = ?`
    )
    .bind(
      outcome.result,
      outcome.exitPrice,
      Number(pnlPips.toFixed(1)),
      Number(rrAchieved.toFixed(2)),
      Date.now(),
      outcome.notes ?? null,
      id
    )
    .run();
}

export async function getJournalEntry(
  db: D1Database,
  id: string
): Promise<JournalEntry | null> {
  const row = await db
    .prepare(`SELECT * FROM trade_journal WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToEntry(row) : null;
}

export async function getJournalEntries(
  db: D1Database,
  opts: { pair?: string; limit?: number; offset?: number; openOnly?: boolean } = {}
): Promise<JournalEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.pair) { conditions.push("pair = ?"); params.push(opts.pair); }
  if (opts.openOnly) { conditions.push("result IS NULL"); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = await db
    .prepare(
      `SELECT * FROM trade_journal ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<Record<string, unknown>>();

  return rows.results.map(rowToEntry);
}

export async function getJournalStats(db: D1Database): Promise<JournalStats> {
  const rows = await db
    .prepare(
      `SELECT pair, direction, result, pnl_pips, rr_achieved, features_json,
              session, day_of_week, target, entry_price, stop_loss
       FROM trade_journal`
    )
    .all<Record<string, unknown>>();

  const all = rows.results;
  const completed = all.filter(r => r["result"] !== null);
  const wins   = completed.filter(r => r["result"] === "win").length;
  const losses = completed.filter(r => r["result"] === "loss").length;
  const bes    = completed.filter(r => r["result"] === "breakeven").length;

  const avgRrAchieved = completed.length > 0
    ? completed.reduce((s, r) => s + (Number(r["rr_achieved"]) || 0), 0) / completed.length
    : 0;

  const pf = (pair: string): number => pair.includes("JPY") ? 100 : 10000;
  const avgRrTargeted = all.length > 0
    ? all.reduce((s, r) => {
        const ep = Number(r["entry_price"]);
        const sl = Number(r["stop_loss"]);
        const tp = Number(r["target"]);
        const stop = Math.abs(ep - sl) * pf(r["pair"] as string);
        const reward = Math.abs(tp - ep) * pf(r["pair"] as string);
        return s + (stop > 0 ? reward / stop : 0);
      }, 0) / all.length
    : 0;

  const totalPnlPips = completed.reduce((s, r) => s + (Number(r["pnl_pips"]) || 0), 0);

  const group = (
    key: (r: Record<string, unknown>) => string | number,
    set: Record<string, unknown>[]
  ) => {
    const map: Record<string, { trades: number; wins: number; winRate: number }> = {};
    for (const r of set) {
      const k = String(key(r));
      if (!map[k]) map[k] = { trades: 0, wins: 0, winRate: 0 };
      map[k].trades++;
      if (r["result"] === "win") map[k].wins++;
    }
    for (const v of Object.values(map)) {
      v.winRate = v.trades > 0 ? v.wins / v.trades : 0;
    }
    return map;
  };

  const signalOf = (r: Record<string, unknown>) => {
    try {
      const f = JSON.parse(r["features_json"] as string) as TradeFeatures;
      return f.signalType ?? "unknown";
    } catch { return "unknown"; }
  };

  return {
    totalTrades:    all.length,
    completedTrades: completed.length,
    wins,
    losses,
    breakevens: bes,
    winRate:       completed.length > 0 ? wins / completed.length : 0,
    avgRrAchieved: Number(avgRrAchieved.toFixed(2)),
    avgRrTargeted: Number(avgRrTargeted.toFixed(2)),
    totalPnlPips:  Number(totalPnlPips.toFixed(1)),
    byPair:        group(r => r["pair"] as string, all) as JournalStats["byPair"],
    bySignal:      group(signalOf, all)               as JournalStats["bySignal"],
    bySession:     group(r => r["session"] as string, all) as JournalStats["bySession"],
    byDayOfWeek:   group(r => r["day_of_week"] as number, all) as JournalStats["byDayOfWeek"],
  };
}

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id:               row["id"]               as string,
    recommendationId: (row["recommendation_id"] as string | null) ?? null,
    pair:             row["pair"]             as CurrencyPair,
    direction:        row["direction"]        as "buy" | "sell",
    timeframe:        (row["timeframe"] as string) ?? "4H",
    entryPrice:       row["entry_price"]      as number,
    stopLoss:         row["stop_loss"]        as number,
    target:           row["target"]           as number,
    confidence:       row["confidence"]       as number,
    session:          (row["session"] as string) ?? "unknown",
    dayOfWeek:        (row["day_of_week"] as number) ?? 0,
    features:         row["features_json"]
                        ? JSON.parse(row["features_json"] as string) as TradeFeatures
                        : null,
    notes:            (row["notes"] as string | null) ?? null,
    result:           (row["result"] as JournalEntry["result"]) ?? null,
    exitPrice:        (row["exit_price"] as number | null) ?? null,
    pnlPips:          (row["pnl_pips"] as number | null) ?? null,
    rrAchieved:       (row["rr_achieved"] as number | null) ?? null,
    pnl:              (row["pnl"] as number | null) ?? null,
    createdAt:        row["created_at"]       as number,
    closedAt:         (row["closed_at"] as number | null) ?? null,
  };
}
