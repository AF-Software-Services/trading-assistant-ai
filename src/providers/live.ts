import type { MarketDataProvider } from "./interface.ts";
import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";

class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * LiveMarketDataProvider — placeholder for a real broker/data feed integration.
 *
 * To implement:
 * 1. Accept API credentials in the constructor (api key, account id, base URL).
 * 2. Implement getCandles() by calling the broker REST endpoint and mapping
 *    the response to Candle[].
 * 3. Implement getLatestPrice() similarly.
 *
 * Compatible providers: OANDA v20 REST API, Twelve Data, Alpha Vantage.
 */
export class LiveMarketDataProvider implements MarketDataProvider {
  constructor(_credentials: { apiKey: string; accountId?: string; baseUrl?: string }) {
    console.warn(
      "[LiveMarketDataProvider] Live market data provider is not yet implemented. " +
      "Switch MARKET_DATA_PROVIDER to 'mock' for development."
    );
  }

  async getCandles(
    _pair: CurrencyPair,
    _timeframe: Timeframe,
    _count: number
  ): Promise<Candle[]> {
    throw new NotImplementedError(
      "LiveMarketDataProvider.getCandles() is not implemented. " +
      "Integrate a real data feed (OANDA, Twelve Data, etc.) and implement this method."
    );
  }

  async getLatestPrice(_pair: CurrencyPair): Promise<PriceTick> {
    throw new NotImplementedError(
      "LiveMarketDataProvider.getLatestPrice() is not implemented. " +
      "Integrate a real data feed (OANDA, Twelve Data, etc.) and implement this method."
    );
  }
}
