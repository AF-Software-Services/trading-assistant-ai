import type { CurrencyPair } from "../types/market.ts";

// Pip size — the smallest price increment counted as "1 pip" for this instrument.
// Used to convert a raw price difference into a pip count: pips = priceDelta / pipSize.
export const PIP_SIZE: Record<CurrencyPair, number> = {
  "EUR/USD":   0.0001,
  "GBP/USD":   0.0001,
  "GBP/CAD":   0.0001,
  "AUD/USD":   0.0001,
  "EUR/GBP":   0.0001,
  "USD/JPY":   0.01,
  "US500":     1,
  "NAS100":    1,
  "GER40":     1,
  "UK100":     1,
  "XAU/USD":   0.01,
  "XAG/USD":   0.001,
  "WTI/USD":   0.01,
  "BRENT/USD": 0.01,
  "NATGAS":    0.001,
  "COPPER":    0.0001,
};

export function pipFactor(pair: string): number {
  return 1 / (PIP_SIZE[pair as CurrencyPair] ?? 0.0001);
}

// Approximate GBP value of 1 pip move per 1.0 "lot", where "1.0 lot" matches this app's
// own risk-sizing convention (fed straight through to cTrader's real per-symbol lotSize at
// order time — see CTraderClient.placeOrder). Derived from Pepperstone's published contract
// specs (confirmed 2026-07-18, not guessed):
//   Gold 100oz/lot, Silver 5000oz/lot, WTI/Brent 100 barrels/lot, NatGas 10,000 MMBtu/lot,
//   Copper 2000 lbs/lot, indices 1 unit/lot (~$1 or £1 per point).
// Quote-currency pip values are converted to GBP at an approximate ~0.78 USD/GBP rate —
// same order of approximation the original forex table already used (EUR/USD's £7.50 was
// itself never a live cross-rate lookup).
export const PIP_VALUE_GBP: Record<string, number> = {
  "EUR/USD":   7.50,
  "GBP/USD":   7.50,
  "USD/JPY":   7.50,
  "AUD/USD":   7.50,
  "EUR/GBP":   10.00,
  "GBP/CAD":   5.50,
  "US500":     0.80,
  "NAS100":    0.80,
  "GER40":     0.80,
  "UK100":     1.00, // GBP-denominated directly, no conversion needed
  "XAU/USD":   0.80,  // 100oz/lot × $0.01 pip ≈ $1/pip
  "XAG/USD":   3.90,  // 5000oz/lot × $0.001 pip ≈ $5/pip
  "WTI/USD":   0.80,  // 100 barrels/lot × $0.01 pip ≈ $1/pip
  "BRENT/USD": 0.80,  // 100 barrels/lot × $0.01 pip ≈ $1/pip
  "NATGAS":    7.80,  // 10,000 MMBtu/lot × $0.001 pip ≈ $10/pip
  "COPPER":    0.16,  // 2000 lbs/lot × $0.0001 pip ≈ $0.20/pip
};
