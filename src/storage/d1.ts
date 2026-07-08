import type { CurrencyPair } from "../types/market.ts";

export interface ScanRun {
  id: string;
  sessionName: string;
  pairsScanned: CurrencyPair[];
  recommendationsGenerated: number;
  createdAt: number;
  durationMs: number;
  signalsFound?:    number;
  signalsQueued?:   number;
  signalsExecuted?: number;
  error?:           string | null;
}

export async function saveScanRun(
  db: D1Database,
  scan: ScanRun
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scan_runs (id, session_name, pairs_scanned, recommendations_generated, created_at, duration_ms,
                             signals_found, signals_queued, signals_executed, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      scan.id,
      scan.sessionName,
      JSON.stringify(scan.pairsScanned),
      scan.recommendationsGenerated,
      scan.createdAt,
      scan.durationMs,
      scan.signalsFound    ?? 0,
      scan.signalsQueued   ?? 0,
      scan.signalsExecuted ?? 0,
      scan.error           ?? null,
    )
    .run();
}
