import type { CurrencyPair } from "../types/market.ts";
import type { Recommendation, Direction, SignalAction, SupportResistanceZone, CandlestickSignal } from "../types/trading.ts";
import type { MarketDataProvider } from "../providers/interface.ts";
import { PHASE1_PAIRS } from "../types/market.ts";
import { RISK_CONFIG } from "../config/index.ts";
import { analyseMarketStructure } from "./market-structure.ts";
import { detectZones, getNearestZone, getZoneAlerts, markBrokenByPrice, detectAreaOfInterest } from "./support-resistance.ts";
import type { ZoneAlert, AreaOfInterest } from "./support-resistance.ts";
import { detectAllSignals } from "./candlestick.ts";
import { detectAllPatterns } from "./pattern.ts";
import { analyseTrend, calculateATR } from "./trend.ts";
import { getMtfAlignment, classifyTrade } from "./mtf-alignment.ts";
import type { MtfAlignment } from "./mtf-alignment.ts";
import { calculateFibLevels, priceAtFibLevel } from "./fibonacci.ts";
import { scoreTradeSetup, checkHardGates } from "./trade-scoring.ts";
import { calculateRisk } from "./risk.ts";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildReasons(params: {
  direction: Direction;
  mtf: MtfAlignment;
  zone: SupportResistanceZone | null;
  candleSignal: CandlestickSignal | null;
  score: ReturnType<typeof scoreTradeSetup>;
  fibLabel: string | null;
  zoneAlerts: ZoneAlert[];
  isReversalWatch?: boolean;
}): string[] {
  const { direction, mtf, zone, candleSignal, score, fibLabel, zoneAlerts, isReversalWatch } = params;
  const reasons: string[] = [];

  // Reversal watch header — flag this prominently
  if (isReversalWatch && candleSignal) {
    reasons.push(`⚡ REVERSAL WATCH: ${candleSignal.confidence}% confidence ${candleSignal.type.replace(/_/g, " ")} at a ${zone?.timeframe ?? "key"} ${zone?.type ?? "level"} — counter-trend setup against ${mtf.bias} bias.`);
  }

  // HTF alignment — lead with this
  reasons.push(`HTF Alignment: ${mtf.label} — ${score.tradeClass === "PRO_TREND" ? "pro trend" : score.tradeClass === "COUNTER_TREND" ? "counter trend" : "mixed"} ${direction}.`);

  if (mtf.alignScore === 3) {
    reasons.push(`All three timeframes (Weekly, Daily, 4H) aligned ${mtf.bias} — highest confidence setup.`);
  } else if (mtf.alignScore === 2) {
    reasons.push(`Two of three timeframes aligned ${mtf.bias} — good directional bias.`);
  }

  // Zone alerts
  for (const alert of zoneAlerts) {
    const zType = alert.zone.type === "support" ? "support" : "resistance";
    if (alert.status === "testing") {
      reasons.push(`⚠️ Price is currently INSIDE a ${alert.zone.timeframe} ${zType} zone (${alert.zone.low.toFixed(5)}–${alert.zone.high.toFixed(5)}) — key reaction level.`);
    } else {
      reasons.push(`⚠️ Price approaching ${alert.zone.timeframe} ${zType} zone — within ${alert.distanceAtr} ATR.`);
    }
  }

  // Discount/premium zone
  if (zone) {
    const zType = zone.type === "support" ? "discount (support)" : "premium (resistance)";
    reasons.push(`Price at ${zone.timeframe} ${zType} zone (${zone.low.toFixed(5)}–${zone.high.toFixed(5)}), ${zone.touchCount} touches, ${zone.strength} strength.`);
    if (zone.isRetested) reasons.push("Zone has been successfully retested — adds confluence.");
  }

  // Fibonacci
  if (fibLabel) reasons.push(`Fibonacci: price at ${fibLabel} — discount/premium zone confluence.`);

  // Trigger
  if (candleSignal) {
    reasons.push(`Trigger: ${candleSignal.type.replace(/_/g, " ")} on ${candleSignal.timeframe} (${candleSignal.confidence}% confidence) — entry signal confirmed.`);
  }

  // Structure
  if (score.structureIntact === 15) {
    reasons.push(`Market structure intact — ${direction === "buy" ? "higher highs and higher lows" : "lower highs and lower lows"} confirmed.`);
  }

  // Blockers as warnings
  for (const b of score.blockers) {
    reasons.push(`⚠️ ${b}`);
  }

  reasons.push(`Composite score: ${score.total}/100 (${score.tradeClass}).`);
  return reasons;
}

function buildInvalidation(params: {
  direction: Direction;
  zone: SupportResistanceZone | null;
  entryPrice: number;
  atr: number;
}): string[] {
  const { direction, zone, entryPrice, atr } = params;
  const conditions: string[] = [];

  if (zone) {
    if (direction === "buy") {
      conditions.push(`Daily close below support zone low (${zone.low.toFixed(5)}) invalidates the long setup.`);
    } else {
      conditions.push(`Daily close above resistance zone high (${zone.high.toFixed(5)}) invalidates the short setup.`);
    }
  }

  conditions.push(direction === "buy"
    ? `Price breaking below ${(entryPrice - atr * 1.5).toFixed(5)} — stop triggered.`
    : `Price breaking above ${(entryPrice + atr * 1.5).toFixed(5)} — stop triggered.`
  );
  conditions.push("Setup expires after 7 days if not triggered.");
  return conditions;
}

/**
 * Snap a take-profit to the nearest structure zone boundary closest to rawTarget.
 * For a buy: finds the lowest edge (zone.low) of the nearest resistance zone between
 * entry and rawTarget. For a sell: zone.high of nearest support zone.
 * Only considers W and D zones — 4H is too noisy for TP placement.
 * Falls back to rawTarget if no qualifying zone exists.
 */
function findStructureTP(
  direction: "buy" | "sell",
  entry: number,
  rawTarget: number,
  allZones: SupportResistanceZone[],
): number {
  const d = direction === "buy" ? 1 : -1;
  const zoneType = direction === "buy" ? "resistance" : "support";

  // Candidate zones: correct type, not broken, W or D only, between entry and rawTarget
  const candidates = allZones.filter(z =>
    z.type === zoneType &&
    !z.isBroken &&
    (z.timeframe === "W" || z.timeframe === "D") &&
    z.midpoint * d > entry * d &&       // beyond entry in trade direction
    z.midpoint * d <= rawTarget * d,    // at or before the R:R target
  );

  if (candidates.length === 0) return rawTarget;

  // Pick the one closest to rawTarget (deepest in the direction of trade)
  candidates.sort((a, b) => (b.midpoint - a.midpoint) * d);
  const best = candidates[0]!;

  // Use the front edge of the zone — where price could react before entering
  return direction === "buy" ? best.low : best.high;
}

function buildSetupForDirection(params: {
  pair:         CurrencyPair;
  direction:    "buy" | "sell";
  price:        number;
  atr:          number;
  mtf:          MtfAlignment;
  allZones:     SupportResistanceZone[];
  nearSupport:  SupportResistanceZone | null;
  nearResist:   SupportResistanceZone | null;
  structure4H:  ReturnType<typeof analyseMarketStructure>;
  structureD:   ReturnType<typeof analyseMarketStructure>;
  trend4H:      ReturnType<typeof analyseTrend>;
  latestSignal: CandlestickSignal | null;
  latestPattern: ReturnType<typeof detectAllPatterns>[number] | null;
  zoneAlerts:   ZoneAlert[];
  candlesD:     import("../types/market.ts").Candle[];
  accountSize?: number;
  maxRisk?:     number;
  rrRatio?:     number;
  aoi?:         AreaOfInterest | null;
}): Recommendation | null {
  const {
    pair, direction, price, atr, mtf, allZones,
    nearSupport, nearResist, structure4H, structureD,
    trend4H, latestSignal, latestPattern, zoneAlerts, candlesD,
    accountSize, maxRisk, aoi,
  } = params;
  const rrRatio = params.rrRatio ?? 1.2;

  const tradeClass  = classifyTrade(direction, mtf);

  // If a valid AOI exists and aligns with direction, use its ideal entry
  // as the anchor for stop/target instead of the nearest single zone.
  const aoiAligned = aoi && aoi.bias === direction;
  const relevantZone = direction === "buy" ? nearSupport : nearResist;

  // Calculate stop and target
  const d = direction === "buy" ? 1 : -1;
  const entryAnchor = aoiAligned ? aoi!.entryIdeal : price;
  const stopIdea = aoiAligned
    ? direction === "buy"
      ? aoi!.low  - atr * 0.5   // stop below the HL (W swing low)
      : aoi!.high + atr * 0.5   // stop above the LH (W swing high)
    : relevantZone
      ? direction === "buy"
        ? relevantZone.low  - atr * 0.5
        : relevantZone.high + atr * 0.5
      : price - d * atr * 1.5;
  // TP = snap to nearest structure zone closest to the R:R target.
  // If no zone exists between entry and the R:R target, fall back to pure R:R.
  const stopDistance = Math.abs(entryAnchor - stopIdea);
  const rawTarget1   = entryAnchor + d * stopDistance * rrRatio;
  const rawTarget2   = entryAnchor + d * stopDistance * rrRatio * 2;
  const target1      = findStructureTP(direction, entryAnchor, rawTarget1, allZones);
  const target2      = findStructureTP(direction, target1,     rawTarget2, allZones);
  const estimatedRR  = stopDistance > 0 ? Math.abs(target1 - entryAnchor) / stopDistance : rrRatio;

  // Fibonacci
  const fib      = calculateFibLevels(candlesD, mtf.bias);
  let fibLabel: string | null = null;
  if (fib) {
    const fibCheck = priceAtFibLevel(price, fib, atr);
    if (fibCheck.inGoldenZone)       fibLabel = "golden zone (50–61.8%)";
    else if (fibCheck.atLevel && fibCheck.nearestLevel) fibLabel = fibCheck.nearestLevel.label;
  }

  // Score
  const score = scoreTradeSetup({
    direction, price, atr, mtf, zones: allZones, fib,
    candleSignal: latestSignal,
    structure: structureD,
    trend: trend4H,
    pattern: latestPattern,
    estimatedRR,
    tradeClass,
  });

  // Hard gates
  const rejection = checkHardGates({
    score, tradeClass, estimatedRR,
    signalConfidence: latestSignal?.confidence ?? 0,
  });
  if (rejection) return null;

  // Minimum score gate
  const minScore = tradeClass === "COUNTER_TREND" ? 60 : 50;
  if (score.total < minScore) return null;

  const riskCalc = calculateRisk({
    pair, direction, entryPrice: entryAnchor,
    stopLoss: stopIdea, target1, target2,
    accountSize,
    maxRisk,
  });

  const isReversalWatch = tradeClass === "COUNTER_TREND" && (latestSignal?.confidence ?? 0) >= 85;

  // AOI state — is price inside the AOI, and has a reaction signal fired within it?
  const priceInAOI = aoiAligned && price >= aoi!.low && price <= aoi!.high;
  const priceApproachingAOI = aoiAligned && !priceInAOI &&
    Math.abs(price - (direction === "buy" ? aoi!.low : aoi!.high)) <= atr * 1.5;

  const signalInAOI = aoiAligned && latestSignal !== null &&
    latestSignal.price >= aoi!.low && latestSignal.price <= aoi!.high;

  // Action logic:
  // AOI reaction confirmed  → consider_trade (strongest path)
  // Price in AOI, no signal → watch (waiting for the reaction)
  // Price approaching AOI   → watch (get ready)
  // No AOI / normal path    → score-based as before
  let action: SignalAction;
  if (aoiAligned && priceInAOI && signalInAOI && score.total >= RISK_CONFIG.minConfidenceScore && riskCalc.isValid) {
    action = "consider_trade";
  } else if (aoiAligned && (priceInAOI || priceApproachingAOI)) {
    action = "watch";
  } else if (score.total >= RISK_CONFIG.minConfidenceScore && riskCalc.isValid) {
    action = "consider_trade";
  } else if (score.total >= 60 || isReversalWatch) {
    action = "watch";
  } else {
    action = "no_trade";
  }

  // AOI context line for setupType
  const aoiContext = aoiAligned
    ? priceInAOI && signalInAOI
      ? ` | AOI reaction confirmed`
      : priceInAOI
        ? ` | Price in AOI — awaiting reaction`
        : priceApproachingAOI
          ? ` | Approaching W AOI`
          : ` | W AOI defined (${aoi!.low.toFixed(5)}–${aoi!.high.toFixed(5)})`
    : "";

  const setupType = tradeClass === "PRO_TREND"
    ? `Pro trend ${direction} — ${mtf.label}${aoiContext}`
    : isReversalWatch
      ? `Reversal Watch — ${direction} at ${relevantZone?.timeframe ?? "key"} ${relevantZone?.type ?? "level"} (${latestSignal?.confidence}% signal)${aoiContext}`
      : tradeClass === "COUNTER_TREND"
        ? `Counter trend ${direction} at ${relevantZone?.timeframe ?? "key"} level${aoiContext}`
        : `${direction} setup — mixed HTF${aoiContext}`;

  const reasons = buildReasons({
    direction, mtf, zone: relevantZone,
    candleSignal: latestSignal, score, fibLabel, zoneAlerts,
    isReversalWatch,
  });

  // TP source note — tell the analyst where the target came from
  if (Math.abs(target1 - rawTarget1) < 0.000001) {
    reasons.push(`TP1 set at ${target1.toFixed(5)} (no structure zone found before ${rrRatio}R — using raw R:R).`);
  } else {
    reasons.push(`TP1 snapped to nearest W/D structure at ${target1.toFixed(5)} (R:R target was ${rawTarget1.toFixed(5)}).`);
  }

  // Append AOI reasoning
  if (aoiAligned) {
    if (priceInAOI && signalInAOI) {
      reasons.push(`AOI reaction: ${latestSignal!.type} (${latestSignal!.confidence}%) fired inside the weekly AOI — entry confirmed`);
    } else if (priceInAOI) {
      reasons.push(`Price is inside the weekly AOI (${aoi!.low.toFixed(5)}–${aoi!.high.toFixed(5)}) — waiting for a reaction signal to trigger entry`);
    } else if (priceApproachingAOI) {
      reasons.push(`Price approaching weekly AOI at ${aoi!.low.toFixed(5)}–${aoi!.high.toFixed(5)} — ${aoi!.zones.length} confluent weekly zones`);
    }
  }

  const invalidationConditions = buildInvalidation({
    direction, zone: aoiAligned ? { low: aoi!.low, high: aoi!.high, midpoint: (aoi!.low + aoi!.high) / 2 } as any : relevantZone,
    entryPrice: entryAnchor, atr,
  });

  const entryZone = aoiAligned
    ? { low: aoi!.low, high: aoi!.high }
    : relevantZone
      ? { low: relevantZone.low, high: relevantZone.high }
      : { low: price * 0.999, high: price * 1.001 };

  const createdAt = Date.now();
  return {
    id: generateUUID(),
    pair,
    direction,
    tradeClass,
    mtfLabel: mtf.label,
    confidence: score.total,
    scoreBreakdown: score,
    setupType,
    entryZone,
    stopIdea:  +stopIdea.toFixed(5),
    target1:   +target1.toFixed(5),
    target2:   +target2.toFixed(5),
    riskAmount:      riskCalc.riskAmount,
    rewardAmount:    riskCalc.rewardAmount,
    rewardRiskRatio: riskCalc.rewardRiskRatio,
    expectedHoldDays: 3,
    reasons,
    invalidationConditions,
    action,
    status: "open",
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
  };
}

export async function generateRecommendation(params: {
  pair:      CurrencyPair;
  provider:  MarketDataProvider;
  candles4H?: import("../types/market.ts").Candle[];
  candlesD?:  import("../types/market.ts").Candle[];
  candlesW?:  import("../types/market.ts").Candle[];
  livePrice?: number;
  accountSize?: number;
  maxRisk?:     number;
  rrRatio?:     number;
}): Promise<Recommendation[]> {
  const { pair, provider } = params;

  const [candles4H, candlesD, candlesW] = await Promise.all([
    params.candles4H ?? provider.getCandles(pair, "4H", 200),
    params.candlesD  ?? provider.getCandles(pair, "D",  100),
    params.candlesW  ?? provider.getCandles(pair, "W",   52),
  ]);

  const price = params.livePrice ?? (await provider.getLatestPrice(pair)).mid;
  const atr   = calculateATR(candlesD);

  // MTF alignment — the foundation of every decision
  const mtf = getMtfAlignment(candlesW, candlesD, candles4H);

  // Zones across all timeframes
  const zones4H  = markBrokenByPrice(detectZones(candles4H, "4H", atr), price, atr);
  const zonesD   = markBrokenByPrice(detectZones(candlesD,  "D",  atr), price, atr);
  const zonesW   = markBrokenByPrice(detectZones(candlesW,  "W",  atr), price, atr);
  const allZones = [...zonesW, ...zonesD, ...zones4H];

  const structure4H = analyseMarketStructure(candles4H, "4H");
  const structureD  = analyseMarketStructure(candlesD, "D");
  const trend4H     = analyseTrend(candles4H, structure4H);

  const patterns = detectAllPatterns(candles4H);
  const latestPattern = patterns.length > 0 ? patterns[patterns.length - 1] ?? null : null;

  // Forming candle — append live price so signal detection sees what's forming now
  const lastClosed = candles4H[candles4H.length - 1]!;
  const formingCandle = {
    timestamp: Date.now(),
    open:  lastClosed.close,
    high:  Math.max(lastClosed.close, price),
    low:   Math.min(lastClosed.close, price),
    close: price,
    timeframe: "4H" as const,
    pair,
  };
  const candles4HLive = [...candles4H, formingCandle];
  const signals4H = detectAllSignals(candles4HLive, allZones);

  const nearSupport = getNearestZone(price, allZones, "support");
  const nearResist  = getNearestZone(price, allZones, "resistance");
  const zoneAlerts  = getZoneAlerts(price, allZones, atr);
  const aoi         = detectAreaOfInterest(candlesW, atr);

  // Determine which directions to evaluate
  const bullishTypes = new Set(["bullish_engulfing", "hammer", "pin_bar"]);
  const bearishTypes = new Set(["bearish_engulfing", "shooting_star"]);
  const recentSignals  = signals4H.slice(-20);
  const latestBullish  = [...recentSignals].reverse().find(s => bullishTypes.has(s.type)) ?? null;
  const latestBearish  = [...recentSignals].reverse().find(s => bearishTypes.has(s.type)) ?? null;

  // High-confidence reversal: ≥85% signal directly at a W/D zone forces counter-trend evaluation
  const isHighConfAtWDZone = (signal: CandlestickSignal | null, zoneType: "support" | "resistance") =>
    signal !== null &&
    signal.confidence >= 85 &&
    allZones.some(z =>
      z.type === zoneType && !z.isBroken &&
      (z.timeframe === "W" || z.timeframe === "D") &&
      Math.abs(price - z.midpoint) / atr <= 1.0
    );

  const highConfBullishReversal = isHighConfAtWDZone(latestBullish, "support");
  const highConfBearishReversal = isHighConfAtWDZone(latestBearish, "resistance");

  // Pro trend bias drives which directions are evaluated
  // If MTF is clear, only evaluate the aligned direction — unless a high-confidence
  // counter-trend reversal signal is present at a Weekly/Daily zone.
  let directionsToEvaluate: Array<"buy" | "sell">;
  if (mtf.bias === "uptrend") {
    directionsToEvaluate = ["buy"];
    if (highConfBearishReversal) directionsToEvaluate.push("sell");
  } else if (mtf.bias === "downtrend") {
    directionsToEvaluate = ["sell"];
    if (highConfBullishReversal) directionsToEvaluate.push("buy");
  } else {
    directionsToEvaluate = ["buy", "sell"];
  }

  const shared = {
    pair, price, atr, mtf, allZones, nearSupport, nearResist,
    structure4H, structureD, trend4H, latestPattern, zoneAlerts, candlesD,
    accountSize: params.accountSize,
    maxRisk: params.maxRisk,
    rrRatio: params.rrRatio ?? 1.2,
    aoi,
  };

  const results: Recommendation[] = [];
  for (const direction of directionsToEvaluate) {
    const latestSignal = direction === "buy" ? latestBullish : latestBearish;
    const rec = buildSetupForDirection({ ...shared, direction, latestSignal });
    if (rec) results.push(rec);
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

export async function generateAllRecommendations(
  pairs:    CurrencyPair[],
  provider: MarketDataProvider,
): Promise<Recommendation[]> {
  // Twelve Data basic plan: 8 calls/minute.
  // Each pair needs 4 API calls (4H, D, W candles + tick).
  // Serialize every call with an 8s gap → stays safely under 8/min.
  const delay = () => new Promise(r => setTimeout(r, 8000));

  const recommendations: Recommendation[] = [];
  for (const pair of pairs) {
    try {
      const candles4H = await provider.getCandles(pair, "4H", 200); await delay();
      const candlesD  = await provider.getCandles(pair, "D",  100); await delay();
      const candlesW  = await provider.getCandles(pair, "W",   52); await delay();
      const tick      = await provider.getLatestPrice(pair);        await delay();
      const recs = await generateRecommendation({
        pair, provider, candles4H, candlesD, candlesW, livePrice: tick.mid,
      });
      recommendations.push(...recs);
    } catch (e) {
      console.error(`[generateAllRecommendations] ${pair} failed:`, e);
    }
  }
  return recommendations.sort((a, b) => b.confidence - a.confidence);
}
