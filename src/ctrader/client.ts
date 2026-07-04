import { frameMessage, decodeFrame, fieldString, fieldVarint, fieldBytes, concat, decodeFields, str } from './proto.ts';

const DEMO_WS = 'wss://demo.ctraderapi.com:5036';

const PT = {
  APP_AUTH_REQ:       2100,
  APP_AUTH_RES:       2101,
  ACCOUNT_AUTH_REQ:   2102,
  ACCOUNT_AUTH_RES:   2103,
  NEW_ORDER_REQ:      2106,
  EXECUTION_EVENT:    2126,
  RECONCILE_REQ:      2124,
  RECONCILE_RES:      2125,
  CLOSE_POSITION_REQ: 2141,
  DEAL_LIST_REQ:      2154,
  DEAL_LIST_RES:      2155,
  ERROR_RES:          2142,
} as const;

// Pepperstone cTrader symbol IDs — fetched via getSymbols() and cached
// These defaults cover our Phase 1 pairs; adjust if IDs differ on your account
export const SYMBOL_IDS: Record<string, number> = {
  'EUR/USD': 1,
  'GBP/USD': 2,
  'USD/JPY': 3,
  'AUD/USD': 4,
  'EUR/GBP': 5,
  'GBP/CAD': 7,
};

export interface Position {
  positionId: number;
  symbolId:   number;
  symbol:     string;
  direction:  'buy' | 'sell';
  volume:     number;     // cTrader units (100 = 1 lot)
  openPrice:  number;
  stopLoss?:  number;
  takeProfit?: number;
  openTime:   number;
}

export interface Deal {
  dealId:      number;
  symbolId:    number;
  symbol:      string;
  direction:   'buy' | 'sell';
  volume:      number;
  entryPrice:  number;
  closePrice?: number;
  closeTime?:  number;
  profit?:     number;
}

interface CTraderConfig {
  clientId:     string;
  clientSecret: string;
  accessToken:  string;
  accountId:    number;
}

export class CTraderClient {
  constructor(private cfg: CTraderConfig) {}

  private async connect(): Promise<WebSocket> {
    const ws = new WebSocket(DEMO_WS);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open',  () => res());
      ws.addEventListener('error', () => rej(new Error('cTrader WebSocket failed to connect')));
    });
    return ws;
  }

  private send(ws: WebSocket, payloadType: number, payload: Uint8Array): void {
    ws.send(frameMessage(payloadType, payload));
  }

  private waitFor(ws: WebSocket, expectedType: number, timeoutMs = 12000): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cTrader timeout waiting for ${expectedType}`)), timeoutMs);
      const handler = (e: MessageEvent) => {
        const { payloadType, payload } = decodeFrame(e.data as ArrayBuffer);
        if (payloadType === PT.ERROR_RES) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          const f = decodeFields(payload);
          const code = f.get(2)?.[0] ?? '?';
          const desc = f.get(3)?.[0];
          reject(new Error(`cTrader error ${code}: ${desc instanceof Uint8Array ? str(desc) : desc}`));
          return;
        }
        if (payloadType === expectedType) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(payload);
        }
      };
      ws.addEventListener('message', handler);
    });
  }

  private async auth(ws: WebSocket): Promise<void> {
    this.send(ws, PT.APP_AUTH_REQ, concat(
      fieldString(1, this.cfg.clientId),
      fieldString(2, this.cfg.clientSecret),
    ));
    await this.waitFor(ws, PT.APP_AUTH_RES);

    this.send(ws, PT.ACCOUNT_AUTH_REQ, concat(
      fieldString(1, this.cfg.accessToken),
      fieldVarint(2, this.cfg.accountId),
    ));
    await this.waitFor(ws, PT.ACCOUNT_AUTH_RES);
  }

  async getPositions(): Promise<Position[]> {
    const ws = await this.connect();
    try {
      await this.auth(ws);
      this.send(ws, PT.RECONCILE_REQ, fieldVarint(1, this.cfg.accountId));
      const payload = await this.waitFor(ws, PT.RECONCILE_RES);
      return parsePositions(payload);
    } finally {
      ws.close();
    }
  }

  async closePosition(positionId: number, volume: number): Promise<void> {
    const ws = await this.connect();
    try {
      await this.auth(ws);
      this.send(ws, PT.CLOSE_POSITION_REQ, concat(
        fieldVarint(1, this.cfg.accountId),
        fieldVarint(2, positionId),
        fieldVarint(3, volume),
      ));
      await this.waitFor(ws, PT.EXECUTION_EVENT);
    } finally {
      ws.close();
    }
  }

  async placeOrder(params: {
    symbolId:    number;
    direction:   'buy' | 'sell';
    volume:      number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<void> {
    const ws = await this.connect();
    try {
      await this.auth(ws);
      const parts: Uint8Array[] = [
        fieldVarint(1, this.cfg.accountId),
        fieldVarint(2, params.symbolId),
        fieldVarint(3, 1),  // ORDER_TYPE_MARKET
        fieldVarint(4, params.direction === 'buy' ? 1 : 2),
        fieldVarint(5, params.volume),
      ];
      if (params.stopLoss)   parts.push(fieldVarint(9,  Math.round(params.stopLoss   * 100000)));
      if (params.takeProfit) parts.push(fieldVarint(10, Math.round(params.takeProfit * 100000)));
      this.send(ws, PT.NEW_ORDER_REQ, concat(...parts));
      await this.waitFor(ws, PT.EXECUTION_EVENT);
    } finally {
      ws.close();
    }
  }

  async getHistory(fromMs: number, toMs: number): Promise<Deal[]> {
    const ws = await this.connect();
    try {
      await this.auth(ws);
      this.send(ws, PT.DEAL_LIST_REQ, concat(
        fieldVarint(1, this.cfg.accountId),
        fieldVarint(2, fromMs),
        fieldVarint(3, toMs),
      ));
      const payload = await this.waitFor(ws, PT.DEAL_LIST_RES);
      return parseDeals(payload);
    } finally {
      ws.close();
    }
  }
}

function symbolName(id: number): string {
  return Object.entries(SYMBOL_IDS).find(([, v]) => v === id)?.[0] ?? `#${id}`;
}

function parsePositions(payload: Uint8Array): Position[] {
  const fields = decodeFields(payload);
  const items  = fields.get(2) ?? [];
  return items.flatMap(raw => {
    if (!(raw instanceof Uint8Array)) return [];
    const f = decodeFields(raw);
    const symbolId = f.get(2)?.[0] as number ?? 0;
    return [{
      positionId: f.get(1)?.[0]  as number ?? 0,
      symbolId,
      symbol:     symbolName(symbolId),
      direction:  (f.get(5)?.[0] as number) === 1 ? 'buy' : 'sell',
      volume:     f.get(3)?.[0]  as number ?? 0,
      openPrice:  ((f.get(6)?.[0] as number) ?? 0) / 100000,
      stopLoss:   f.get(9)  ? (f.get(9)![0]  as number) / 100000 : undefined,
      takeProfit: f.get(10) ? (f.get(10)![0] as number) / 100000 : undefined,
      openTime:   f.get(8)?.[0]  as number ?? 0,
    } satisfies Position];
  });
}

function parseDeals(payload: Uint8Array): Deal[] {
  const fields = decodeFields(payload);
  const items  = fields.get(2) ?? [];
  return items.flatMap(raw => {
    if (!(raw instanceof Uint8Array)) return [];
    const f = decodeFields(raw);
    const symbolId = f.get(3)?.[0] as number ?? 0;
    return [{
      dealId:     f.get(1)?.[0]  as number ?? 0,
      symbolId,
      symbol:     symbolName(symbolId),
      direction:  (f.get(5)?.[0] as number) === 1 ? 'buy' : 'sell',
      volume:     f.get(4)?.[0]  as number ?? 0,
      entryPrice: ((f.get(6)?.[0] as number) ?? 0) / 100000,
      closePrice: f.get(7)  ? (f.get(7)![0]  as number) / 100000 : undefined,
      closeTime:  f.get(9)?.[0]  as number,
      profit:     f.get(13) ? (f.get(13)![0] as number) / 100    : undefined,
    } satisfies Deal];
  });
}
