import type { Recommendation, ManagementSuggestion } from "../types/trading.ts";
import type { MarketDataProvider } from "../providers/interface.ts";
import { detectBullishEngulfing, detectBearishEngulfing } from "./candlestick.ts";
import { detectZones, getNearestZone } from "./support-resistance.ts";
import { analyseMarketStructure } from "./market-structure.ts";
import { calculateATR } from "./trend.ts";

/**
 * Review an existing open recommendation and suggest management action.
 */
export async function reviewRecommendation(
  rec: Recommendation,
  provider: MarketDataProvider
): Promise<ManagementSuggestion> {
  const now = Date.now();

  // --- Expiry check ---
  if (now >= rec.expiresAt) {
    return {
      recommendationId: rec.id,
      pair: rec.pair,
      action: "invalidate",
      reason: "Recommendation has exceeded its 7-day window without triggering.",
      urgency: "medium",
    };
  }

  // Fetch recent candles for analysis
  const [candles4H, candlesD] = await Promise.all([
    provider.getCandles(rec.pair, "4H", 100),
    provider.getCandles(rec.pair, "D",  60),
  ]);

  const latestTick = await provider.getLatestPrice(rec.pair);
  const price = latestTick.mid;

  const atr  = calculateATR(candlesD);
  const zonesD  = detectZones(candlesD,  "D",  atr);
  const zones4H = detectZones(candles4H, "4H", atr);
  const allZones = [...zonesD, ...zones4H];

  const structure = analyseMarketStructure(candles4H, "4H");

  // --- Structure break check ---
  if (rec.direction === "buy") {
    // A long is invalidated when the most recent higher low is broken
    const { lastLow } = structure;
    if (lastLow !== null && price < lastLow) {
      return {
        recommendationId: rec.id,
        pair: rec.pair,
        action: "invalidate",
        reason: `Bullish market structure broken — price (${price.toFixed(5)}) has fallen below the last higher low (${lastLow.toFixed(5)}).`,
        urgency: "high",
      };
    }
  } else if (rec.direction === "sell") {
    const { lastHigh } = structure;
    if (lastHigh !== null && price > lastHigh) {
      return {
        recommendationId: rec.id,
        pair: rec.pair,
        action: "invalidate",
        reason: `Bearish market structure broken — price (${price.toFixed(5)}) has exceeded the last lower high (${lastHigh.toFixed(5)}).`,
        urgency: "high",
      };
    }
  }

  // --- Opposing candlestick signal check ---
  if (rec.direction === "buy") {
    // Bearish engulfing at resistance warns to close long
    const bearishSignals = detectBearishEngulfing(candles4H, allZones);
    const recentBearish  = bearishSignals.filter(s => s.timestamp > now - 2 * 3_600_000 * 4); // last 2 x 4H bars
    const nearResistance = getNearestZone(price, allZones, "resistance");
    if (recentBearish.length > 0 && nearResistance) {
      return {
        recommendationId: rec.id,
        pair: rec.pair,
        action: "close",
        reason: `Bearish engulfing pattern detected at resistance zone (${nearResistance.low.toFixed(5)}–${nearResistance.high.toFixed(5)}) — consider closing long position.`,
        urgency: "high",
      };
    }
  } else if (rec.direction === "sell") {
    // Bullish engulfing at support warns to close short
    const bullishSignals = detectBullishEngulfing(candles4H, allZones);
    const recentBullish  = bullishSignals.filter(s => s.timestamp > now - 2 * 3_600_000 * 4);
    const nearSupport = getNearestZone(price, allZones, "support");
    if (recentBullish.length > 0 && nearSupport) {
      return {
        recommendationId: rec.id,
        pair: rec.pair,
        action: "close",
        reason: `Bullish engulfing pattern detected at support zone (${nearSupport.low.toFixed(5)}–${nearSupport.high.toFixed(5)}) — consider closing short position.`,
        urgency: "high",
      };
    }
  }

  // --- Target proximity check: suggest partial profit ---
  const target1Dist = Math.abs(price - rec.target1);
  if (target1Dist < atr * 0.5) {
    return {
      recommendationId: rec.id,
      pair: rec.pair,
      action: "partial_profit",
      reason: `Price within ${(target1Dist / atr * 100).toFixed(0)}% ATR of Target 1 (${rec.target1.toFixed(5)}). Consider taking partial profits and moving stop to breakeven.`,
      suggestedStop: rec.entryZone.high,
      suggestedPartialClose: 50,
      urgency: "medium",
    };
  }

  // --- Stop move suggestion: trail stop if price moved significantly ---
  const entryMid = (rec.entryZone.low + rec.entryZone.high) / 2;
  const priceMoved = Math.abs(price - entryMid);
  if (priceMoved > atr * 1.5) {
    const newStop = rec.direction === "buy"
      ? price - atr * 1.2
      : price + atr * 1.2;
    return {
      recommendationId: rec.id,
      pair: rec.pair,
      action: "move_stop",
      reason: `Price has moved ${(priceMoved / atr).toFixed(1)}x ATR in favour. Consider trailing stop to lock in gains.`,
      suggestedStop: +newStop.toFixed(5),
      urgency: "low",
    };
  }

  // --- Default: hold ---
  return {
    recommendationId: rec.id,
    pair: rec.pair,
    action: "hold",
    reason: "No new signals or structural breaks detected. Continue to hold as planned.",
    urgency: "low",
  };
}

/**
 * Review all open recommendations and return management suggestions.
 */
export async function reviewAllOpen(
  recommendations: Recommendation[],
  provider: MarketDataProvider
): Promise<ManagementSuggestion[]> {
  const open = recommendations.filter(r => r.status === "open");
  const results = await Promise.allSettled(
    open.map(rec => reviewRecommendation(rec, provider))
  );

  const suggestions: ManagementSuggestion[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      suggestions.push(result.value);
    }
  }
  return suggestions;
}
