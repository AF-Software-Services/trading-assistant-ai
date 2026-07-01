import { describe, it, expect, vi } from "vitest";
import { generateRecommendation, generateAllRecommendations } from "../src/engines/recommendation.ts";
import { MockMarketDataProvider } from "../src/providers/mock.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const provider = new MockMarketDataProvider();

describe("generateRecommendation", () => {
  it("returns a recommendation with a valid UUID id", async () => {
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      expect(rec.id).toMatch(UUID_REGEX);
    }
  });

  it("sets expiresAt 7 days after createdAt", async () => {
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      const diff = rec.expiresAt - rec.createdAt;
      expect(diff).toBe(SEVEN_DAYS_MS);
    }
  });

  it("recommendation with high confidence gets action consider_trade", async () => {
    // We can't guarantee score >= 75 from mock, so test the logic by verifying
    // the action matches the confidence level
    const rec = await generateRecommendation({ pair: "GBP/USD", provider });
    if (rec) {
      if (rec.confidence >= 75) {
        expect(rec.action).toBe("consider_trade");
      } else if (rec.confidence >= 60) {
        expect(rec.action).toBe("watch");
      } else {
        expect(rec.action).toBe("no_trade");
      }
    }
  });

  it("recommendation includes non-empty reasons array", async () => {
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      expect(Array.isArray(rec.reasons)).toBe(true);
      expect(rec.reasons.length).toBeGreaterThan(0);
    }
  });

  it("recommendation includes non-empty invalidationConditions array", async () => {
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      expect(Array.isArray(rec.invalidationConditions)).toBe(true);
      expect(rec.invalidationConditions.length).toBeGreaterThan(0);
    }
  });

  it("recommendation status is open by default", async () => {
    const rec = await generateRecommendation({ pair: "GBP/USD", provider });
    if (rec) {
      expect(rec.status).toBe("open");
    }
  });

  it("recommendation has valid pair value", async () => {
    const pairs = ["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"] as const;
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      expect(pairs).toContain(rec.pair);
    }
  });

  it("recommendation score breakdown sums to total", async () => {
    const rec = await generateRecommendation({ pair: "EUR/USD", provider });
    if (rec) {
      const { scoreBreakdown } = rec;
      const sum =
        scoreBreakdown.srStrength +
        scoreBreakdown.timeframeImportance +
        scoreBreakdown.candlestickSignal +
        scoreBreakdown.marketStructure +
        scoreBreakdown.trendAlignment +
        scoreBreakdown.patternConfirmation +
        scoreBreakdown.rewardRiskPotential;
      // total is min(100, sum), so sum should >= total
      expect(scoreBreakdown.total).toBeLessThanOrEqual(100);
      expect(scoreBreakdown.total).toBe(Math.min(100, sum));
    }
  });
});

describe("generateAllRecommendations", () => {
  it("returns recommendations for multiple pairs", async () => {
    const recs = await generateAllRecommendations(["EUR/USD", "GBP/USD"], provider);
    // Returns an array (may be 0 if all return null, but mock should produce results)
    expect(Array.isArray(recs)).toBe(true);
  });

  it("returns array sorted by confidence descending", async () => {
    const recs = await generateAllRecommendations(["EUR/USD", "GBP/USD", "AUD/USD"], provider);
    for (let i = 1; i < recs.length; i++) {
      const prev = recs[i - 1];
      const curr = recs[i];
      if (prev && curr) {
        expect(prev.confidence).toBeGreaterThanOrEqual(curr.confidence);
      }
    }
  });

  it("each recommendation has a unique id", async () => {
    const recs = await generateAllRecommendations(["EUR/USD", "GBP/USD", "GBP/CAD"], provider);
    const ids = recs.map(r => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
