export type CurrencyPair =
  | "EUR/USD"
  | "GBP/USD"
  | "GBP/CAD"
  | "USD/JPY"
  | "EUR/GBP"
  | "AUD/USD"
  | "US500"
  | "NAS100"
  | "GER40"
  | "UK100"
  | "XAU/USD"
  | "XAG/USD"
  | "WTI/USD"
  | "BRENT/USD"
  | "NATGAS"
  | "COPPER"
  | "USD/CAD"
  | "USD/SEK"
  | "USD/CHF";

export const PHASE1_PAIRS: CurrencyPair[] = [
  "EUR/USD",
  "GBP/USD",
  "GBP/CAD",
  "USD/JPY",
  "EUR/GBP",
  "AUD/USD",
];

export type InstrumentCategory = "forex" | "indices" | "commodities";

export const PAIR_CATEGORY: Record<CurrencyPair, InstrumentCategory> = {
  "EUR/USD":   "forex",
  "GBP/USD":   "forex",
  "GBP/CAD":   "forex",
  "USD/JPY":   "forex",
  "EUR/GBP":   "forex",
  "AUD/USD":   "forex",
  "US500":     "indices",
  "NAS100":    "indices",
  "GER40":     "indices",
  "UK100":     "indices",
  "XAU/USD":   "commodities",
  "XAG/USD":   "commodities",
  "WTI/USD":   "commodities",
  "BRENT/USD": "commodities",
  "NATGAS":    "commodities",
  "COPPER":    "commodities",
  // Added for the DXY synthetic-index formula (needs EUR/USD, USD/JPY, GBP/USD, USD/CAD,
  // USD/SEK, USD/CHF closes) — the first three were already tradeable; these three weren't.
  // Categorized as forex like any other pair, so they're tradeable by any bot too, not just
  // usable as DXY inputs.
  "USD/CAD":   "forex",
  "USD/SEK":   "forex",
  "USD/CHF":   "forex",
};

export const ALL_TRADEABLE_PAIRS: CurrencyPair[] = Object.keys(PAIR_CATEGORY) as CurrencyPair[];

export type Timeframe = "1H" | "2H" | "4H" | "D" | "W";

export interface Candle {
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timeframe: Timeframe;
  pair: CurrencyPair;
}

export interface PriceTick {
  pair: CurrencyPair;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}
