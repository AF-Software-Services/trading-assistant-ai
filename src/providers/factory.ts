import type { MarketDataProvider } from "./interface.ts";
import { MockMarketDataProvider } from "./mock.ts";

export function createMarketDataProvider(config: { provider: string }): MarketDataProvider {
  switch (config.provider) {
    case "mock":
      return new MockMarketDataProvider();

    case "live":
      // LiveMarketDataProvider requires credentials — do not instantiate without them.
      // When implementing live support, pass credentials from env bindings here.
      throw new Error(
        "Live market data provider is not yet implemented. " +
        "Set MARKET_DATA_PROVIDER=mock in wrangler.toml for development."
      );

    default:
      throw new Error(
        `Unknown market data provider: "${config.provider}". ` +
        `Valid options: "mock", "live".`
      );
  }
}
