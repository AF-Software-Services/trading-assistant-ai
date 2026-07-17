import type { MarketDataProvider } from "./interface.ts";
import { MockMarketDataProvider } from "./mock.ts";
import { CTraderMarketDataProvider } from "./ctrader.ts";
import type { TradingService } from "../trading/service.ts";

export function createMarketDataProvider(config: {
  provider: string;
  trading?: TradingService | null;
}): MarketDataProvider {
  switch (config.provider) {
    case "mock":
      return new MockMarketDataProvider();
    case "ctrader":
      if (!config.trading) throw new Error("A connected cTrader account is required for the ctrader market data provider");
      return new CTraderMarketDataProvider(config.trading);
    default:
      throw new Error(`Unknown market data provider: "${config.provider}". Valid options: "mock", "ctrader".`);
  }
}
