import type { CurrencyPair } from "../types/market.ts";
import type { Recommendation, CandlestickSignal, SupportResistanceZone } from "../types/trading.ts";

export interface ScanRun {
  id: string;
  sessionName: string;
  pairsScanned: CurrencyPair[];
  recommendationsGenerated: number;
  createdAt: number;
  durationMs: number;
}

// ── Recommendations ──────────────────────────────────────────────────────────

export async function saveRecommendation(
  db: D1Database,
  rec: Recommendation
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recommendations (
         id, pair, direction, confidence, score_breakdown_json, setup_type,
         entry_zone_json, stop_idea, target1, target2,
         risk_amount, reward_amount, reward_risk_ratio, expected_hold_days,
         reasons_json, invalidation_json, action, status,
         created_at, expires_at, closed_at, closed_reason, outcome
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      rec.id,
      rec.pair,
      rec.direction,
      rec.confidence,
      JSON.stringify(rec.scoreBreakdown),
      rec.setupType,
      JSON.stringify(rec.entryZone),
      rec.stopIdea,
      rec.target1,
      rec.target2 ?? null,
      rec.riskAmount,
      rec.rewardAmount,
      rec.rewardRiskRatio,
      rec.expectedHoldDays,
      JSON.stringify(rec.reasons),
      JSON.stringify(rec.invalidationConditions),
      rec.action,
      rec.status,
      rec.createdAt,
      rec.expiresAt,
      rec.closedAt ?? null,
      rec.closedReason ?? null,
      rec.outcome ?? null
    )
    .run();
}

export async function getRecommendation(
  db: D1Database,
  id: string
): Promise<Recommendation | null> {
  const row = await db
    .prepare(`SELECT * FROM recommendations WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) return null;
  return rowToRecommendation(row);
}

export async function getOpenRecommendations(
  db: D1Database
): Promise<Recommendation[]> {
  const rows = await db
    .prepare(`SELECT * FROM recommendations WHERE status = 'open' ORDER BY created_at DESC`)
    .all<Record<string, unknown>>();

  return rows.results.map(rowToRecommendation);
}

export async function updateRecommendationStatus(
  db: D1Database,
  id: string,
  status: Recommendation["status"],
  closedReason?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE recommendations
       SET status = ?, closed_at = ?, closed_reason = ?
       WHERE id = ?`
    )
    .bind(status, Date.now(), closedReason ?? null, id)
    .run();
}

function rowToRecommendation(row: Record<string, unknown>): Recommendation {
  const parse = <T>(v: unknown): T => JSON.parse(v as string) as T;

  return {
    id:              row["id"] as string,
    pair:            row["pair"] as Recommendation["pair"],
    direction:       row["direction"] as Recommendation["direction"],
    tradeClass:      (row["trade_class"] as Recommendation["tradeClass"]) ?? "PRO_TREND",
    mtfLabel:        (row["mtf_label"] as string) ?? "",
    confidence:      row["confidence"] as number,
    scoreBreakdown:  parse(row["score_breakdown_json"]),
    setupType:       row["setup_type"] as string,
    entryZone:       parse(row["entry_zone_json"]),
    stopIdea:        row["stop_idea"] as number,
    target1:         row["target1"] as number,
    ...(row["target2"] !== null ? { target2: row["target2"] as number } : {}),
    riskAmount:      row["risk_amount"] as number,
    rewardAmount:    row["reward_amount"] as number,
    rewardRiskRatio: row["reward_risk_ratio"] as number,
    expectedHoldDays: row["expected_hold_days"] as number,
    reasons:              parse(row["reasons_json"]),
    invalidationConditions: parse(row["invalidation_json"]),
    action:          row["action"] as Recommendation["action"],
    status:          row["status"] as Recommendation["status"],
    createdAt:       row["created_at"] as number,
    expiresAt:       row["expires_at"] as number,
    ...(row["closed_at"]    !== null ? { closedAt:    row["closed_at"] as number }    : {}),
    ...(row["closed_reason"] !== null ? { closedReason: row["closed_reason"] as string } : {}),
    ...(row["outcome"]       !== null ? { outcome: row["outcome"] as Recommendation["outcome"] } : {}),
  };
}

// ── Signals ──────────────────────────────────────────────────────────────────

export async function saveSignal(
  db: D1Database,
  signal: CandlestickSignal
): Promise<void> {
  const id = `${signal.pair}:${signal.timeframe}:${signal.type}:${signal.timestamp}`;
  await db
    .prepare(
      `INSERT INTO signals (id, pair, timeframe, type, timestamp, price, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, signal.pair, signal.timeframe, signal.type, signal.timestamp, signal.price, signal.confidence, Date.now())
    .run();
}

// ── Scan Runs ────────────────────────────────────────────────────────────────

export async function saveScanRun(
  db: D1Database,
  scan: ScanRun
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scan_runs (id, session_name, pairs_scanned, recommendations_generated, created_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      scan.id,
      scan.sessionName,
      JSON.stringify(scan.pairsScanned),
      scan.recommendationsGenerated,
      scan.createdAt,
      scan.durationMs
    )
    .run();
}

// ── Zones ────────────────────────────────────────────────────────────────────

export async function saveZones(
  db: D1Database,
  zones: SupportResistanceZone[]
): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO support_resistance_zones
       (id, pair, timeframe, type, low, high, midpoint, strength, touch_count,
        first_seen_at, last_tested_at, is_broken, is_retested, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       strength       = excluded.strength,
       touch_count    = excluded.touch_count,
       last_tested_at = excluded.last_tested_at,
       is_broken      = excluded.is_broken,
       is_retested    = excluded.is_retested,
       confidence     = excluded.confidence`
  );

  for (const zone of zones) {
    const id = zone.id ?? `${zone.pair}:${zone.timeframe}:${zone.type}:${zone.midpoint.toFixed(5)}`;
    await stmt
      .bind(
        id, zone.pair, zone.timeframe, zone.type,
        zone.low, zone.high, zone.midpoint,
        zone.strength, zone.touchCount,
        zone.firstSeenAt, zone.lastTestedAt,
        zone.isBroken ? 1 : 0,
        zone.isRetested ? 1 : 0,
        zone.confidence,
        Date.now()
      )
      .run();
  }
}

export async function getZones(
  db: D1Database,
  pair: CurrencyPair
): Promise<SupportResistanceZone[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM support_resistance_zones
       WHERE pair = ? AND is_broken = 0
       ORDER BY strength DESC`
    )
    .bind(pair)
    .all<Record<string, unknown>>();

  return rows.results.map(r => ({
    id:           r["id"]          as string,
    pair:         r["pair"]        as CurrencyPair,
    timeframe:    r["timeframe"]   as SupportResistanceZone["timeframe"],
    type:         r["type"]        as SupportResistanceZone["type"],
    low:          r["low"]         as number,
    high:         r["high"]        as number,
    midpoint:     r["midpoint"]    as number,
    strength:     r["strength"]    as number,
    touchCount:   r["touch_count"] as number,
    firstSeenAt:  r["first_seen_at"]  as number,
    lastTestedAt: r["last_tested_at"] as number,
    isBroken:     (r["is_broken"]  as number) === 1,
    isRetested:   (r["is_retested"] as number) === 1,
    confidence:   r["confidence"]  as number,
  }));
}
