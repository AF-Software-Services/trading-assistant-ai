import { CTraderClient, SYMBOL_IDS } from "../ctrader/client.ts";
import type { Position, Deal }        from "../ctrader/client.ts";

export type { Position, Deal };

export interface CTraderEnv {
  KV:                    KVNamespace;
  CTRADER_CLIENT_ID:     string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID:    string;
}

/**
 * Domain service for live trading operations.
 *
 * Owns the pattern: resolve token → build CTraderClient → call API.
 * Callers work with pair names and domain concepts (lots, pairs);
 * protocol details (symbolIds, volume units) stay inside this layer.
 */
export class TradingService {
  private constructor(private readonly client: CTraderClient) {}

  /** Connects or throws if no token is stored. */
  static async connect(env: CTraderEnv): Promise<TradingService> {
    const token = await env.KV.get("ctrader:access_token");
    if (!token) throw new Error("Not connected to cTrader");
    return new TradingService(TradingService.buildClient(env, token));
  }

  /** Connects or returns null — use when cTrader is optional. */
  static async tryConnect(env: CTraderEnv): Promise<TradingService | null> {
    const token = await env.KV.get("ctrader:access_token");
    if (!token) return null;
    return new TradingService(TradingService.buildClient(env, token));
  }

  private static buildClient(env: CTraderEnv, token: string): CTraderClient {
    return new CTraderClient({
      clientId:     env.CTRADER_CLIENT_ID,
      clientSecret: env.CTRADER_CLIENT_SECRET,
      accessToken:  token,
      accountId:    parseInt(env.CTRADER_ACCOUNT_ID),
    });
  }

  async placeOrder(params: {
    pair:        string;
    direction:   "buy" | "sell";
    lots:        number;
    limitPrice?: number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<{ orderId: number }> {
    const symbolId = SYMBOL_IDS[params.pair];
    if (!symbolId) throw new Error(`Unknown pair: ${params.pair}`);
    return this.client.placeOrder({
      symbolId,
      direction:  params.direction,
      lots:       params.lots,
      limitPrice: params.limitPrice,
      stopLoss:   params.stopLoss,
      takeProfit: params.takeProfit,
    });
  }

  async getPositions(): Promise<Position[]> {
    return this.client.getPositions();
  }

  /**
   * Closes a position. If volume is not supplied, fetches it from open positions.
   * Throws if the position cannot be found.
   */
  async closePosition(positionId: number, volume?: number): Promise<void> {
    let vol = volume;
    if (vol === undefined) {
      const positions = await this.client.getPositions();
      const pos = positions.find(p => p.positionId === positionId);
      if (!pos) throw new Error(`Position ${positionId} not found`);
      vol = pos.volume;
    }
    return this.client.closePosition(positionId, vol);
  }

  async cancelOrder(orderId: number): Promise<void> {
    return this.client.cancelOrder(orderId);
  }

  async amendPosition(positionId: number, stopLoss: number, takeProfit?: number): Promise<void> {
    return this.client.amendPosition(positionId, stopLoss, takeProfit);
  }

  async getHistory(fromMs: number, toMs: number): Promise<Deal[]> {
    return this.client.getHistory(fromMs, toMs);
  }
}
