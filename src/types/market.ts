export type CurrencyPair =
  | "EUR/USD"
  | "GBP/USD"
  | "GBP/CAD"
  | "USD/JPY"
  | "EUR/GBP"
  | "AUD/USD";

export const PHASE1_PAIRS: CurrencyPair[] = [
  "EUR/USD",
  "GBP/USD",
  "GBP/CAD",
  "USD/JPY",
  "EUR/GBP",
  "AUD/USD",
];

export type Timeframe = "1H" | "4H" | "D" | "W";

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
