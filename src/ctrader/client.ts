// @ts-ignore — cloudflare:sockets is a built-in Workers module
import { connect } from 'cloudflare:sockets';

const DEMO_HOST = 'demo.ctraderapi.com';
const DEMO_PORT = 5036;

const PT = {
  APP_AUTH_REQ:        2100,
  APP_AUTH_RES:        2101,
  ACCOUNT_AUTH_REQ:    2102,
  ACCOUNT_AUTH_RES:    2103,
  NEW_ORDER_REQ:       2106,
  CANCEL_ORDER_REQ:    2108,
  CLOSE_POSITION_REQ:  2111,
  AMEND_POSITION_REQ:  2117,  // modify SL / TP on open position
  RECONCILE_REQ:       2124,
  RECONCILE_RES:       2125,
  EXECUTION_EVENT:     2126,
  DEAL_LIST_REQ:       2133,
  DEAL_LIST_RES:       2134,
  ORDER_ERROR_EVENT:   2132,
  ERROR_RES:           2142,
} as const;

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
  volume:     number;
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

// ── JSON over raw TCP+TLS ─────────────────────────────────────────────────────
// cTrader Open API uses newline-delimited JSON messages on port 5036

type Payload = Record<string, unknown>;

class TcpConnection {
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private textBuf = '';

  async open(host: string, port: number): Promise<void> {
    const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
    this.writer  = socket.writable.getWriter();
    this.reader  = socket.readable.getReader();
  }

  async send(payloadType: number, payload: Payload): Promise<void> {
    const line = JSON.stringify({ payloadType, payload }) + '\n';
    await this.writer.write(new TextEncoder().encode(line));
  }

  async readMessage(): Promise<{ payloadType: number; payload: Payload }> {
    // Server sends JSON objects with no trailing newline — scan by brace depth
    while (true) {
      const end = findJsonEnd(this.textBuf);
      if (end !== -1) {
        const json = this.textBuf.slice(0, end + 1);
        this.textBuf = this.textBuf.slice(end + 1).trimStart();
        const msg = JSON.parse(json) as { payloadType: number; payload?: Payload };
        return { payloadType: msg.payloadType, payload: msg.payload ?? {} };
      }
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.textBuf.trim()) {
          const msg = JSON.parse(this.textBuf.trim()) as { payloadType: number; payload?: Payload };
          this.textBuf = '';
          return { payloadType: msg.payloadType, payload: msg.payload ?? {} };
        }
        throw new Error('TCP connection closed by server');
      }
      this.textBuf += new TextDecoder().decode(value);
    }
  }

  async waitFor(expectedType: number, timeoutMs = 15000): Promise<Payload> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const msg = await Promise.race([
        this.readMessage(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`cTrader timeout waiting for ${expectedType}`)), remaining)
        ),
      ]);
      if (msg.payloadType === PT.ERROR_RES) {
        const p = msg.payload as { errorCode?: string; description?: string };
        throw new Error(`cTrader error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
        const p = msg.payload as { errorCode?: string; description?: string };
        throw new Error(`cTrader order error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === expectedType) return msg.payload;
      // Heartbeats / other unsolicited messages — skip
    }
    throw new Error(`cTrader timeout waiting for ${expectedType}`);
  }

  close(): void {
    try { this.writer.close(); } catch { /* ignore */ }
  }
}

// Returns index of the closing `}` of the first complete JSON object in text, or -1
function findJsonEnd(text: string): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc)         { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')   { inStr = !inStr; continue; }
    if (inStr)       continue;
    if (c === '{')   depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ── Diagnostic ────────────────────────────────────────────────────────────────

export async function diagnoseCTrader(cfg: CTraderConfig): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const conn = new TcpConnection();
  try {
    steps.push('Opening TCP+TLS...');
    await conn.open(DEMO_HOST, DEMO_PORT);
    steps.push('Connected');

    await conn.send(PT.APP_AUTH_REQ, { clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    await conn.waitFor(PT.APP_AUTH_RES, 8000);
    steps.push('APP_AUTH_RES ✓');

    await conn.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: cfg.accountId, accessToken: cfg.accessToken });
    await conn.waitFor(PT.ACCOUNT_AUTH_RES, 8000);
    steps.push('ACCOUNT_AUTH_RES ✓');

    await conn.send(PT.RECONCILE_REQ, { ctidTraderAccountId: cfg.accountId });
    const rec = await conn.waitFor(PT.RECONCILE_RES, 8000);
    const positions = (rec.openPosition ?? []) as unknown[];
    steps.push(`RECONCILE_RES ✓ — ${positions.length} open positions`);
  } catch (e) {
    steps.push(`FAILED: ${(e as Error).message}`);
  } finally {
    conn.close();
  }
  return { steps };
}

// ── CTraderClient ──────────────────────────────────────────────────────────────

export class CTraderClient {
  constructor(private cfg: CTraderConfig) {}

  private async connect(): Promise<TcpConnection> {
    const conn = new TcpConnection();
    await conn.open(DEMO_HOST, DEMO_PORT);
    return conn;
  }

  private async auth(conn: TcpConnection): Promise<void> {
    await conn.send(PT.APP_AUTH_REQ, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret });
    await conn.waitFor(PT.APP_AUTH_RES);
    await conn.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.cfg.accountId, accessToken: this.cfg.accessToken });
    await conn.waitFor(PT.ACCOUNT_AUTH_RES);
  }

  async getPositions(): Promise<Position[]> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.cfg.accountId });
      const payload = await conn.waitFor(PT.RECONCILE_RES);
      return parsePositions(payload);
    } finally { conn.close(); }
  }

  async closePosition(positionId: number, volume: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.CLOSE_POSITION_REQ, {
        ctidTraderAccountId: this.cfg.accountId,
        positionId,
        volume,
      });
      await conn.waitFor(PT.EXECUTION_EVENT);
    } finally { conn.close(); }
  }

  async placeOrder(params: {
    symbolId:    number;
    direction:   'buy' | 'sell';
    lots:        number;
    limitPrice?: number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<{ orderId: number }> {
    // cTrader volume = units (1 lot = 100,000). Round to nearest 0.01 lot (1,000 units).
    const volume = Math.max(1000, Math.round(params.lots * 100) * 1000);
    const conn = await this.connect();
    try {
      await this.auth(conn);
      const payload: Payload = {
        ctidTraderAccountId: this.cfg.accountId,
        symbolId:   params.symbolId,
        orderType:  params.limitPrice ? 'LIMIT' : 'MARKET',
        tradeSide:  params.direction === 'buy' ? 'BUY' : 'SELL',
        volume,
      };
      if (params.limitPrice) payload.limitPrice   = params.limitPrice;
      if (params.stopLoss)   payload.stopLoss      = params.stopLoss;
      if (params.takeProfit) payload.takeProfit    = params.takeProfit;
      if (params.limitPrice) payload.timeInForce   = 'GOOD_TILL_CANCEL';
      await conn.send(PT.NEW_ORDER_REQ, payload);
      const evt = await conn.waitFor(PT.EXECUTION_EVENT);
      return { orderId: parseOrderId(evt) };
    } finally { conn.close(); }
  }

  async amendPosition(positionId: number, stopLoss: number, takeProfit?: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      const payload: Payload = {
        ctidTraderAccountId: this.cfg.accountId,
        positionId,
        stopLoss,
      };
      if (takeProfit !== undefined) payload.takeProfit = takeProfit;
      await conn.send(PT.AMEND_POSITION_REQ, payload);
      await conn.waitFor(PT.EXECUTION_EVENT);
    } finally { conn.close(); }
  }

  async cancelOrder(orderId: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.CANCEL_ORDER_REQ, { ctidTraderAccountId: this.cfg.accountId, orderId });
      await conn.waitFor(PT.EXECUTION_EVENT);
    } finally { conn.close(); }
  }

  async getHistory(fromMs: number, toMs: number): Promise<Deal[]> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.DEAL_LIST_REQ, {
        ctidTraderAccountId: this.cfg.accountId,
        fromTimestamp: fromMs,
        toTimestamp:   toMs,
      });
      const payload = await conn.waitFor(PT.DEAL_LIST_RES);
      return parseDeals(payload);
    } finally { conn.close(); }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function symbolName(id: number): string {
  return Object.entries(SYMBOL_IDS).find(([, v]) => v === id)?.[0] ?? `#${id}`;
}

function parseOrderId(payload: Payload): number {
  const order    = payload.order    as Record<string, unknown> | undefined;
  const position = payload.position as Record<string, unknown> | undefined;
  return (order?.orderId ?? position?.positionId ?? 0) as number;
}

function parsePositions(payload: Payload): Position[] {
  const items = (payload.openPosition ?? []) as Record<string, unknown>[];
  return items.map(pos => {
    const td = pos.tradeData as Record<string, unknown> ?? {};
    const symbolId = (td.symbolId ?? 0) as number;
    return {
      positionId: (pos.positionId ?? pos.id ?? 0) as number,
      symbolId,
      symbol:     symbolName(symbolId),
      direction:  td.tradeSide === 'BUY' ? 'buy' : 'sell',
      volume:     (td.volume ?? 0) as number,
      openPrice:  (pos.price ?? 0) as number,
      stopLoss:   pos.stopLoss  as number | undefined,
      takeProfit: pos.takeProfit as number | undefined,
      openTime:   (td.openTimestamp ?? 0) as number,
    } satisfies Position;
  });
}

function parseDeals(payload: Payload): Deal[] {
  const items = (payload.deal ?? []) as Record<string, unknown>[];
  return items.map(deal => {
    const symbolId = (deal.symbolId ?? 0) as number;
    const cpd = deal.closePositionDetail as Record<string, unknown> | undefined;
    return {
      dealId:     (deal.dealId ?? 0) as number,
      symbolId,
      symbol:     symbolName(symbolId),
      direction:  deal.tradeSide === 'BUY' ? 'buy' : 'sell',
      volume:     (deal.filledVolume ?? 0) as number,
      entryPrice: (deal.executionPrice ?? 0) as number,
      closePrice: cpd?.entryPrice as number | undefined,
      closeTime:  deal.executionTimestamp as number | undefined,
      profit:     (cpd?.grossProfit ?? cpd?.profit) as number | undefined,
    } satisfies Deal;
  });
}
