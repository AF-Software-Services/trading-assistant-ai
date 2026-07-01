import type { CurrencyPair } from "../types/market.ts";
import type { CandlestickSignal } from "../types/trading.ts";

export interface PairStats {
  pair: CurrencyPair;
  totalRecommendations: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;          // 0–1
  avgRewardRisk: number;
  avgConfidence: number;
  openCount: number;
}

export interface StrategyStats {
  totalRecommendations: number;
  totalClosed: number;
  totalOpen: number;
  overallWinRate: number;   // 0–1
  avgConfidence: number;
  avgRewardRisk: number;
  bestPair: CurrencyPair | null;
  worstPair: CurrencyPair | null;
  totalPnlGbp: number;
}

export interface SignalRecord {
  id: string;
  pair: CurrencyPair;
  timeframe: string;
  type: string;
  timestamp: number;
  price: number;
  confidence: number;
  createdAt: number;
}

export async function getPairPerformance(
  db: D1Database,
  pair: CurrencyPair
): Promise<PairStats> {
  const result = await db
    .prepare(
      `SELECT
         COUNT(*)                                                    AS total,
         SUM(CASE WHEN outcome = 'win'       THEN 1 ELSE 0 END)    AS wins,
         SUM(CASE WHEN outcome = 'loss'      THEN 1 ELSE 0 END)    AS losses,
         SUM(CASE WHEN outcome = 'breakeven' THEN 1 ELSE 0 END)    AS breakevens,
         AVG(reward_risk_ratio)                                      AS avg_rr,
         AVG(confidence)                                            AS avg_confidence,
         SUM(CASE WHEN status = 'open'       THEN 1 ELSE 0 END)    AS open_count
       FROM recommendations
       WHERE pair = ?`
    )
    .bind(pair)
    .first<{
      total: number;
      wins: number;
      losses: number;
      breakevens: number;
      avg_rr: number;
      avg_confidence: number;
      open_count: number;
    }>();

  const total = result?.total ?? 0;
  const wins  = result?.wins  ?? 0;

  return {
    pair,
    totalRecommendations: total,
    wins,
    losses:     result?.losses     ?? 0,
    breakevens: result?.breakevens ?? 0,
    winRate:    total > 0 ? wins / total : 0,
    avgRewardRisk:  result?.avg_rr        ?? 0,
    avgConfidence:  result?.avg_confidence ?? 0,
    openCount:  result?.open_count ?? 0,
  };
}

export async function getStrategyStats(db: D1Database): Promise<StrategyStats> {
  const overall = await db
    .prepare(
      `SELECT
         COUNT(*)                                                 AS total,
         SUM(CASE WHEN status != 'open'  THEN 1 ELSE 0 END)     AS closed,
         SUM(CASE WHEN status  = 'open'  THEN 1 ELSE 0 END)     AS open,
         SUM(CASE WHEN outcome = 'win'   THEN 1 ELSE 0 END)     AS wins,
         AVG(confidence)                                         AS avg_confidence,
         AVG(reward_risk_ratio)                                  AS avg_rr
       FROM recommendations`
    )
    .first<{
      total: number;
      closed: number;
      open: number;
      wins: number;
      avg_confidence: number;
      avg_rr: number;
    }>();

  const total  = overall?.total  ?? 0;
  const closed = overall?.closed ?? 0;
  const wins   = overall?.wins   ?? 0;

  // Best and worst pair by win rate
  const pairRows = await db
    .prepare(
      `SELECT pair,
              SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate
       FROM recommendations
       WHERE status != 'open'
       GROUP BY pair
       ORDER BY win_rate DESC`
    )
    .all<{ pair: CurrencyPair; win_rate: number }>();

  const pairData = pairRows.results;
  const bestPair  = pairData[0]?.pair ?? null;
  const worstPair = pairData.length > 0 ? (pairData[pairData.length - 1]?.pair ?? null) : null;

  // Total PnL (sum of trade_journal pnl)
  const pnlRow = await db
    .prepare(`SELECT COALESCE(SUM(pnl), 0) AS total_pnl FROM trade_journal`)
    .first<{ total_pnl: number }>();

  return {
    totalRecommendations: total,
    totalClosed: closed,
    totalOpen:   overall?.open ?? 0,
    overallWinRate: closed > 0 ? wins / closed : 0,
    avgConfidence:  overall?.avg_confidence ?? 0,
    avgRewardRisk:  overall?.avg_rr         ?? 0,
    bestPair,
    worstPair,
    totalPnlGbp: pnlRow?.total_pnl ?? 0,
  };
}

export async function getRecentSignals(
  db: D1Database,
  limit: number = 50
): Promise<SignalRecord[]> {
  const rows = await db
    .prepare(
      `SELECT id, pair, timeframe, type, timestamp, price, confidence, created_at
       FROM signals
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      id: string;
      pair: CurrencyPair;
      timeframe: string;
      type: string;
      timestamp: number;
      price: number;
      confidence: number;
      created_at: number;
    }>();

  return rows.results.map(r => ({
    id:         r.id,
    pair:       r.pair,
    timeframe:  r.timeframe,
    type:       r.type,
    timestamp:  r.timestamp,
    price:      r.price,
    confidence: r.confidence,
    createdAt:  r.created_at,
  }));
}
