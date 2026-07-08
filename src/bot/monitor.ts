/**
 * Position monitor — runs on each cron tick.
 *
 * 1. Detects closed positions and records outcomes in the journal.
 * 2. Trails the stop loss using the Safety Line projected forward from the entry bar.
 *    Safety Line slope + anchor are stored at execution time by storeTrendlineTrailState.
 */

import { CTraderClient, SYMBOL_IDS }      from "../ctrader/client.ts";
import { getBotSignals, updateBotSignalStatus, recordBotSignalOutcome } from "./engine.ts";
import { updateJournalOutcome }            from "../storage/journal.ts";
import { createMarketDataProvider }        from "../providers/factory.ts";
import { calculateATR }                    from "../engines/trend.ts";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
  MARKET_DATA_PROVIDER?: string;
  TWELVE_DATA_API_KEY?: string;
}

interface TrailState {
  currentSL:           number;
  safetySlope?:        number;
  safetyAnchorPrice?:  number;
  safetyAnchorTimeMs?: number;
}

function trailKey(signalId: string): string {
  return `trail:${signalId}`;
}

function pipFactor(pair: string): number {
  return pair.includes("JPY") ? 100 : 10000;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export async function monitorPositions(env: Env): Promise<void> {
  const token = await env.KV.get("ctrader:access_token");
  if (!token) return;

  const ct = new CTraderClient({
    clientId:     env.CTRADER_CLIENT_ID,
    clientSecret: env.CTRADER_CLIENT_SECRET,
    accessToken:  token,
    accountId:    parseInt(env.CTRADER_ACCOUNT_ID),
  });

  const executedSignals = await getBotSignals(env.DB, { status: "executed", limit: 20 });
  const openSignals     = executedSignals.filter(s => s.ctraderPositionId !== null);
  if (openSignals.length === 0) return;

  let openPositions;
  try {
    openPositions = await ct.getPositions();
  } catch (e) {
    console.error("[Monitor] Failed to fetch positions:", e);
    return;
  }
  const openPositionMap = new Map(openPositions.map(p => [p.positionId, p]));

  const provider = createMarketDataProvider({
    provider: env.MARKET_DATA_PROVIDER ?? "live",
    apiKey:   env.TWELVE_DATA_API_KEY,
    kv:       env.KV,
  });

  for (const signal of openSignals) {
    const posId    = signal.ctraderPositionId!;
    const position = openPositionMap.get(posId);

    // ── Position closed ───────────────────────────────────────────────────────
    if (!position) {
      const to   = Date.now();
      const from = signal.executedAt ?? (to - 7 * 24 * 60 * 60 * 1000);
      try {
        const deals      = await ct.getHistory(from, to);
        const closingDeal = deals.find(d => d.symbol === signal.pair);

        if (closingDeal?.closePrice) {
          const exitPrice = closingDeal.closePrice;
          const d         = signal.direction === "buy" ? 1 : -1;
          const pnlPips   = (exitPrice - signal.entryPrice) * pipFactor(signal.pair) * d;
          const outcome: "tp" | "sl" | "expired" = pnlPips > 2 ? "tp" : pnlPips < -2 ? "sl" : "expired";

          await recordBotSignalOutcome(
            env.DB, signal.id, outcome, exitPrice,
            closingDeal.closeTime ?? to,
            +pnlPips.toFixed(1),
            +(pnlPips * signal.lots * 7.5).toFixed(2),
          );

          if (signal.journalId) {
            await updateJournalOutcome(env.DB, signal.journalId, {
              result: pnlPips > 2 ? "win" : pnlPips < -2 ? "loss" : "breakeven",
              exitPrice,
              notes: `Auto-recorded. P&L: ${pnlPips.toFixed(1)} pips`,
            });
          }
          console.log(`[Monitor] ${signal.pair} ${signal.direction} closed: ${outcome} @ ${exitPrice}`);
        }

        await updateBotSignalStatus(env.DB, signal.id, "expired");
        await env.KV.delete(trailKey(signal.id));
      } catch (e) {
        console.error(`[Monitor] Failed to process closed position ${signal.id}:`, e);
      }
      continue;
    }

    // ── Trail the stop loss ───────────────────────────────────────────────────
    try {
      const candles4H    = await provider.getCandles(signal.pair, "4H", 50);
      if (candles4H.length < 5) continue;

      const latestCandle = candles4H[candles4H.length - 1]!;
      const currentPrice = latestCandle.close;
      const atr          = calculateATR(candles4H);

      const savedState   = await env.KV.get(trailKey(signal.id), "json") as TrailState | null;
      const state: TrailState = savedState ?? { currentSL: signal.stopLoss };

      let newSL = state.currentSL;

      if (state.safetySlope !== undefined && state.safetyAnchorPrice !== undefined && state.safetyAnchorTimeMs !== undefined) {
        const barsElapsed = (Date.now() - state.safetyAnchorTimeMs) / FOUR_HOURS_MS;
        newSL = state.safetyAnchorPrice + state.safetySlope * barsElapsed;
      }

      // SL only moves in trade's favour
      const slImproved = signal.direction === "buy"
        ? newSL > state.currentSL + atr * 0.1
        : newSL < state.currentSL - atr * 0.1;

      if (slImproved) {
        const symbolId = SYMBOL_IDS[signal.pair];
        if (symbolId) {
          await ct.amendPosition(posId, newSL, signal.takeProfit ?? undefined);
          state.currentSL = newSL;
          console.log(`[Monitor] Trail ${signal.pair} ${signal.direction}: SL → ${newSL.toFixed(5)}`);
        }
      }

      await env.KV.put(trailKey(signal.id), JSON.stringify(state), { expirationTtl: 7 * 24 * 3600 });
    } catch (e) {
      console.error(`[Monitor] Trail error for ${signal.id}:`, e);
    }
  }
}

/**
 * Called from the bot engine when a trendline signal is first executed.
 * Stores the safety line params so the monitor can project it forward each tick.
 */
export async function storeTrendlineTrailState(
  kv:          KVNamespace,
  signalId:    string,
  safetyLine:  { slope: number; p1Price: number },
  entryTimeMs: number,
  initialSL:   number,
): Promise<void> {
  const state: TrailState = {
    currentSL:           initialSL,
    safetySlope:         safetyLine.slope,
    safetyAnchorPrice:   safetyLine.p1Price,
    safetyAnchorTimeMs:  entryTimeMs,
  };
  await kv.put(trailKey(signalId), JSON.stringify(state), { expirationTtl: 7 * 24 * 3600 });
}
