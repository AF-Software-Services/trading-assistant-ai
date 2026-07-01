import { describe, it, expect } from "vitest";
import { calculateRisk, calculatePipValue } from "../src/engines/risk.ts";

describe("calculateRisk", () => {
  it("calculates position size so that risk is at or below £100 for a standard buy trade", () => {
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "buy",
      entryPrice: 1.0850,
      stopLoss:   1.0800,  // 50 pip stop
      target1:    1.1000,  // 150 pip target → 3:1 RR
    });
    expect(result.riskAmount).toBeLessThanOrEqual(100);
    expect(result.riskAmount).toBeGreaterThan(0);
  });

  it("uses pip size 0.01 for JPY pairs", () => {
    const result = calculateRisk({
      pair: "USD/JPY",
      direction: "buy",
      entryPrice: 149.50,
      stopLoss:   149.00,  // 50 pip stop
      target1:    150.50,  // 100 pip target → 2:1 ... invalid
    });
    // stopDistancePips should be 50 (using pipSize 0.01)
    expect(result.stopDistancePips).toBeCloseTo(50, 0);
  });

  it("uses pip size 0.0001 for non-JPY pairs", () => {
    const result = calculateRisk({
      pair: "GBP/USD",
      direction: "buy",
      entryPrice: 1.2650,
      stopLoss:   1.2550,   // 100 pips
      target1:    1.2950,   // 300 pips → 3:1
    });
    expect(result.stopDistancePips).toBeCloseTo(100, 0);
  });

  it("calculates RR correctly for a buy: (target - entry) / (entry - stop)", () => {
    const entry  = 1.0850;
    const stop   = 1.0800;
    const target = 1.1000;
    const expectedRR = (target - entry) / (entry - stop);  // 150/50 = 3
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "buy",
      entryPrice: entry,
      stopLoss:   stop,
      target1:    target,
    });
    if (result.isValid) {
      expect(result.rewardRiskRatio).toBeCloseTo(expectedRR, 1);
    }
  });

  it("rejects trade when RR < 3:1", () => {
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "buy",
      entryPrice: 1.0850,
      stopLoss:   1.0800,  // 50 pips
      target1:    1.0950,  // 100 pips → 2:1
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toMatch(/R:R ratio/i);
  });

  it("accepts a valid trade with RR >= 3:1", () => {
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "buy",
      entryPrice: 1.0850,
      stopLoss:   1.0800,  // 50 pips
      target1:    1.1000,  // 150 pips → 3:1
    });
    expect(result.isValid).toBe(true);
    expect(result.rewardRiskRatio).toBeGreaterThanOrEqual(3);
  });

  it("accountRiskPercent is correct (£100 / £10,000 = 1%)", () => {
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "buy",
      entryPrice: 1.0850,
      stopLoss:   1.0800,
      target1:    1.1000,
      accountSize: 10_000,
      maxRisk: 100,
    });
    if (result.isValid) {
      // Risk should be close to £100, so accountRiskPercent ≈ 1%
      expect(result.accountRiskPercent).toBeCloseTo(1, 0);
    }
  });

  it("rejects neutral direction", () => {
    const result = calculateRisk({
      pair: "EUR/USD",
      direction: "neutral",
      entryPrice: 1.0850,
      stopLoss:   1.0800,
      target1:    1.1000,
    });
    expect(result.isValid).toBe(false);
  });

  it("correctly sizes a sell trade", () => {
    const result = calculateRisk({
      pair: "GBP/USD",
      direction: "sell",
      entryPrice: 1.2650,
      stopLoss:   1.2750,  // 100 pip stop
      target1:    1.2350,  // 300 pip target → 3:1
    });
    expect(result.riskAmount).toBeLessThanOrEqual(100);
    if (result.isValid) {
      expect(result.rewardRiskRatio).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("calculatePipValue", () => {
  it("returns a positive pip value for EUR/USD at 1 lot", () => {
    const pv = calculatePipValue("EUR/USD", 1);
    expect(pv).toBeGreaterThan(0);
  });

  it("returns a positive pip value for USD/JPY at 1 lot", () => {
    const pv = calculatePipValue("USD/JPY", 1);
    expect(pv).toBeGreaterThan(0);
  });

  it("GBP/USD pip value is approximately £10 per standard lot", () => {
    // For GBP/USD: base = GBP, so 1 pip = 0.0001 * 100000 = £10
    const pv = calculatePipValue("GBP/USD", 1);
    expect(pv).toBeCloseTo(10, 0);
  });
});
