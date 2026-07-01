import type { CurrencyPair, Timeframe } from "./market.ts";

export type TrendBias = "uptrend" | "downtrend" | "range" | "unclear";
export type Direction = "buy" | "sell" | "neutral";
export type SignalAction = "watch" | "consider_trade" | "manage_trade" | "no_trade";
export type SwingLabel = "HH" | "HL" | "LH" | "LL";

export interface SwingPoint {
  price: number;
  timestamp: number;
  label: SwingLabel;
  timeframe: Timeframe;
}

export interface MarketStructure {
  pair: CurrencyPair;
  timeframe: Timeframe;
  trend: TrendBias;
  swingPoints: SwingPoint[];
  lastHigh: number | null;
  lastLow: number | null;
  analysedAt: number;
}

export interface SupportResistanceZone {
  id?: string;
  pair: CurrencyPair;
  timeframe: Timeframe;
  type: "support" | "resistance";
  low: number;
  high: number;
  midpoint: number;
  strength: number; // 0–100
  touchCount: number;
  firstSeenAt: number;
  lastTestedAt: number;
  isBroken: boolean;
  isRetested: boolean;
  confidence: number; // 0–100
}

export interface CandlestickSignal {
  pair: CurrencyPair;
  timeframe: Timeframe;
  type: "bullish_engulfing" | "bearish_engulfing" | "hammer" | "shooting_star" | "pin_bar";
  timestamp: number;
  price: number;
  confidence: number;
}

export interface ChartPattern {
  pair: CurrencyPair;
  timeframe: Timeframe;
  type: "head_and_shoulders" | "inverse_head_and_shoulders" | "double_top" | "double_bottom";
  status: "forming" | "confirmed" | "failed";
  neckline?: number;
  target?: number;
  confidence: number;
  detectedAt: number;
  extendedData?: {
    leftShoulderTimestamp: number;
    leftShoulderPrice: number;
    headTimestamp: number;
    headPrice: number;
    rightShoulderTimestamp: number;
    rightShoulderPrice: number;
    necklineLeft: number;
    necklineRight: number;
    necklinePrice: number;
  };
}

export interface TrendAnalysis {
  pair: CurrencyPair;
  timeframe: Timeframe;
  bias: TrendBias;
  emaAlignment: "bullish" | "bearish" | "mixed" | "flat";
  momentum: "increasing" | "decreasing" | "neutral";
  atr: number;
  confidence: number;
}

export interface ScoreBreakdown {
  srStrength: number;
  timeframeImportance: number;
  candlestickSignal: number;
  marketStructure: number;
  trendAlignment: number;
  patternConfirmation: number;
  rewardRiskPotential: number;
  total: number;
}

export interface RiskCalculation {
  pair: CurrencyPair;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  stopDistancePips: number;
  stopDistancePoints: number;
  riskAmount: number;
  rewardAmount: number;
  rewardRiskRatio: number;
  positionSizeUnits: number;
  accountRiskPercent: number;
  isValid: boolean;
  rejectionReason?: string;
}

export interface Recommendation {
  id: string;
  pair: CurrencyPair;
  direction: Direction;
  confidence: number;
  scoreBreakdown: ScoreBreakdown;
  setupType: string;
  entryZone: { low: number; high: number };
  stopIdea: number;
  target1: number;
  target2?: number;
  riskAmount: number;
  rewardAmount: number;
  rewardRiskRatio: number;
  expectedHoldDays: number;
  reasons: string[];
  invalidationConditions: string[];
  action: SignalAction;
  status: "open" | "closed" | "invalidated" | "expired";
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
  closedReason?: string;
  outcome?: "win" | "loss" | "breakeven";
}

export interface ManagementSuggestion {
  recommendationId: string;
  pair: CurrencyPair;
  action: "hold" | "close" | "move_stop" | "partial_profit" | "invalidate";
  reason: string;
  suggestedStop?: number;
  suggestedPartialClose?: number;
  urgency: "low" | "medium" | "high";
}
