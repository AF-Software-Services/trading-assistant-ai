import type { CurrencyPair } from "../types/market.ts";
import type { Direction, RiskCalculation } from "../types/trading.ts";

// Pip sizes
const PIP_SIZE: Record<CurrencyPair, number> = {
  "EUR/USD": 0.0001,
  "GBP/USD": 0.0001,
  "GBP/CAD": 0.0001,
  "AUD/USD": 0.0001,
  "EUR/GBP": 0.0001,
  "USD/JPY": 0.01,
};

// Standard lot size in units
const STANDARD_LOT = 100_000;

/**
 * Calculate pip value for a given lot size.
 * For most pairs the pip is 0.0001 of the quote currency per unit.
 * For JPY pairs the pip is 0.01 of JPY per unit.
 *
 * Pip value (in account currency, assumed GBP) is approximated here;
 * a live implementation would use real-time cross rates.
 */
export function calculatePipValue(pair: CurrencyPair, lotSize: number): number {
  const pipSize = PIP_SIZE[pair];
  // For non-JPY pairs quoted against USD, 1 pip per standard lot ≈ $10.
  // We approximate GBP equivalent at 0.79 (1/1.2650).
  const GBP_PER_USD = 1 / 1.2650;

  switch (pair) {
    case "USD/JPY":
      // Quote = JPY. Pip value = lotSize * pipSize / current price
      // Approximate: 149.50 JPY per USD, 1 pip per std lot = 100000 * 0.01 / 149.50 ≈ $6.69 ≈ £5.29
      return lotSize * pipSize / 149.50 * GBP_PER_USD * STANDARD_LOT;

    case "GBP/USD":
    case "GBP/CAD":
      // Base = GBP: pip value is directly in GBP
      return lotSize * pipSize * STANDARD_LOT;

    case "EUR/GBP":
      // Quote = GBP: pip value is in GBP per lot
      return lotSize * pipSize * STANDARD_LOT;

    case "EUR/USD":
    case "AUD/USD":
    default:
      // Quote = USD: convert to GBP
      return lotSize * pipSize * STANDARD_LOT * GBP_PER_USD;
  }
}

/**
 * Calculate full risk parameters for a trade.
 */
export function calculateRisk(params: {
  pair: CurrencyPair;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  accountSize?: number;
  maxRisk?: number;
  minRewardRisk?: number;
}): RiskCalculation {
  const {
    pair,
    direction,
    entryPrice,
    stopLoss,
    target1,
    accountSize,
    maxRisk,
    minRewardRisk,
  } = params;

  const pipSize = PIP_SIZE[pair];

  // Validate direction
  if (direction === "neutral") {
    return {
      pair, direction, entryPrice, stopLoss, target1,
      ...(params.target2 !== undefined ? { target2: params.target2 } : {}),
      stopDistancePips: 0, stopDistancePoints: 0,
      riskAmount: 0, rewardAmount: 0, rewardRiskRatio: 0,
      positionSizeUnits: 0, accountRiskPercent: 0,
      isValid: false,
      rejectionReason: "Direction is neutral — cannot size a trade",
    };
  }

  // Stop distance
  const stopDistancePoints = Math.abs(entryPrice - stopLoss);
  const stopDistancePips   = stopDistancePoints / pipSize;

  if (stopDistancePips === 0) {
    return buildInvalid(params, "Stop loss equals entry price — zero stop distance");
  }

  // Pip value at 1 standard lot
  const pipValuePerLot = calculatePipValue(pair, 1);

  // Position size: how many lots to risk exactly `maxRisk`?
  const lotsNeeded = maxRisk / (stopDistancePips * pipValuePerLot);
  const positionSizeUnits = Math.floor(lotsNeeded * STANDARD_LOT);

  if (positionSizeUnits < 1000) {
    return buildInvalid(params, "Position size too small — minimum 0.01 lots (1,000 units)");
  }

  // Risk amount (should be ≤ maxRisk by design)
  const actualLots = positionSizeUnits / STANDARD_LOT;
  const riskAmount = stopDistancePips * actualLots * pipValuePerLot;

  if (riskAmount > maxRisk) {
    return buildInvalid(params, `Risk amount £${riskAmount.toFixed(2)} exceeds max £${maxRisk}`);
  }

  // Reward (to target1)
  const rewardDistancePoints = Math.abs(target1 - entryPrice);
  const rewardDistancePips   = rewardDistancePoints / pipSize;
  const rewardAmount = rewardDistancePips * actualLots * pipValuePerLot;

  // R:R ratio
  const rewardRiskRatio = riskAmount > 0 ? rewardAmount / riskAmount : 0;

  if (rewardRiskRatio < minRewardRisk) {
    return {
      pair, direction, entryPrice, stopLoss, target1,
      ...(params.target2 !== undefined ? { target2: params.target2 } : {}),
      stopDistancePips:  +stopDistancePips.toFixed(1),
      stopDistancePoints: +stopDistancePoints.toFixed(5),
      riskAmount:   +riskAmount.toFixed(2),
      rewardAmount: +rewardAmount.toFixed(2),
      rewardRiskRatio: +rewardRiskRatio.toFixed(2),
      positionSizeUnits,
      accountRiskPercent: +((riskAmount / accountSize) * 100).toFixed(2),
      isValid: false,
      rejectionReason: `R:R ratio ${rewardRiskRatio.toFixed(2)} is below minimum ${minRewardRisk}`,
    };
  }

  return {
    pair, direction, entryPrice, stopLoss, target1,
    ...(params.target2 !== undefined ? { target2: params.target2 } : {}),
    stopDistancePips:  +stopDistancePips.toFixed(1),
    stopDistancePoints: +stopDistancePoints.toFixed(5),
    riskAmount:   +riskAmount.toFixed(2),
    rewardAmount: +rewardAmount.toFixed(2),
    rewardRiskRatio: +rewardRiskRatio.toFixed(2),
    positionSizeUnits,
    accountRiskPercent: +((riskAmount / accountSize) * 100).toFixed(2),
    isValid: true,
  };
}

function buildInvalid(
  params: Parameters<typeof calculateRisk>[0],
  reason: string
): RiskCalculation {
  return {
    pair: params.pair,
    direction: params.direction,
    entryPrice: params.entryPrice,
    stopLoss: params.stopLoss,
    target1: params.target1,
    ...(params.target2 !== undefined ? { target2: params.target2 } : {}),
    stopDistancePips: 0,
    stopDistancePoints: 0,
    riskAmount: 0,
    rewardAmount: 0,
    rewardRiskRatio: 0,
    positionSizeUnits: 0,
    accountRiskPercent: 0,
    isValid: false,
    rejectionReason: reason,
  };
}
