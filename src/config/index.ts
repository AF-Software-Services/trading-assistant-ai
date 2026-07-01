export const RISK_CONFIG = {
  accountSize: 10_000,       // GBP
  maxLossPerTrade: 100,      // GBP
  maxOpenRecommendations: 3,
  maxTotalOpenRisk: 300,     // GBP
  minRewardRisk: 3.0,
  preferredRewardRisk: 5.0,
  minConfidenceScore: 75,
  swingWindowDays: 7,
} as const;

export const SCAN_SCHEDULE = {
  "0 7 * * 1-5":  "london_open_prep",
  "0 10 * * 1-5": "early_session_review",
  "0 14 * * 1-5": "us_session_prep",
  "0 17 * * 1-5": "trade_management_review",
  "0 21 * * 1-5": "daily_candle_review",
} as const;

export const EMA_PERIODS = { fast: 9, slow: 21, trend: 50 } as const;
export const ATR_PERIOD = 14;
export const PIVOT_LOOKBACK = 5; // bars each side for swing high/low
export const ZONE_ATR_MULTIPLIER = 0.3;
export const MIN_ZONE_TOUCHES = 2;
