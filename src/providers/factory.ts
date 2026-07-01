import type { MarketDataProvider } from "./interface.ts";
import { MockMarketDataProvider } from "./mock.ts";
import { TwelveDataProvider } from "./twelvedata.ts";

export function createMarketDataProvider(config: {
  provider: string;
  apiKey?: string;
}): MarketDataProvider {
  if (config.apiKey) {
    return new TwelveDataProvider(config.apiKey);
  }

  switch (config.provider) {
    case "mock":
      return new MockMarketDataProvider();
    default:
      throw new Error(
        `Unknown market data provider: "${config.provider}". Valid options: "mock".`
      );
  }
}
