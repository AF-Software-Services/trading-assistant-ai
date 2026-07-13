/**
 * Position monitor — runs on each cron tick.
 *
 * 1. Detects closed positions and records outcomes in the journal.
 * 2. Trails the stop loss using the Safety Line projected forward from the entry bar.
 *    Safety Line slope + anchor are stored at execution time by storeTrendlineTrailState.
 */

import { TradingService }                  from "../trading/service.ts";
import { getBotSignals, updateBotSignalStatus, recordBotSignalOutcome, clearBotSignalJournalId } from "./engine.ts";
import { updateJournalOutcome, deleteJournalEntry } from "../storage/journal.ts";
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
  const trading = await TradingService.tryConnect(env);
  if (!trading) return;

  const executedSignals = await getBotSignals(env.DB, { status: "executed", limit: 20 });
  const openSignals     = executedSignals.filter(s => s.ctraderPositionId !== null);
  if (openSignals.length === 0) return;

  let openPositions;
  try {
    openPositions = await trading.getPositions();
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
        const deals      = await trading.getHistory(from, to);
        // Match on positionId, not just symbol — a symbol can have several deals (entry +
        // close, or unrelated past trades) in the lookback window, and grabbing the wrong
        // one silently mislabels a real win/loss as "expired" with ~0 P&L.
        const closingDeal = deals.find(d => d.positionId === posId && d.closePrice !== undefined);

        if (closingDeal?.closePrice) {
          const exitPrice = closingDeal.closePrice;
          // Retest-entry limit orders can sit pending a long time and fill well away from the
          // originally computed level (already known to happen — see the missing-SL fix in
          // this same file). signal.entryPrice is that stale intended level, not where the
          // trade actually opened — closingDeal.entryPrice is the real fill price recorded by
          // the broker on the closing deal itself, so pip/outcome math must use that instead.
          const realEntryPrice = closingDeal.entryPrice;
          const d         = signal.direction === "buy" ? 1 : -1;
          const pnlPips   = (exitPrice - realEntryPrice) * pipFactor(signal.pair) * d;
          const outcome: "tp" | "sl" | "expired" = pnlPips > 2 ? "tp" : pnlPips < -2 ? "sl" : "expired";
          // Prefer cTrader's own realised profit (accurate per-pair pip value + conversion)
          // over the flat "7.5/pip/lot" estimate, which is wrong for non-GBP-quoted pairs.
          const pnlGbp = closingDeal.profit ?? pnlPips * signal.lots * 7.5;

          await recordBotSignalOutcome(
            env.DB, signal.id, outcome, exitPrice,
            closingDeal.closeTime ?? to,
            +pnlPips.toFixed(1),
            +pnlGbp.toFixed(2),
          );

          if (signal.journalId) {
            await updateJournalOutcome(env.DB, signal.journalId, {
              result: pnlPips > 2 ? "win" : pnlPips < -2 ? "loss" : "breakeven",
              exitPrice,
              entryPrice: realEntryPrice,
              notes: `Auto-recorded. P&L: ${pnlPips.toFixed(1)} pips`,
            });
          }
          console.log(`[Monitor] ${signal.pair} ${signal.direction} closed: ${outcome} @ ${exitPrice}`);
          await updateBotSignalStatus(env.DB, signal.id, "expired");
          await env.KV.delete(trailKey(signal.id));
        } else if (signal.expiresAt < Date.now() && !deals.some(d => d.positionId === posId)) {
          // Past its own 4h validity window with zero deals (entry or close) ever recorded for
          // this position — the limit order never filled and never will. Left alone, this signal
          // would sit "expired" forever while its journal row keeps showing a fake "OPEN" trade
          // that has no closing deal to ever resolve it. Clean it up rather than leave it stuck.
          if (signal.journalId) {
            await deleteJournalEntry(env.DB, signal.journalId);
            await clearBotSignalJournalId(env.DB, signal.id);
          }
          console.log(`[Monitor] ${signal.pair} ${signal.direction} never filled — removed phantom journal entry`);
          await updateBotSignalStatus(env.DB, signal.id, "expired");
          await env.KV.delete(trailKey(signal.id));
        }
        // else: no position yet, but no closing deal either, and still within its expiry
        // window — this is just a limit order that hasn't filled yet. Leave status as
        // "executed" so the next cron tick checks again, instead of marking it "expired"
        // prematurely — which previously happened to EVERY pending order on its very first
        // check (often within seconds of being placed) and permanently stopped it being
        // monitored, since monitor.ts only ever looks at status="executed" signals.
      } catch (e) {
        console.error(`[Monitor] Failed to process closed position ${signal.id}:`, e);
      }
      continue;
    }

    // ── Missing stop loss ──────────────────────────────────────────────────────
    // These are limit orders (retest entries) that can sit pending a long time before
    // filling. If price has moved past the level by the time it fills, the originally
    // calculated stop loss can end up on the wrong side of the real entry — cTrader
    // silently drops an invalid SL rather than erroring, leaving the position
    // unprotected. Re-derive a valid stop preserving the bot's intended risk distance,
    // applied relative to the real fill price instead of the stale intended entry.
    if (position.stopLoss == null) {
      const riskDistance = Math.abs(signal.entryPrice - signal.stopLoss);
      const newSL = signal.direction === "buy"
        ? position.openPrice - riskDistance
        : position.openPrice + riskDistance;
      try {
        await trading.amendPosition(posId, newSL, position.takeProfit ?? signal.takeProfit ?? undefined);
        console.log(`[Monitor] ${signal.pair} ${signal.direction} had no stop loss — applied ${newSL.toFixed(5)} (real entry ${position.openPrice}, intended risk ${riskDistance.toFixed(5)})`);
      } catch (e) {
        console.error(`[Monitor] Failed to repair missing SL for ${signal.id}:`, e);
      }
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
        await trading.amendPosition(posId, newSL, signal.takeProfit ?? undefined);
        state.currentSL = newSL;
        console.log(`[Monitor] Trail ${signal.pair} ${signal.direction}: SL → ${newSL.toFixed(5)}`);
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
