// @ts-ignore — cloudflare:sockets is a built-in Workers module
import { connect } from 'cloudflare:sockets';

const DEMO_HOST = 'demo.ctraderapi.com';
const LIVE_HOST = 'live.ctraderapi.com';
const API_PORT  = 5035;

// cTrader Open API payload types (ProtoOAPayloadType), from spotware/openapi-proto-messages
const PT = {
  APP_AUTH_REQ:             2100,
  APP_AUTH_RES:             2101,
  ACCOUNT_AUTH_REQ:         2102,
  ACCOUNT_AUTH_RES:         2103,
  NEW_ORDER_REQ:            2106,
  CANCEL_ORDER_REQ:         2108,
  AMEND_POSITION_SLTP_REQ:  2110,
  CLOSE_POSITION_REQ:       2111,
  SYMBOLS_LIST_REQ:         2114,
  SYMBOLS_LIST_RES:         2115,
  SYMBOL_BY_ID_REQ:         2116,
  SYMBOL_BY_ID_RES:         2117,
  TRADER_REQ:               2121,
  TRADER_RES:               2122,
  RECONCILE_REQ:            2124,
  RECONCILE_RES:            2125,
  EXECUTION_EVENT:          2126,
  ORDER_ERROR_EVENT:        2132,
  DEAL_LIST_REQ:            2133,
  DEAL_LIST_RES:            2134,
  ERROR_RES:                2142,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_TOKEN_RES: 2150,
  GET_TRENDBARS_REQ:        2137,
  GET_TRENDBARS_RES:        2138,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Minimal Protobuf (proto2) wire-format codec.
// cTrader's Open API TCP endpoint speaks length-prefixed Protobuf, not JSON —
// every message is: [4-byte big-endian length][ProtoMessage bytes], where
// ProtoMessage = { payloadType: varint(1), payload: bytes(2) }, and `payload`
// itself is the encoded inner message (ProtoOANewOrderReq, etc).
// We only implement the field types this app actually uses: varint, double,
// string, bytes, and nested messages — enough to cover every schema below.
// ═══════════════════════════════════════════════════════════════════════════

type WireField =
  | { t: 'varint' }
  | { t: 'double' }
  | { t: 'string' }
  | { t: 'bytes' }
  | { t: 'message'; schema: MessageSchema };

interface FieldSpec { no: number; type: WireField; repeated?: boolean }
type MessageSchema = Record<string, FieldSpec>;

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.round(value));
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function decodeVarint(buf: Uint8Array, offset: number): [number, number] {
  // proto2 encodes negative int32/int64 as the full 64-bit two's-complement value,
  // sign-extended into a 10-byte varint — not a small number. Decode via BigInt so
  // those 10-byte values don't silently overflow into IEEE754 garbage, then
  // reinterpret anything >= 2^63 as negative. (Our real fields — balances, volumes,
  // timestamps, IDs — never legitimately reach 2^63, so this is safe to apply always.)
  let result = 0n, shift = 0n, pos = offset;
  while (true) {
    const b = buf[pos++] ?? 0;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  if (result >= (1n << 63n)) result -= (1n << 64n);
  return [Number(result), pos];
}

function encodeDouble(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return new Uint8Array(buf);
}

function decodeDouble(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true);
}

function writeTag(no: number, wireType: number, out: number[]): void {
  out.push(...encodeVarint((no << 3) | wireType));
}

function encodeField(no: number, type: WireField, value: unknown, out: number[]): void {
  switch (type.t) {
    case 'varint':
      writeTag(no, 0, out);
      out.push(...encodeVarint(value as number));
      break;
    case 'double':
      writeTag(no, 1, out);
      out.push(...encodeDouble(value as number));
      break;
    case 'string': {
      const bytes = new TextEncoder().encode(value as string);
      writeTag(no, 2, out);
      out.push(...encodeVarint(bytes.length), ...bytes);
      break;
    }
    case 'bytes': {
      const bytes = value as Uint8Array;
      writeTag(no, 2, out);
      out.push(...encodeVarint(bytes.length), ...bytes);
      break;
    }
    case 'message': {
      const inner = encodeMessage(type.schema, value as Record<string, unknown>);
      writeTag(no, 2, out);
      out.push(...encodeVarint(inner.length), ...inner);
      break;
    }
  }
}

function encodeMessage(schema: MessageSchema, obj: Record<string, unknown>): Uint8Array {
  const out: number[] = [];
  for (const key of Object.keys(schema)) {
    const spec  = schema[key]!;
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (spec.repeated) {
      for (const v of value as unknown[]) encodeField(spec.no, spec.type, v, out);
    } else {
      encodeField(spec.no, spec.type, value, out);
    }
  }
  return new Uint8Array(out);
}

function decodeMessage(schema: MessageSchema, buf: Uint8Array): Record<string, any> {
  const byNo = new Map<number, { key: string; spec: FieldSpec }>();
  for (const key of Object.keys(schema)) byNo.set(schema[key]!.no, { key, spec: schema[key]! });

  const result: Record<string, any> = {};
  let offset = 0;
  while (offset < buf.length) {
    const [tag, afterTag] = decodeVarint(buf, offset);
    offset = afterTag;
    const fieldNo  = Math.floor(tag / 8);
    const wireType = tag % 8;
    const entry    = byNo.get(fieldNo);

    let value: unknown;
    if (wireType === 0) {
      const [v, next] = decodeVarint(buf, offset);
      offset = next;
      value = v;
    } else if (wireType === 1) {
      value = decodeDouble(buf, offset);
      offset += 8;
    } else if (wireType === 2) {
      const [len, next] = decodeVarint(buf, offset);
      offset = next;
      const slice = buf.subarray(offset, offset + len);
      offset += len;
      if (entry?.spec.type.t === 'message') value = decodeMessage(entry.spec.type.schema, slice);
      else if (entry?.spec.type.t === 'bytes') value = slice;
      else value = new TextDecoder().decode(slice);
    } else if (wireType === 5) {
      offset += 4; // 32-bit fixed, unused by our schemas — skip
      continue;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }

    if (!entry) continue; // unknown field — already skipped correctly above
    if (entry.spec.repeated) (result[entry.key] ??= []).push(value);
    else result[entry.key] = value;
  }
  return result;
}

const ENVELOPE_SCHEMA: MessageSchema = {
  payloadType: { no: 1, type: { t: 'varint' } },
  payload:     { no: 2, type: { t: 'bytes' } },
};

function frameMessage(payloadType: number, payloadBytes: Uint8Array): Uint8Array {
  const env: number[] = [];
  writeTag(1, 0, env);
  env.push(...encodeVarint(payloadType));
  writeTag(2, 2, env);
  env.push(...encodeVarint(payloadBytes.length), ...payloadBytes);

  const len = env.length;
  const framed = new Uint8Array(4 + len);
  framed[0] = (len >>> 24) & 0xff;
  framed[1] = (len >>> 16) & 0xff;
  framed[2] = (len >>> 8)  & 0xff;
  framed[3] = len & 0xff;
  framed.set(env, 4);
  return framed;
}

// ── Message schemas (only the fields this app reads/writes) ───────────────────

const APP_AUTH_REQ_SCHEMA: MessageSchema = {
  clientId:     { no: 2, type: { t: 'string' } },
  clientSecret: { no: 3, type: { t: 'string' } },
};
const ACCOUNT_AUTH_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  accessToken:          { no: 3, type: { t: 'string' } },
};
const ERROR_RES_SCHEMA: MessageSchema = {
  errorCode:   { no: 3, type: { t: 'string' } },
  description: { no: 4, type: { t: 'string' } },
};
const ORDER_ERROR_EVENT_SCHEMA: MessageSchema = {
  errorCode:   { no: 2, type: { t: 'string' } },
  orderId:     { no: 3, type: { t: 'varint' } },
  positionId:  { no: 6, type: { t: 'varint' } },
  description: { no: 7, type: { t: 'string' } },
};
const NEW_ORDER_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2,  type: { t: 'varint' } },
  symbolId:             { no: 3,  type: { t: 'varint' } },
  orderType:            { no: 4,  type: { t: 'varint' } },
  tradeSide:            { no: 5,  type: { t: 'varint' } },
  volume:               { no: 6,  type: { t: 'varint' } },
  limitPrice:           { no: 7,  type: { t: 'double' } },
  timeInForce:          { no: 9,  type: { t: 'varint' } },
  stopLoss:             { no: 11, type: { t: 'double' } },
  takeProfit:           { no: 12, type: { t: 'double' } },
};
const CANCEL_ORDER_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  orderId:              { no: 3, type: { t: 'varint' } },
};
const AMEND_POSITION_SLTP_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  positionId:           { no: 3, type: { t: 'varint' } },
  stopLoss:             { no: 4, type: { t: 'double' } },
  takeProfit:           { no: 5, type: { t: 'double' } },
};
const CLOSE_POSITION_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  positionId:           { no: 3, type: { t: 'varint' } },
  volume:               { no: 4, type: { t: 'varint' } },
};
const SYMBOLS_LIST_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
};
const LIGHT_SYMBOL_SCHEMA: MessageSchema = {
  symbolId:   { no: 1, type: { t: 'varint' } },
  symbolName: { no: 2, type: { t: 'string' } },
};
const SYMBOLS_LIST_RES_SCHEMA: MessageSchema = {
  symbol: { no: 3, type: { t: 'message', schema: LIGHT_SYMBOL_SCHEMA }, repeated: true },
};
const SYMBOL_BY_ID_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  symbolId:             { no: 3, type: { t: 'varint' }, repeated: true },
};
const SYMBOL_SCHEMA: MessageSchema = {
  symbolId:   { no: 1,  type: { t: 'varint' } },
  minVolume:  { no: 10, type: { t: 'varint' } },
  stepVolume: { no: 11, type: { t: 'varint' } },
  lotSize:    { no: 30, type: { t: 'varint' } },
};
const SYMBOL_BY_ID_RES_SCHEMA: MessageSchema = {
  symbol: { no: 3, type: { t: 'message', schema: SYMBOL_SCHEMA }, repeated: true },
};
const GET_TRENDBARS_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  fromTimestamp:        { no: 3, type: { t: 'varint' } },
  toTimestamp:           { no: 4, type: { t: 'varint' } },
  period:                { no: 5, type: { t: 'varint' } },
  symbolId:              { no: 6, type: { t: 'varint' } },
  count:                 { no: 7, type: { t: 'varint' } },
};
const TRENDBAR_SCHEMA: MessageSchema = {
  volume:                { no: 3, type: { t: 'varint' } },
  period:                { no: 4, type: { t: 'varint' } },
  low:                   { no: 5, type: { t: 'varint' } },
  deltaOpen:             { no: 6, type: { t: 'varint' } },
  deltaClose:            { no: 7, type: { t: 'varint' } },
  deltaHigh:             { no: 8, type: { t: 'varint' } },
  utcTimestampInMinutes: { no: 9, type: { t: 'varint' } },
};
const GET_TRENDBARS_RES_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  period:                { no: 3, type: { t: 'varint' } },
  trendbar:              { no: 5, type: { t: 'message', schema: TRENDBAR_SCHEMA }, repeated: true },
  symbolId:              { no: 6, type: { t: 'varint' } },
  hasMore:               { no: 7, type: { t: 'varint' } },
};
const TRADER_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
};
const TRADER_SCHEMA: MessageSchema = {
  balance:     { no: 2,  type: { t: 'varint' } },
  traderLogin: { no: 14, type: { t: 'varint' } }, // broker-assigned account login (shown in Pepperstone's UI) — different from ctidTraderAccountId
  moneyDigits: { no: 20, type: { t: 'varint' } },
};
const TRADER_RES_SCHEMA: MessageSchema = {
  trader: { no: 3, type: { t: 'message', schema: TRADER_SCHEMA } },
};
const RECONCILE_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
};
const TRADE_DATA_SCHEMA: MessageSchema = {
  symbolId:      { no: 1, type: { t: 'varint' } },
  volume:        { no: 2, type: { t: 'varint' } },
  tradeSide:     { no: 3, type: { t: 'varint' } },
  openTimestamp: { no: 4, type: { t: 'varint' } },
};
const POSITION_SCHEMA: MessageSchema = {
  positionId: { no: 1, type: { t: 'varint' } },
  tradeData:  { no: 2, type: { t: 'message', schema: TRADE_DATA_SCHEMA } },
  price:      { no: 5, type: { t: 'double' } },
  stopLoss:   { no: 6, type: { t: 'double' } },
  takeProfit: { no: 7, type: { t: 'double' } },
};
const RECONCILE_RES_SCHEMA: MessageSchema = {
  position: { no: 3, type: { t: 'message', schema: POSITION_SCHEMA }, repeated: true },
};
const ORDER_MINI_SCHEMA: MessageSchema = {
  orderId: { no: 1, type: { t: 'varint' } },
};
const EXECUTION_EVENT_SCHEMA: MessageSchema = {
  executionType: { no: 3, type: { t: 'varint' } },
  position:      { no: 4, type: { t: 'message', schema: POSITION_SCHEMA } },
  order:         { no: 5, type: { t: 'message', schema: ORDER_MINI_SCHEMA } },
  errorCode:     { no: 9, type: { t: 'string' } },
};
const DEAL_LIST_REQ_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 2, type: { t: 'varint' } },
  fromTimestamp:        { no: 3, type: { t: 'varint' } },
  toTimestamp:          { no: 4, type: { t: 'varint' } },
};
const CLOSE_POSITION_DETAIL_SCHEMA: MessageSchema = {
  entryPrice:  { no: 1, type: { t: 'double' } },
  grossProfit: { no: 2, type: { t: 'varint' } },
  moneyDigits: { no: 9, type: { t: 'varint' } },
};
const DEAL_SCHEMA: MessageSchema = {
  dealId:              { no: 1,  type: { t: 'varint' } },
  positionId:          { no: 3,  type: { t: 'varint' } },
  filledVolume:        { no: 5,  type: { t: 'varint' } },
  symbolId:             { no: 6,  type: { t: 'varint' } },
  executionTimestamp:   { no: 8,  type: { t: 'varint' } },
  executionPrice:       { no: 10, type: { t: 'double' } },
  tradeSide:            { no: 11, type: { t: 'varint' } },
  closePositionDetail:  { no: 16, type: { t: 'message', schema: CLOSE_POSITION_DETAIL_SCHEMA } },
};
const DEAL_LIST_RES_SCHEMA: MessageSchema = {
  deal: { no: 3, type: { t: 'message', schema: DEAL_SCHEMA }, repeated: true },
};

// Enum values (ProtoOATradeSide, ProtoOAOrderType, ProtoOATimeInForce, ProtoOAExecutionType)
const TRADE_SIDE = { BUY: 1, SELL: 2 } as const;
const ORDER_TYPE = { MARKET: 1, LIMIT: 2 } as const;
const TIME_IN_FORCE_GTC = 2;
const EXEC_TYPE = {
  ACCEPTED: 2, FILLED: 3, REPLACED: 4, CANCELLED: 5,
  REJECTED: 7, CANCEL_REJECTED: 8,
} as const;

// ── Symbol ID caches (module-level, persist across requests in one worker instance) ──
// Keyed by numeric cTrader accountId so demo and live accounts stay separate.
const symbolIdByName = new Map<number, Map<string, number>>();  // accountId → normalised-name → symbolId
const symbolPairName = new Map<number, Map<number, string>>();  // accountId → symbolId → "EUR/USD"

// Hardcoded fallback — only used when the broker's symbol list hasn't been fetched yet
// or the pair isn't found in it. IDs here are broker-specific; the dynamic
// lookup (ensureSymbolCache) is the source of truth for Pepperstone/other brokers.
export const SYMBOL_IDS: Record<string, number> = {
  'EUR/USD': 1,
  'GBP/USD': 2,
  'USD/JPY': 3,
  'AUD/USD': 4,
  'EUR/GBP': 5,
  'GBP/CAD': 7,
  'US500':    115,
  'NAS100':   116,
  'GER40':    110,
  'UK100':    113,
  'XAU/USD':  41,
  'XAG/USD':  42,
  'WTI/USD':  250,  // Pepperstone calls this "SpotCrude"
  'BRENT/USD': 249, // Pepperstone calls this "SpotBrent"
  'NATGAS':   251,
  'COPPER':   109,
};

// "EUR/USD" → "EURUSD", already normalised passes through unchanged
function normalizePair(pair: string): string {
  return pair.replace('/', '').toUpperCase();
}

// "EURUSD" → "EUR/USD" (all major pairs are 6 chars = 3+3)
function formatPair(raw: string): string {
  if (raw.includes('/')) return raw;
  return raw.length === 6 ? `${raw.slice(0, 3)}/${raw.slice(3)}` : raw;
}

// Volume constraint cache (symbolId → broker constraints)
const symbolInfoCache = new Map<number, { lotSize: number; stepVolume: number; minVolume: number }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureSymbolCache(conn: TcpConnection, accountId: number): Promise<void> {
  if (symbolIdByName.has(accountId)) return;

  await conn.send(PT.SYMBOLS_LIST_REQ, SYMBOLS_LIST_REQ_SCHEMA, { ctidTraderAccountId: accountId });
  const res     = await conn.waitFor(PT.SYMBOLS_LIST_RES, SYMBOLS_LIST_RES_SCHEMA, 15000);
  const symbols = (res['symbol'] ?? []) as Array<{ symbolId: number; symbolName: string }>;

  const byName = new Map<string, number>();
  const byId   = new Map<number, string>();

  for (const sym of symbols) {
    const norm      = normalizePair(sym.symbolName);
    const formatted = formatPair(sym.symbolName);
    byName.set(norm, sym.symbolId);
    byId.set(sym.symbolId, formatted);
  }

  // Merge hardcoded fallback for any pair the live list didn't include
  for (const [pair, id] of Object.entries(SYMBOL_IDS)) {
    const norm = normalizePair(pair);
    if (!byName.has(norm)) byName.set(norm, id);
    if (!byId.has(id))     byId.set(id, pair);
  }

  symbolIdByName.set(accountId, byName);
  symbolPairName.set(accountId, byId);
}

function lookupSymbolId(accountId: number, pair: string): number | undefined {
  return symbolIdByName.get(accountId)?.get(normalizePair(pair)) ?? SYMBOL_IDS[pair];
}

function lookupSymbolName(accountId: number, symbolId: number): string {
  return symbolPairName.get(accountId)?.get(symbolId)
    ?? Object.entries(SYMBOL_IDS).find(([, v]) => v === symbolId)?.[0]
    ?? `#${symbolId}`;
}

async function fetchSymbolInfo(
  conn: TcpConnection,
  accountId: number,
  symbolId: number,
): Promise<{ lotSize: number; stepVolume: number; minVolume: number }> {
  const cached = symbolInfoCache.get(symbolId);
  if (cached) return cached;

  await conn.send(PT.SYMBOL_BY_ID_REQ, SYMBOL_BY_ID_REQ_SCHEMA, { ctidTraderAccountId: accountId, symbolId: [symbolId] });
  const res     = await conn.waitFor(PT.SYMBOL_BY_ID_RES, SYMBOL_BY_ID_RES_SCHEMA);
  const symbols = (res['symbol'] ?? []) as Record<string, unknown>[];
  const sym     = symbols[0];
  if (!sym) throw new Error(`No symbol info returned for symbolId ${symbolId}`);

  const info = {
    lotSize:    ((sym['lotSize']    as number | undefined) ?? 100000),
    stepVolume: ((sym['stepVolume'] as number | undefined) ?? 100000),
    minVolume:  ((sym['minVolume']  as number | undefined) ?? 100000),
  };
  symbolInfoCache.set(symbolId, info);
  return info;
}

// Broker-specific lot size varies per symbol (and isn't always 100,000) — fetch it for
// every symbol appearing in a positions/deals result so callers can report real lot
// counts instead of guessing a fixed divisor.
async function buildLotSizeMap(
  conn: TcpConnection,
  accountId: number,
  symbolIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const id of symbolIds) {
    if (!id) continue;
    try {
      const { lotSize } = await fetchSymbolInfo(conn, accountId, id);
      map.set(id, lotSize);
    } catch { /* fall back to the 100,000 default in parsePositions/parseDeals */ }
  }
  return map;
}

async function fetchTraderInfo(conn: TcpConnection, accountId: number): Promise<{ balance: number; traderLogin: number | null }> {
  await conn.send(PT.TRADER_REQ, TRADER_REQ_SCHEMA, { ctidTraderAccountId: accountId });
  const res         = await conn.waitFor(PT.TRADER_RES, TRADER_RES_SCHEMA);
  const trader      = (res['trader'] ?? {}) as Record<string, unknown>;
  const moneyDigits = (trader['moneyDigits'] as number | undefined) ?? 2;
  const rawBalance  = (trader['balance']     as number | undefined) ?? 0;
  return {
    balance:     rawBalance / Math.pow(10, moneyDigits),
    traderLogin: (trader['traderLogin'] as number | undefined) ?? null,
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface Position {
  positionId:    number;
  symbolId:      number;
  symbol:        string;
  direction:     'buy' | 'sell';
  volume:        number;
  lots:          number;   // volume converted using this symbol's real broker lot size — don't re-derive from volume with a guessed divisor
  openPrice:     number;
  stopLoss?:     number;
  takeProfit?:   number;
  openTime:      number;
  // Both attached by routes.ts's attachUnrealizedPnl() after fetching a mark price —
  // ProtoOAPosition itself carries neither a live price nor a floating-profit field.
  currentPrice?: number;
  profit?:       number;
}

export interface Deal {
  dealId:        number;
  positionId:    number;
  symbolId:      number;
  symbol:        string;
  direction:     'buy' | 'sell';
  volume:        number;
  lots:          number;   // volume converted using this symbol's real broker lot size — don't re-derive from volume with a guessed divisor
  entryPrice:    number;
  executionTime: number;   // when THIS deal executed — set on every deal, entry or closing
  closePrice?:   number;
  closeTime?:    number;   // only set when this deal actually closed a position (closePositionDetail present)
  profit?:       number;
}

export interface Trade {
  positionId: number;
  symbol:     string;
  direction:  'buy' | 'sell';
  lots:       number;
  entryPrice: number;
  openTime:   number;
  closePrice?: number;
  closeTime?:  number;
  profit?:     number;
}

// getHistory() returns raw broker deals — every trade produces two of them (the entry fill
// and, once it closes, the exit fill), which reads as confusing duplicates in a UI ("—" on
// the entry row looks like "still open" even for a trade closed hours ago). Merge each
// position's deals into a single trade row so "—" only ever means genuinely still open.
export function mergeDealsIntoTrades(deals: Deal[]): Trade[] {
  const byPosition = new Map<number, Deal[]>();
  for (const d of deals) {
    const group = byPosition.get(d.positionId) ?? [];
    group.push(d);
    byPosition.set(d.positionId, group);
  }

  const trades: Trade[] = [];
  for (const [positionId, group] of byPosition) {
    const entryDeal = group.find(d => d.closePrice === undefined);
    const closeDeal = group.find(d => d.closePrice !== undefined);
    const base       = entryDeal ?? closeDeal ?? group[0]!;
    // A closing deal's own direction is the opposite side (closing a sell = a buy fill) —
    // only trust it for the trade's direction when the entry deal itself isn't in this window.
    const direction: 'buy' | 'sell' = entryDeal
      ? entryDeal.direction
      : closeDeal
        ? (closeDeal.direction === 'buy' ? 'sell' : 'buy')
        : base.direction;

    trades.push({
      positionId,
      symbol:     base.symbol,
      direction,
      lots:       base.lots,
      entryPrice: base.entryPrice,
      openTime:   entryDeal?.executionTime ?? base.executionTime,
      ...(closeDeal ? {
        closePrice: closeDeal.closePrice,
        closeTime:  closeDeal.closeTime,
        profit:     closeDeal.profit,
      } : {}),
    });
  }

  return trades.sort((a, b) => (b.closeTime ?? b.openTime) - (a.closeTime ?? a.openTime));
}

interface CTraderConfig {
  clientId:     string;
  clientSecret: string;
  accessToken:  string;
  accountId:    number;
  accountType?: 'demo' | 'live';
}

// ── Length-prefixed Protobuf over raw TCP+TLS ──────────────────────────────────

class TcpConnection {
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);

  async open(host: string, port: number): Promise<void> {
    const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
    this.writer  = socket.writable.getWriter();
    this.reader  = socket.readable.getReader();
  }

  async send(payloadType: number, schema: MessageSchema, obj: Record<string, unknown>): Promise<void> {
    await this.writer.write(frameMessage(payloadType, encodeMessage(schema, obj)));
  }

  private appendBuf(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  async readMessage(): Promise<{ payloadType: number; payload: Uint8Array }> {
    while (true) {
      if (this.buf.length >= 4) {
        const len = (this.buf[0] ?? 0) * 0x1000000 + (this.buf[1] ?? 0) * 0x10000 + (this.buf[2] ?? 0) * 0x100 + (this.buf[3] ?? 0);
        if (this.buf.length >= 4 + len) {
          const envelope = this.buf.subarray(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          const msg = decodeMessage(ENVELOPE_SCHEMA, envelope) as { payloadType: number; payload?: Uint8Array };
          return { payloadType: msg.payloadType, payload: msg.payload ?? new Uint8Array(0) };
        }
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('TCP connection closed by server');
      this.appendBuf(value);
    }
  }

  async waitFor(expectedType: number, schema: MessageSchema, timeoutMs = 15000): Promise<Record<string, any>> {
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
        const p = decodeMessage(ERROR_RES_SCHEMA, msg.payload) as { errorCode?: string; description?: string };
        throw new Error(`cTrader error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
        const p = decodeMessage(ORDER_ERROR_EVENT_SCHEMA, msg.payload) as { errorCode?: string; description?: string };
        throw new Error(`cTrader order error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === expectedType) return decodeMessage(schema, msg.payload);
      // Heartbeats / unsolicited messages — skip
    }
    throw new Error(`cTrader timeout waiting for ${expectedType}`);
  }

  // cTrader sends multiple EXECUTION_EVENT messages per order: ORDER_ACCEPTED first
  // (order confirmed, not yet filled — position not populated), then a separate
  // ORDER_FILLED/CANCELLED/REPLACED event with the definitive outcome. Waiting for the
  // first EXECUTION_EVENT (as waitFor() does) grabs the accepted-but-not-filled event,
  // which has no position — so callers must wait specifically for a terminal outcome.
  async waitForExecution(schema: MessageSchema, timeoutMs = 15000): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const msg = await Promise.race([
        this.readMessage(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('cTrader timeout waiting for execution outcome')), remaining)
        ),
      ]);
      if (msg.payloadType === PT.ERROR_RES) {
        const p = decodeMessage(ERROR_RES_SCHEMA, msg.payload) as { errorCode?: string; description?: string };
        throw new Error(`cTrader error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
        const p = decodeMessage(ORDER_ERROR_EVENT_SCHEMA, msg.payload) as { errorCode?: string; description?: string };
        throw new Error(`cTrader order error ${p.errorCode}: ${p.description}`);
      }
      if (msg.payloadType === PT.EXECUTION_EVENT) {
        const payload    = decodeMessage(schema, msg.payload);
        const execType    = payload['executionType'] as number | undefined;
        if (execType === EXEC_TYPE.FILLED || execType === EXEC_TYPE.CANCELLED || execType === EXEC_TYPE.REPLACED) {
          return payload;
        }
        if (execType === EXEC_TYPE.REJECTED || execType === EXEC_TYPE.CANCEL_REJECTED) {
          const errCode = payload['errorCode'] as string | undefined;
          throw new Error(`cTrader order ${execType === EXEC_TYPE.REJECTED ? 'rejected' : 'cancel rejected'}${errCode ? `: ${errCode}` : ''}`);
        }
        // ACCEPTED or another intermediate state — keep waiting for the definitive outcome
        continue;
      }
      // Heartbeats / unsolicited messages — skip
    }
    throw new Error('cTrader timeout waiting for execution outcome');
  }

  close(): void {
    try { this.writer.close(); } catch { /* ignore */ }
  }
}

// ── Diagnostic ────────────────────────────────────────────────────────────────

export async function diagnoseCTrader(cfg: CTraderConfig): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const conn = new TcpConnection();
  const host = cfg.accountType === 'live' ? LIVE_HOST : DEMO_HOST;
  try {
    steps.push(`Opening TCP+TLS to ${host}:${API_PORT}…`);
    await conn.open(host, API_PORT);
    steps.push('Connected');

    await conn.send(PT.APP_AUTH_REQ, APP_AUTH_REQ_SCHEMA, { clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    await conn.waitFor(PT.APP_AUTH_RES, {}, 8000);
    steps.push('APP_AUTH_RES ✓');

    await conn.send(PT.ACCOUNT_AUTH_REQ, ACCOUNT_AUTH_REQ_SCHEMA, { ctidTraderAccountId: cfg.accountId, accessToken: cfg.accessToken });
    await conn.waitFor(PT.ACCOUNT_AUTH_RES, {}, 8000);
    steps.push('ACCOUNT_AUTH_RES ✓');

    await conn.send(PT.SYMBOLS_LIST_REQ, SYMBOLS_LIST_REQ_SCHEMA, { ctidTraderAccountId: cfg.accountId });
    const symRes  = await conn.waitFor(PT.SYMBOLS_LIST_RES, SYMBOLS_LIST_RES_SCHEMA, 10000);
    const symList = (symRes['symbol'] ?? []) as unknown[];
    steps.push(`SYMBOLS_LIST_RES ✓ — ${symList.length} symbols`);

    await conn.send(PT.RECONCILE_REQ, RECONCILE_REQ_SCHEMA, { ctidTraderAccountId: cfg.accountId });
    const rec       = await conn.waitFor(PT.RECONCILE_RES, RECONCILE_RES_SCHEMA, 8000);
    const positions = (rec['position'] ?? []) as unknown[];
    steps.push(`RECONCILE_RES ✓ — ${positions.length} open positions`);
  } catch (e) {
    steps.push(`FAILED: ${(e as Error).message}`);
  } finally {
    conn.close();
  }
  return { steps };
}

// Field layout confirmed empirically against a real token (see rawDump) rather than
// guessed — ProtoOACtidTraderAccount fields 4/5 are timestamps we don't currently need.
const CTID_TRADER_ACCOUNT_SCHEMA: MessageSchema = {
  ctidTraderAccountId: { no: 1, type: { t: 'varint' } },
  isLive:               { no: 2, type: { t: 'varint' } },
  traderLogin:          { no: 3, type: { t: 'varint' } },
  brokerName:           { no: 6, type: { t: 'string' } },
};
const GET_ACCOUNTS_BY_TOKEN_REQ_SCHEMA: MessageSchema = {
  accessToken: { no: 2, type: { t: 'string' } },
};
const GET_ACCOUNTS_BY_TOKEN_RES_SCHEMA: MessageSchema = {
  account: { no: 4, type: { t: 'message', schema: CTID_TRADER_ACCOUNT_SCHEMA }, repeated: true },
};

export interface DiscoveredAccount {
  ctidTraderAccountId: number;
  isLive:               boolean;
  traderLogin:           number;
  brokerName:            string;
}

// Lists every cTrader account reachable with a given access token — NOT just the one
// account originally used to authorize it. Confirmed empirically: a single OAuth token
// covers every account under the same cTrader ID, and the broker's own "Login" number
// (shown when creating an account) is a different value from the ctidTraderAccountId the
// Open API actually needs — entering the Login where an account ID was expected is what
// caused a "cTID trader account not found" error on a newly-connected account. This lets
// the app discover the real, correct ID directly instead of asking the user to hunt for
// it or guess between two similar-looking numbers.
export async function getAccountsByToken(
  cfg: { clientId: string; clientSecret: string; accessToken: string },
): Promise<DiscoveredAccount[]> {
  const conn = new TcpConnection();
  try {
    // Account-agnostic — no account is selected yet, so either host works; which host you
    // connect to doesn't filter which accounts (demo or live) come back.
    await conn.open(DEMO_HOST, API_PORT);
    await conn.send(PT.APP_AUTH_REQ, APP_AUTH_REQ_SCHEMA, { clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    await conn.waitFor(PT.APP_AUTH_RES, {}, 8000);

    await conn.send(PT.GET_ACCOUNTS_BY_TOKEN_REQ, GET_ACCOUNTS_BY_TOKEN_REQ_SCHEMA, { accessToken: cfg.accessToken });
    const res = await conn.waitFor(PT.GET_ACCOUNTS_BY_TOKEN_RES, GET_ACCOUNTS_BY_TOKEN_RES_SCHEMA, 8000);
    const accounts = (res['account'] ?? []) as Record<string, unknown>[];
    return accounts.map(a => ({
      ctidTraderAccountId: a['ctidTraderAccountId'] as number,
      isLive:               !!(a['isLive'] as number),
      traderLogin:           a['traderLogin'] as number,
      brokerName:            (a['brokerName'] as string) ?? '',
    }));
  } finally {
    conn.close();
  }
}

// ── CTraderClient ──────────────────────────────────────────────────────────────

export class CTraderClient {
  constructor(private cfg: CTraderConfig) {}

  private async connect(): Promise<TcpConnection> {
    const conn = new TcpConnection();
    const host = this.cfg.accountType === 'live' ? LIVE_HOST : DEMO_HOST;
    await conn.open(host, API_PORT);
    return conn;
  }

  private async auth(conn: TcpConnection): Promise<void> {
    await conn.send(PT.APP_AUTH_REQ, APP_AUTH_REQ_SCHEMA, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret });
    await conn.waitFor(PT.APP_AUTH_RES, {});
    await conn.send(PT.ACCOUNT_AUTH_REQ, ACCOUNT_AUTH_REQ_SCHEMA, { ctidTraderAccountId: this.cfg.accountId, accessToken: this.cfg.accessToken });
    await conn.waitFor(PT.ACCOUNT_AUTH_RES, {});
  }

  async getBalance(): Promise<{ balance: number; traderLogin: number | null }> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      return await fetchTraderInfo(conn, this.cfg.accountId);
    } finally { conn.close(); }
  }

  // Resolves a display pair string ("EUR/USD", "US500", ...) to the broker's real symbolId.
  async resolveSymbolId(pair: string): Promise<number> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await ensureSymbolCache(conn, this.cfg.accountId);
      const id = lookupSymbolId(this.cfg.accountId, pair);
      if (id === undefined) throw new Error(`Unknown symbol for pair "${pair}"`);
      return id;
    } finally { conn.close(); }
  }

  // Historical OHLC candles from Pepperstone's own feed — the source of truth for both
  // charting and backtesting, so results always match what live trades actually fill against.
  // Trendbar prices come back delta-encoded, always at a fixed 5-decimal wire precision
  // (×100000) — confirmed empirically against known real prices across a 5-digit pair
  // (EUR/USD), a 3-digit pair (USD/JPY), and a 2-digit instrument (XAU/USD): all three only
  // decode correctly with a fixed ×100000 divisor, NOT the symbol's own `digits` field (that's
  // display-only metadata and does not describe this wire format, unlike order-related fields
  // which use plain, unscaled doubles).
  async getTrendbars(
    symbolId: number,
    period: number,
    count: number,
    toTimestamp: number = Date.now(),
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      const scale = 100000;

      await conn.send(PT.GET_TRENDBARS_REQ, GET_TRENDBARS_REQ_SCHEMA, {
        ctidTraderAccountId: this.cfg.accountId,
        symbolId,
        period,
        count,
        toTimestamp,
      });
      const res  = await conn.waitFor(PT.GET_TRENDBARS_RES, GET_TRENDBARS_RES_SCHEMA, 20000);
      const bars = (res['trendbar'] ?? []) as Array<{
        utcTimestampInMinutes: number;
        low: number;
        deltaOpen: number;
        deltaClose: number;
        deltaHigh: number;
        volume: number;
      }>;

      return bars
        .map(b => {
          const low = b.low / scale;
          return {
            timestamp: b.utcTimestampInMinutes * 60000,
            low,
            open:  low + b.deltaOpen  / scale,
            close: low + b.deltaClose / scale,
            high:  low + b.deltaHigh  / scale,
            volume: b.volume,
          };
        })
        .sort((a, b) => a.timestamp - b.timestamp);
    } finally { conn.close(); }
  }

  async getPositions(): Promise<Position[]> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await ensureSymbolCache(conn, this.cfg.accountId);
      await conn.send(PT.RECONCILE_REQ, RECONCILE_REQ_SCHEMA, { ctidTraderAccountId: this.cfg.accountId });
      const payload = await conn.waitFor(PT.RECONCILE_RES, RECONCILE_RES_SCHEMA);
      const items      = (payload.position ?? []) as Record<string, unknown>[];
      const symbolIds  = [...new Set(items.map(p => ((p.tradeData as Record<string, unknown>)?.symbolId ?? 0) as number))];
      const lotSizeMap = await buildLotSizeMap(conn, this.cfg.accountId, symbolIds);
      return parsePositions(payload, this.cfg.accountId, lotSizeMap);
    } finally { conn.close(); }
  }

  async closePosition(positionId: number, volume: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.CLOSE_POSITION_REQ, CLOSE_POSITION_REQ_SCHEMA, { ctidTraderAccountId: this.cfg.accountId, positionId, volume });
      await conn.waitForExecution(EXECUTION_EVENT_SCHEMA);
    } finally { conn.close(); }
  }

  async placeOrder(params: {
    pair:        string;   // e.g. "EUR/USD" — resolved to broker symbolId dynamically
    direction:   'buy' | 'sell';
    lots:        number;
    limitPrice?: number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<{ orderId: number }> {
    const conn = await this.connect();
    try {
      await this.auth(conn);

      // Resolve pair → symbolId using broker's own symbol list
      await ensureSymbolCache(conn, this.cfg.accountId);
      const symbolId = lookupSymbolId(this.cfg.accountId, params.pair);
      if (!symbolId) throw new Error(`Unknown pair for this broker: ${params.pair}`);

      // Fetch broker-specific lotSize / stepVolume (cached after first call per symbolId)
      const { lotSize, stepVolume, minVolume } = await fetchSymbolInfo(conn, this.cfg.accountId, symbolId);

      // Volume in cTrader "cents" (1/100 of a unit). Round to nearest stepVolume.
      const rawVolume = Math.round(params.lots * lotSize);
      const volume    = Math.max(minVolume, Math.round(rawVolume / stepVolume) * stepVolume);

      const payload: Record<string, unknown> = {
        ctidTraderAccountId: this.cfg.accountId,
        symbolId,
        orderType: params.limitPrice ? ORDER_TYPE.LIMIT : ORDER_TYPE.MARKET,
        tradeSide: params.direction === 'buy' ? TRADE_SIDE.BUY : TRADE_SIDE.SELL,
        volume,
      };
      if (params.limitPrice) { payload.limitPrice = params.limitPrice; payload.timeInForce = TIME_IN_FORCE_GTC; }
      if (params.stopLoss)   payload.stopLoss   = params.stopLoss;
      if (params.takeProfit) payload.takeProfit = params.takeProfit;

      await conn.send(PT.NEW_ORDER_REQ, NEW_ORDER_REQ_SCHEMA, payload);
      // Limit orders (retest entries) can sit pending for a long time before price reaches
      // them — don't block waiting for a FILLED confirmation here, that would time out on
      // perfectly valid orders that just haven't filled yet. Accept whatever the first
      // response is (ACCEPTED with just an orderId, or FILLED with a real position) and let
      // parseOrderId() pick the right ID; the engine reconciles pending → filled separately.
      const evt = await conn.waitFor(PT.EXECUTION_EVENT, EXECUTION_EVENT_SCHEMA);
      return { orderId: parseOrderId(evt) };
    } finally { conn.close(); }
  }

  async amendPosition(positionId: number, stopLoss: number, takeProfit?: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      const payload: Record<string, unknown> = { ctidTraderAccountId: this.cfg.accountId, positionId, stopLoss };
      if (takeProfit !== undefined) payload.takeProfit = takeProfit;
      await conn.send(PT.AMEND_POSITION_SLTP_REQ, AMEND_POSITION_SLTP_REQ_SCHEMA, payload);
      await conn.waitForExecution(EXECUTION_EVENT_SCHEMA);
    } finally { conn.close(); }
  }

  async cancelOrder(orderId: number): Promise<void> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await conn.send(PT.CANCEL_ORDER_REQ, CANCEL_ORDER_REQ_SCHEMA, { ctidTraderAccountId: this.cfg.accountId, orderId });
      await conn.waitForExecution(EXECUTION_EVENT_SCHEMA);
    } finally { conn.close(); }
  }

  async getHistory(fromMs: number, toMs: number): Promise<Deal[]> {
    const conn = await this.connect();
    try {
      await this.auth(conn);
      await ensureSymbolCache(conn, this.cfg.accountId);
      await conn.send(PT.DEAL_LIST_REQ, DEAL_LIST_REQ_SCHEMA, {
        ctidTraderAccountId: this.cfg.accountId,
        fromTimestamp: fromMs,
        toTimestamp:   toMs,
      });
      const payload    = await conn.waitFor(PT.DEAL_LIST_RES, DEAL_LIST_RES_SCHEMA);
      const items      = (payload.deal ?? []) as Record<string, unknown>[];
      const symbolIds  = [...new Set(items.map(d => (d.symbolId ?? 0) as number))];
      const lotSizeMap = await buildLotSizeMap(conn, this.cfg.accountId, symbolIds);
      return parseDeals(payload, this.cfg.accountId, lotSizeMap);
    } finally { conn.close(); }
  }
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseOrderId(payload: Record<string, unknown>): number {
  const order    = payload.order    as Record<string, unknown> | undefined;
  const position = payload.position as Record<string, unknown> | undefined;
  // Once an order is FILLED it becomes a position — the position ID is what future
  // close/amend calls need, not the initiating order's own ID. Fall back to orderId
  // only for still-pending orders (e.g. a LIMIT order that hasn't filled yet).
  return (position?.positionId ?? order?.orderId ?? 0) as number;
}

function parsePositions(payload: Record<string, unknown>, accountId: number, lotSizeMap: Map<number, number>): Position[] {
  const items = (payload.position ?? []) as Record<string, unknown>[];
  return items.map(pos => {
    const td       = pos.tradeData as Record<string, unknown> ?? {};
    const symbolId = (td.symbolId ?? 0) as number;
    const volume   = (td.volume ?? 0) as number;
    const lotSize  = lotSizeMap.get(symbolId) ?? 100000;
    return {
      positionId: (pos.positionId ?? 0) as number,
      symbolId,
      symbol:     lookupSymbolName(accountId, symbolId),
      direction:  td.tradeSide === TRADE_SIDE.BUY ? 'buy' : 'sell',
      volume,
      lots:       volume / lotSize,
      openPrice:  (pos.price ?? 0) as number,
      openTime:   (td.openTimestamp ?? 0) as number,
      ...(pos.stopLoss   !== undefined ? { stopLoss:   pos.stopLoss   as number } : {}),
      ...(pos.takeProfit !== undefined ? { takeProfit: pos.takeProfit as number } : {}),
    } satisfies Position;
  });
}

function parseDeals(payload: Record<string, unknown>, accountId: number, lotSizeMap: Map<number, number>): Deal[] {
  const items = (payload.deal ?? []) as Record<string, unknown>[];
  return items.map(deal => {
    const symbolId = (deal.symbolId ?? 0) as number;
    const cpd      = deal.closePositionDetail as Record<string, unknown> | undefined;
    const moneyDigits = (cpd?.moneyDigits as number | undefined) ?? 2;
    const volume   = (deal.filledVolume ?? 0) as number;
    const lotSize  = lotSizeMap.get(symbolId) ?? 100000;
    const executionPrice = (deal.executionPrice ?? 0) as number;
    // On a closing deal, closePositionDetail.entryPrice is the position's ORIGINAL entry
    // price (not this deal's price) — the deal's own executionPrice is where it actually
    // closed. Swapping these previously caused exitPrice ≈ entryPrice on every close,
    // silently misclassifying real wins/losses as "expired" with ~0 P&L.
    return {
      dealId:     (deal.dealId ?? 0) as number,
      positionId: (deal.positionId ?? 0) as number,
      symbolId,
      symbol:     lookupSymbolName(accountId, symbolId),
      direction:  deal.tradeSide === TRADE_SIDE.BUY ? 'buy' : 'sell',
      volume,
      lots:       volume / lotSize,
      entryPrice: cpd?.entryPrice !== undefined ? (cpd.entryPrice as number) : executionPrice,
      executionTime: (deal.executionTimestamp ?? 0) as number,
      ...(cpd !== undefined ? { closePrice: executionPrice } : {}),
      // closeTime (not just executionTime) is only meaningful on the deal that actually
      // closed a position — setting it on entry deals too previously made the History
      // table's "Closed" column show an entry timestamp for trades that were still open.
      ...(cpd !== undefined && deal.executionTimestamp !== undefined ? { closeTime: deal.executionTimestamp as number } : {}),
      ...(cpd ? { profit: (cpd.grossProfit as number) / Math.pow(10, moneyDigits) } : {}),
    } satisfies Deal;
  });
}
