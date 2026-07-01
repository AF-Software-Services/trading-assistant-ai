import type { CurrencyPair, Timeframe } from "../types/market.ts";
import type {
  Recommendation,
  Direction,
  SignalAction,
  SupportResistanceZone,
  CandlestickSignal,
} from "../types/trading.ts";
import type { MarketDataProvider } from "../providers/interface.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { RISK_CONFIG } from "../config/index.ts";
import { analyseMarketStructure } from "./market-structure.ts";
import { detectZones, getNearestZone } from "./support-resistance.ts";
import { detectAllSignals } from "./candlestick.ts";
import { detectAllPatterns } from "./pattern.ts";
import { analyseTrend, calculateATR } from "./trend.ts";
import { scoreTradeSetup } from "./trade-scoring.ts";
import { calculateRisk } from "./risk.ts";

function generateUUID(): string {
  // Crypto.randomUUID is available in Cloudflare Workers
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for non-Worker environments (tests)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function pickDirection(
  trend: ReturnType<typeof analyseTrend>,
  structure: ReturnType<typeof analyseMarketStructure>,
  nearSupport: SupportResistanceZone | null,
  nearResistance: SupportResistanceZone | null
): Direction {
  const { bias } = trend;
  if (bias === "uptrend" && nearSupport) return "buy";
  if (bias === "downtrend" && nearResistance) return "sell";
  if (bias === "range") {
    if (nearSupport && !nearResistance) return "buy";
    if (nearResistance && !nearSupport) return "sell";
  }
  if (structure.trend === "uptrend" && nearSupport) return "buy";
  if (structure.trend === "downtrend" && nearResistance) return "sell";
  return "neutral";
}

function buildReasons(params: {
  direction: Direction;
  structure: ReturnType<typeof analyseMarketStructure>;
  trend: ReturnType<typeof analyseTrend>;
  zone: SupportResistanceZone | null;
  signal: CandlestickSignal | null;
  score: number;
}): string[] {
  const reasons: string[] = [];
  const { direction, structure, trend, zone, signal } = params;

  if (structure.trend === "uptrend")   reasons.push("Market structure shows higher highs and higher lows (uptrend).");
  if (structure.trend === "downtrend") reasons.push("Market structure shows lower highs and lower lows (downtrend).");
  if (structure.trend === "range")     reasons.push("Price is ranging between established support and resistance.");

  if (trend.emaAlignment === "bullish") reasons.push("EMA 9/21/50 are in bullish alignment (fast > slow > trend).");
  if (trend.emaAlignment === "bearish") reasons.push("EMA 9/21/50 are in bearish alignment (fast < slow < trend).");
  if (trend.momentum === "increasing")  reasons.push("Momentum is increasing — trend is accelerating.");
  if (trend.momentum === "decreasing")  reasons.push("Momentum is decreasing — watch for reversal or slowdown.");

  if (zone) {
    const zType = zone.type === "support" ? "support" : "resistance";
    reasons.push(
      `Price is approaching a ${zone.timeframe} ${zType} zone (${zone.low.toFixed(5)}–${zone.high.toFixed(5)}) ` +
      `with ${zone.touchCount} touches and ${zone.strength} strength.`
    );
    if (zone.isRetested) reasons.push("The zone has been successfully retested, adding confluence.");
  }

  if (signal) {
    reasons.push(
      `${signal.type.replace(/_/g, " ")} candlestick signal detected on the ${signal.timeframe} chart ` +
      `(confidence: ${signal.confidence}%).`
    );
  }

  if (direction === "buy")  reasons.push("Overall bias is bullish — looking for long entry.");
  if (direction === "sell") reasons.push("Overall bias is bearish — looking for short entry.");

  reasons.push(`Composite score: ${params.score}/100.`);

  return reasons;
}

function buildInvalidationConditions(params: {
  direction: Direction;
  structure: ReturnType<typeof analyseMarketStructure>;
  zone: SupportResistanceZone | null;
  entryPrice: number;
}): string[] {
  const conditions: string[] = [];
  const { direction, structure, zone, entryPrice } = params;

  if (zone) {
    if (direction === "buy") {
      conditions.push(`A daily close below the support zone low (${zone.low.toFixed(5)}) invalidates the setup.`);
    } else {
      conditions.push(`A daily close above the resistance zone high (${zone.high.toFixed(5)}) invalidates the setup.`);
    }
  }

  if (structure.lastLow !== null && direction === "buy") {
    conditions.push(`Break of the most recent higher low at ${structure.lastLow.toFixed(5)} invalidates bullish structure.`);
  }
  if (structure.lastHigh !== null && direction === "sell") {
    conditions.push(`Break of the most recent lower high at ${structure.lastHigh.toFixed(5)} invalidates bearish structure.`);
  }

  if (direction === "buy") {
    conditions.push(`Price failing to hold above ${(entryPrice * 0.998).toFixed(5)} on re-test.`);
  } else if (direction === "sell") {
    conditions.push(`Price breaking back above ${(entryPrice * 1.002).toFixed(5)} on re-test.`);
  }

  conditions.push("Setup expires after 7 days if not triggered.");

  return conditions;
}

// Evaluate a single direction (buy or sell) against the shared market data.
// Returns null if the setup doesn't meet minimum criteria.
function buildSetupForDirection(params: {
  pair: CurrencyPair;
  direction: "buy" | "sell";
  price: number;
  atr: number;
  allZones: SupportResistanceZone[];
  nearSupport: SupportResistanceZone | null;
  nearResistance: SupportResistanceZone | null;
  structure4H: ReturnType<typeof analyseMarketStructure>;
  structureD:  ReturnType<typeof analyseMarketStructure>;
  trend4H: ReturnType<typeof analyseTrend>;
  latestSignal: CandlestickSignal | null;
  latestPattern: ReturnType<typeof detectAllPatterns>[number] | null;
}): Recommendation | null {
  const { pair, direction, price, atr, allZones, nearSupport, nearResistance,
          structure4H, structureD, trend4H, latestSignal, latestPattern } = params;

  const relevantZone = direction === "buy" ? nearSupport : nearResistance;

  const stopIdea = direction === "buy"
    ? (relevantZone ? relevantZone.low  - atr * 0.5 : price - atr * 1.5)
    : (relevantZone ? relevantZone.high + atr * 0.5 : price + atr * 1.5);

  const target1 = direction === "buy" ? price + atr * 5 : price - atr * 5;
  const estimatedRR = Math.abs(target1 - price) / Math.abs(stopIdea - price);

  const scoreBreakdown = scoreTradeSetup({
    direction,
    zones: allZones,
    candleSignal: latestSignal,
    structure: structureD,
    trend: trend4H,
    pattern: latestPattern,
    estimatedRR,
  });

  const riskCalc = calculateRisk({
    pair,
    direction,
    entryPrice: price,
    stopLoss:   stopIdea,
    target1,
    target2: direction === "buy" ? price + atr * 8 : price - atr * 8,
  });

  // Require a minimum score to surface the setup
  if (scoreBreakdown.total < 50) return null;

  let action: SignalAction;
  if (scoreBreakdown.total >= RISK_CONFIG.minConfidenceScore && riskCalc.isValid) {
    action = "consider_trade";
  } else if (scoreBreakdown.total >= 60) {
    action = "watch";
  } else {
    action = "no_trade";
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + 7 * 24 * 60 * 60 * 1000;

  const reasons = buildReasons({
    direction,
    structure: structureD,
    trend: trend4H,
    zone: relevantZone,
    signal: latestSignal,
    score: scoreBreakdown.total,
  });

  const invalidationConditions = buildInvalidationConditions({
    direction,
    structure: structure4H,
    zone: relevantZone,
    entryPrice: price,
  });

  const setupType = latestPattern
    ? latestPattern.type.replace(/_/g, " ")
    : latestSignal
      ? latestSignal.type.replace(/_/g, " ") + " at zone"
      : `${trend4H.bias} zone trade`;

  const entryZone = relevantZone
    ? { low: relevantZone.low, high: relevantZone.high }
    : { low: price * 0.999, high: price * 1.001 };

  return {
    id: generateUUID(),
    pair,
    direction,
    confidence: scoreBreakdown.total,
    scoreBreakdown,
    setupType,
    entryZone,
    stopIdea:  +stopIdea.toFixed(5),
    target1:   +target1.toFixed(5),
    target2:   +(direction === "buy" ? price + atr * 8 : price - atr * 8).toFixed(5),
    riskAmount:   riskCalc.riskAmount,
    rewardAmount: riskCalc.rewardAmount,
    rewardRiskRatio: riskCalc.rewardRiskRatio,
    expectedHoldDays: 3,
    reasons,
    invalidationConditions,
    action,
    status: "open",
    createdAt,
    expiresAt,
  };
}

export async function generateRecommendation(params: {
  pair: CurrencyPair;
  provider: MarketDataProvider;
}): Promise<Recommendation[]> {
  const { pair, provider } = params;

  const [candles4H, candlesD, candlesW] = await Promise.all([
    provider.getCandles(pair, "4H", 200),
    provider.getCandles(pair, "D",  100),
    provider.getCandles(pair, "W",   52),
  ]);

  const latestTick = await provider.getLatestPrice(pair);
  const price = latestTick.mid;

  const structure4H = analyseMarketStructure(candles4H, "4H");
  const structureD  = analyseMarketStructure(candlesD, "D");
  const atr         = calculateATR(candlesD);

  const zones4H  = detectZones(candles4H, "4H", atr);
  const zonesD   = detectZones(candlesD,  "D",  atr);
  const zonesW   = detectZones(candlesW,  "W",  atr);
  const allZones = [...zonesW, ...zonesD, ...zones4H];

  const trend4H      = analyseTrend(candles4H, structure4H);
  const signals4H    = detectAllSignals(candles4H, allZones);
  const latestSignal = signals4H.length > 0 ? signals4H[signals4H.length - 1] ?? null : null;
  const patterns     = detectAllPatterns(candles4H);
  const latestPattern = patterns.length > 0 ? patterns[patterns.length - 1] ?? null : null;

  const nearSupport    = getNearestZone(price, allZones, "support");
  const nearResistance = getNearestZone(price, allZones, "resistance");

  const shared = { pair, price, atr, allZones, nearSupport, nearResistance,
                   structure4H, structureD, trend4H, latestSignal, latestPattern };

  const results: Recommendation[] = [];
  for (const direction of ["buy", "sell"] as const) {
    const rec = buildSetupForDirection({ ...shared, direction });
    if (rec) results.push(rec);
  }

  // Sort: higher confidence first
  return results.sort((a, b) => b.confidence - a.confidence);
}

export async function generateAllRecommendations(
  pairs: CurrencyPair[],
  provider: MarketDataProvider
): Promise<Recommendation[]> {
  const results = await Promise.allSettled(
    pairs.map(pair => generateRecommendation({ pair, provider }))
  );

  const recommendations: Recommendation[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      recommendations.push(...result.value);
    }
  }

  return recommendations.sort((a, b) => b.confidence - a.confidence);
}
