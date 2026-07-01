import { SCAN_SCHEDULE } from "../config/index.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { createMarketDataProvider } from "../providers/factory.ts";
import { generateAllRecommendations } from "../engines/recommendation.ts";
import { reviewAllOpen } from "../engines/trade-management.ts";
import { analyseMarketStructure } from "../engines/market-structure.ts";
import { detectZones } from "../engines/support-resistance.ts";
import { detectAllSignals } from "../engines/candlestick.ts";
import { analyseTrend, calculateATR } from "../engines/trend.ts";
import {
  saveRecommendation,
  getOpenRecommendations,
  updateRecommendationStatus,
  saveSignal,
  saveScanRun,
  saveZones,
} from "../storage/d1.ts";
import { setCachedAnalysis, setLastScanTime } from "../storage/kv.ts";
import type { ScanRun } from "../storage/d1.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Map a cron expression string to the session name defined in SCAN_SCHEDULE.
 * Falls back to "unknown_session" if no match found.
 */
function resolveSessionName(cron: string): string {
  // Cloudflare provides the cron in the ScheduledEvent
  const entry = Object.entries(SCAN_SCHEDULE).find(([expr]) => expr === cron);
  return entry ? entry[1] : "unknown_session";
}

/**
 * Handle a Cloudflare cron trigger.
 * - Maps cron expression → session name
 * - Generates new recommendations for all pairs
 * - Reviews existing open recommendations
 * - Persists everything to D1 and KV
 */
export async function handleCronTrigger(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const start       = Date.now();
  const sessionName = resolveSessionName(event.cron);
  const provider    = createMarketDataProvider({ provider: env.MARKET_DATA_PROVIDER });

  console.log(`[Cron] Session: ${sessionName} | Cron: ${event.cron} | Start: ${new Date(start).toISOString()}`);

  ctx.waitUntil(
    (async () => {
      try {
        // ── 1. Generate new recommendations ────────────────────────────────────
        const newRecs = await generateAllRecommendations(PHASE1_PAIRS, provider);
        console.log(`[Cron] Generated ${newRecs.length} recommendations`);

        for (const rec of newRecs) {
          await saveRecommendation(env.DB, rec);

          // Cache analysis per pair
          const candles   = await provider.getCandles(rec.pair, "4H", 200);
          const atr       = calculateATR(candles);
          const structure = analyseMarketStructure(candles, "4H");
          const zones     = detectZones(candles, "4H", atr);
          const trend     = analyseTrend(candles, structure);

          await setCachedAnalysis(env.KV, rec.pair, {
            pair: rec.pair,
            timeframe: "4H",
            structure,
            zones,
            trend,
            cachedAt: Date.now(),
          });

          // Save recent signals and zones
          const signals = detectAllSignals(candles, zones);
          for (const sig of signals.slice(-5)) {
            await saveSignal(env.DB, sig);
          }
          await saveZones(env.DB, zones);
        }

        // ── 2. Review existing open recommendations ─────────────────────────────
        const openRecs    = await getOpenRecommendations(env.DB);
        const suggestions = await reviewAllOpen(openRecs, provider);

        for (const suggestion of suggestions) {
          if (suggestion.action === "invalidate" || suggestion.action === "close") {
            await updateRecommendationStatus(
              env.DB,
              suggestion.recommendationId,
              suggestion.action === "invalidate" ? "invalidated" : "closed",
              suggestion.reason
            );
            console.log(
              `[Cron] ${suggestion.action.toUpperCase()}: ${suggestion.recommendationId} — ${suggestion.reason}`
            );
          }
        }

        // ── 3. Record scan run ──────────────────────────────────────────────────
        const durationMs = Date.now() - start;
        const scanRun: ScanRun = {
          id: generateUUID(),
          sessionName,
          pairsScanned: PHASE1_PAIRS,
          recommendationsGenerated: newRecs.length,
          createdAt: start,
          durationMs,
        };
        await saveScanRun(env.DB, scanRun);
        await setLastScanTime(env.KV, sessionName, start);

        console.log(`[Cron] Session ${sessionName} complete in ${durationMs}ms`);
      } catch (err) {
        console.error(`[Cron] Error in session ${sessionName}:`, err);
      }
    })()
  );
}
