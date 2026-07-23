import type { CurrencyPair } from "../types/market.ts";

export interface TrendlineV2Line {
  id:            string;
  botId:         string;
  pair:          CurrencyPair;
  lineType:      'resistance' | 'support';
  p1Ts:          number;
  p2Ts:          number;
  p1Price:       number;
  p2Price:       number;
  slope:         number;
  touches:       number;
  discoveredAt:  number;
  retiredAt:     number | null;
  createdAt:     number;
}

export async function saveDiscoveredLine(
  db:   D1Database,
  line: Omit<TrendlineV2Line, "retiredAt">,
): Promise<void> {
  await db.prepare(
    `INSERT INTO trendline_v2_lines
       (id, bot_id, pair, line_type, p1_ts, p2_ts, p1_price, p2_price, touches, slope, discovered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    line.id, line.botId, line.pair, line.lineType,
    line.p1Ts, line.p2Ts, line.p1Price, line.p2Price, line.touches, line.slope,
    line.discoveredAt, line.createdAt,
  ).run();
}

// Active = not yet retired. This is both "the frozen watch-set while a trade is open" and
// "the candidate pool for a fresh entry" — the caller decides which by whether it also calls
// buildLines() for fresh discovery (only when this returns empty) or not (reuses these as-is).
export async function getActiveLines(
  db:    D1Database,
  botId: string,
  pair:  string,
): Promise<TrendlineV2Line[]> {
  const { results } = await db.prepare(
    `SELECT * FROM trendline_v2_lines WHERE bot_id = ? AND pair = ? AND retired_at IS NULL ORDER BY p1_ts ASC`
  ).bind(botId, pair).all<Record<string, unknown>>();
  return results.map(rowToLine);
}

// Used by monitor.ts to look up a signal's stored opposite-line take-profit reference by id —
// deliberately not filtered by retired_at, since a line already retired for other reasons (e.g.
// this same break) can still be looked up; the caller checks retiredAt itself if it matters.
export async function getLineById(db: D1Database, id: string): Promise<TrendlineV2Line | null> {
  const row = await db.prepare(
    `SELECT * FROM trendline_v2_lines WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  return row ? rowToLine(row) : null;
}

// A line is retired the instant a genuine close-based break is confirmed against it —
// regardless of whether a retest or trade ever follows — so it can never be reconstructed or
// re-entered again. Not gated on a trade closing.
export async function retireLine(db: D1Database, id: string, retiredAt: number): Promise<void> {
  await db.prepare(
    `UPDATE trendline_v2_lines SET retired_at = ? WHERE id = ?`
  ).bind(retiredAt, id).run();
}

function rowToLine(row: Record<string, unknown>): TrendlineV2Line {
  return {
    id:           row["id"]            as string,
    botId:        row["bot_id"]        as string,
    pair:         row["pair"]          as CurrencyPair,
    lineType:     row["line_type"]     as 'resistance' | 'support',
    p1Ts:         row["p1_ts"]         as number,
    p2Ts:         row["p2_ts"]         as number,
    p1Price:      row["p1_price"]      as number,
    p2Price:      row["p2_price"]      as number,
    slope:        row["slope"]         as number,
    touches:      row["touches"]       as number,
    discoveredAt: row["discovered_at"] as number,
    retiredAt:    (row["retired_at"]   as number | null) ?? null,
    createdAt:    row["created_at"]    as number,
  };
}
