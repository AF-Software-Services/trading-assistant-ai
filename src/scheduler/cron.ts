import { PHASE1_PAIRS } from "../types/market.ts";
import { runBotScan }   from "../bot/engine.ts";
import { listBots, seedBotsFromLegacyKV } from "../bot/bot-types.ts";
import { monitorPositions } from "../bot/monitor.ts";
import { saveScanRun } from "../storage/d1.ts";
import { setLastScanTime } from "../storage/kv.ts";
import type { ScanRun } from "../storage/d1.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
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
function resolveSessionName(_cron: string): string {
  const hour = new Date().getUTCHours();
  if (hour >= 7  && hour < 10) return "london_open";
  if (hour >= 10 && hour < 14) return "london_session";
  if (hour >= 14 && hour < 17) return "ny_open";
  if (hour >= 17 && hour < 21) return "ny_session";
  if (hour >= 21 || hour < 7)  return "asian_session";
  return "unknown_session";
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

  console.log(`[Cron] Session: ${sessionName} | Cron: ${event.cron} | Start: ${new Date(start).toISOString()}`);

  ctx.waitUntil(
    (async () => {
      let totalFound = 0, totalQueued = 0, totalExecuted = 0;
      const botErrors: string[] = [];

      try {
        // ── 1. Run all active bot scans ─────────────────────────────────────────
        await seedBotsFromLegacyKV(env.DB, env.KV);
        const bots       = await listBots(env.DB);
        const activeBots = bots.filter(b => b.mode !== "off");

        for (const bot of activeBots) {
          try {
            const r = await runBotScan({
              DB:                    env.DB,
              KV:                    env.KV,
              MARKET_DATA_PROVIDER:  env.MARKET_DATA_PROVIDER,
              CTRADER_CLIENT_ID:     env.CTRADER_CLIENT_ID,
              CTRADER_CLIENT_SECRET: env.CTRADER_CLIENT_SECRET,
              CTRADER_ACCOUNT_ID:    env.CTRADER_ACCOUNT_ID,
              botInstance:           bot,
            });
            totalFound    += r.signalsFound    ?? 0;
            totalQueued   += r.signalsQueued   ?? 0;
            totalExecuted += r.signalsExecuted ?? 0;
            console.log(`[Cron] ${bot.name}: ${r.signalsFound} signals, ${r.signalsQueued} queued, ${r.signalsExecuted} executed`);
          } catch (err) {
            const msg = `${bot.name}: ${(err as Error).message}`;
            botErrors.push(msg);
            console.error(`[Cron] Bot error: ${msg}`);
          }
        }

        // ── 2. Monitor open positions ───────────────────────────────────────────
        try {
          await monitorPositions({
            DB:                    env.DB,
            KV:                    env.KV,
            CTRADER_CLIENT_ID:     env.CTRADER_CLIENT_ID,
            CTRADER_CLIENT_SECRET: env.CTRADER_CLIENT_SECRET,
            CTRADER_ACCOUNT_ID:    env.CTRADER_ACCOUNT_ID,
            MARKET_DATA_PROVIDER:  env.MARKET_DATA_PROVIDER,
          });
        } catch (err) {
          console.error("[Cron] Position monitor error:", err);
        }
      } catch (err) {
        botErrors.push((err as Error).message);
        console.error(`[Cron] Fatal error in session ${sessionName}:`, err);
      } finally {
        // Always record the run — even if bots errored — so the log is never blank
        const durationMs = Date.now() - start;
        const scanRun: ScanRun = {
          id:                       generateUUID(),
          sessionName,
          pairsScanned:             PHASE1_PAIRS,
          recommendationsGenerated: 0,
          createdAt:                start,
          durationMs,
          signalsFound:             totalFound,
          signalsQueued:            totalQueued,
          signalsExecuted:          totalExecuted,
          error:                    botErrors.length ? botErrors.join("; ") : null,
        };
        await saveScanRun(env.DB, scanRun);
        await setLastScanTime(env.KV, sessionName, start);
        console.log(`[Cron] ${sessionName} done in ${durationMs}ms — found:${totalFound} queued:${totalQueued} executed:${totalExecuted}`);
      }
    })()
  );
}
