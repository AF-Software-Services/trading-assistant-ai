import type { Candle } from "../types/market.ts";
import type { TrendBias } from "../types/trading.ts";
import { analyseMarketStructure } from "./market-structure.ts";
import { analyseTrend } from "./trend.ts";

export type TradeClass = "PRO_TREND" | "COUNTER_TREND" | "MIXED" | "NO_TRADE";

export interface MtfAlignment {
  weekly:  TrendBias;
  daily:   TrendBias;
  h4:      TrendBias;
  bias:    TrendBias;        // agreed direction or "range" if mixed
  tradeClass: TradeClass;
  alignScore: number;        // 0-3: how many TFs agree with bias
  label: string;             // human readable e.g. "W↓ D↓ 4H↓"
}

function tfBias(candles: Candle[]): TrendBias {
  if (candles.length < 10) return "unclear";
  const structure = analyseMarketStructure(candles, candles[0]!.timeframe);
  const trend     = analyseTrend(candles, structure);
  return trend.bias;
}

function arrowFor(bias: TrendBias): string {
  if (bias === "uptrend")   return "↑";
  if (bias === "downtrend") return "↓";
  if (bias === "range")     return "→";
  return "?";
}

export function getMtfAlignment(
  candlesW:  Candle[],
  candlesD:  Candle[],
  candles4H: Candle[],
): MtfAlignment {
  const weekly = tfBias(candlesW);
  const daily  = tfBias(candlesD);
  const h4     = tfBias(candles4H);

  const label = `W${arrowFor(weekly)} D${arrowFor(daily)} 4H${arrowFor(h4)}`;

  const bullish = [weekly, daily, h4].filter(b => b === "uptrend").length;
  const bearish = [weekly, daily, h4].filter(b => b === "downtrend").length;

  let bias: TrendBias;
  let tradeClass: TradeClass;
  let alignScore: number;

  if (bullish === 3) {
    bias = "uptrend"; tradeClass = "PRO_TREND"; alignScore = 3;
  } else if (bearish === 3) {
    bias = "downtrend"; tradeClass = "PRO_TREND"; alignScore = 3;
  } else if (bullish === 2) {
    bias = "uptrend"; tradeClass = "PRO_TREND"; alignScore = 2;
  } else if (bearish === 2) {
    bias = "downtrend"; tradeClass = "PRO_TREND"; alignScore = 2;
  } else {
    // Mixed — only counter trend setups at major levels are valid
    bias = "range"; tradeClass = "MIXED"; alignScore = 1;
  }

  return { weekly, daily, h4, bias, tradeClass, alignScore, label };
}

/**
 * Classify a proposed trade direction against the MTF alignment.
 * Used to label each recommendation as PRO_TREND, COUNTER_TREND, or MIXED.
 */
export function classifyTrade(
  direction: "buy" | "sell",
  mtf: MtfAlignment,
): TradeClass {
  if (mtf.bias === "range") return "MIXED";
  const withTrend = (direction === "buy" && mtf.bias === "uptrend") ||
                    (direction === "sell" && mtf.bias === "downtrend");
  if (withTrend) return mtf.alignScore === 3 ? "PRO_TREND" : "PRO_TREND";
  return "COUNTER_TREND";
}
