import { CTraderClient } from "../ctrader/client.ts";
import type { Position, Deal }        from "../ctrader/client.ts";
import type { CTraderAccount }        from "../ctrader/account-types.ts";
import { tokenKey }                   from "../ctrader/account-types.ts";

export type { Position, Deal };

export interface CTraderEnv {
  KV:                    KVNamespace;
  CTRADER_CLIENT_ID:     string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID:    string;
}

export class TradingService {
  private constructor(private readonly client: CTraderClient) {}

  /** Connect to a specific account stored in the accounts table. */
  static async connectToAccount(
    env: Pick<CTraderEnv, 'KV' | 'CTRADER_CLIENT_ID' | 'CTRADER_CLIENT_SECRET'>,
    account: CTraderAccount,
  ): Promise<TradingService> {
    const token = await env.KV.get(tokenKey(account.id));
    if (!token) throw new Error(`cTrader account "${account.name}" is not connected`);
    return new TradingService(buildClientForAccount(env, account, token));
  }

  /** Connect to a specific account, returns null if not connected. */
  static async tryConnectToAccount(
    env: Pick<CTraderEnv, 'KV' | 'CTRADER_CLIENT_ID' | 'CTRADER_CLIENT_SECRET'>,
    account: CTraderAccount,
  ): Promise<TradingService | null> {
    const token = await env.KV.get(tokenKey(account.id));
    if (!token) return null;
    return new TradingService(buildClientForAccount(env, account, token));
  }

  /** Legacy: connect using env vars + global KV token (single-account mode). */
  static async connect(env: CTraderEnv): Promise<TradingService> {
    const token = await env.KV.get("ctrader:access_token");
    if (!token) throw new Error("Not connected to cTrader");
    return new TradingService(buildClientFromEnv(env, token));
  }

  /** Legacy: connect or return null if no token. */
  static async tryConnect(env: CTraderEnv): Promise<TradingService | null> {
    const token = await env.KV.get("ctrader:access_token");
    if (!token) return null;
    return new TradingService(buildClientFromEnv(env, token));
  }

  async placeOrder(params: {
    pair:        string;
    direction:   "buy" | "sell";
    lots:        number;
    limitPrice?: number;
    stopLoss?:   number;
    takeProfit?: number;
    trailingStopLoss?: boolean;
  }): Promise<{ orderId: number }> {
    return this.client.placeOrder({
      pair:       params.pair,
      direction:  params.direction,
      lots:       params.lots,
      limitPrice: params.limitPrice,
      stopLoss:   params.stopLoss,
      takeProfit: params.takeProfit,
      trailingStopLoss: params.trailingStopLoss,
    });
  }

  async getPositions(): Promise<Position[]> {
    return this.client.getPositions();
  }

  async getBalance(): Promise<{ balance: number; traderLogin: number | null }> {
    return this.client.getBalance();
  }

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

  async amendPosition(positionId: number, stopLoss: number, takeProfit?: number, pair?: string, trailingStopLoss?: boolean): Promise<void> {
    return this.client.amendPosition(positionId, stopLoss, takeProfit, pair, trailingStopLoss);
  }

  async getHistory(fromMs: number, toMs: number): Promise<Deal[]> {
    return this.client.getHistory(fromMs, toMs);
  }

  async resolveSymbolId(pair: string): Promise<number> {
    return this.client.resolveSymbolId(pair);
  }

  async getTrendbars(symbolId: number, period: number, count: number, toTimestamp?: number) {
    return this.client.getTrendbars(symbolId, period, count, toTimestamp);
  }
}

function buildClientForAccount(
  env: Pick<CTraderEnv, 'CTRADER_CLIENT_ID' | 'CTRADER_CLIENT_SECRET'>,
  account: CTraderAccount,
  token: string,
): CTraderClient {
  return new CTraderClient({
    clientId:     env.CTRADER_CLIENT_ID,
    clientSecret: env.CTRADER_CLIENT_SECRET,
    accessToken:  token,
    accountId:    parseInt(account.ctraderAccountId),
    accountType:  account.type,
  });
}

function buildClientFromEnv(env: CTraderEnv, token: string): CTraderClient {
  return new CTraderClient({
    clientId:     env.CTRADER_CLIENT_ID,
    clientSecret: env.CTRADER_CLIENT_SECRET,
    accessToken:  token,
    accountId:    parseInt(env.CTRADER_ACCOUNT_ID),
    accountType:  'demo',
  });
}
