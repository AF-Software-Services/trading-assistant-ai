import { Hono }           from 'hono';
import { diagnoseCTrader, mergeDealsIntoTrades, getAccountsByToken } from './client.ts';
import type { Position }   from './client.ts';
import { TradingService }  from '../trading/service.ts';
import {
  listAccounts,
  getAccount,
  createAccount,
  deleteAccount,
  updateAccountStatus,
  updateAccountBalance,
  setAccountActive,
  setAccountDefault,
  seedDefaultAccount,
  tokenKey,
  refreshKey,
} from './account-types.ts';
import type { CTraderAccount } from './account-types.ts';
import { createMarketDataProvider } from '../providers/factory.ts';
import type { CurrencyPair } from '../types/market.ts';
import { getBotSignals } from '../bot/signal-store.ts';
import { listBots } from '../bot/bot-types.ts';

interface Env {
  DB:                    D1Database;
  KV:                    KVNamespace;
  CTRADER_CLIENT_ID:     string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID:    string;
  MARKET_DATA_PROVIDER?: string;
  TWELVE_DATA_API_KEY?:  string;
}

const REDIRECT_URI = 'https://trading-assistant-ai.andrew-dobson.workers.dev/auth/callback';
const AUTH_URL     = 'https://connect.spotware.com/apps/auth';
const TOKEN_URL    = 'https://connect.spotware.com/apps/token';

export function createCTraderRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // ── Account CRUD ─────────────────────────────────────────────────────────────

  app.get('/api/v1/ctrader/accounts', async (c) => {
    await seedDefaultAccount(c.env.DB, c.env.KV, c.env.CTRADER_ACCOUNT_ID);
    const includeInactive = c.req.query('includeInactive') === 'true';
    const accounts = await listAccounts(c.env.DB, { includeInactive });
    // Enrich each account with whether it has a token in KV
    const enriched = await Promise.all(accounts.map(async (a) => {
      const hasToken = !!(await c.env.KV.get(tokenKey(a.id)));
      return { ...a, hasToken };
    }));
    return c.json(enriched);
  });

  app.post('/api/v1/ctrader/accounts', async (c) => {
    const body = await c.req.json<{
      name:              string;
      type:              'demo' | 'live';
      ctraderAccountId:  string;
      currency?:         string;
    }>();
    if (!body.name || !body.type || !body.ctraderAccountId) {
      return c.json({ error: 'name, type, and ctraderAccountId are required' }, 400);
    }
    if (!['demo', 'live'].includes(body.type)) {
      return c.json({ error: "type must be 'demo' or 'live'" }, 400);
    }
    const account = await createAccount(c.env.DB, {
      id:               crypto.randomUUID(),
      name:             body.name,
      type:             body.type,
      ctraderAccountId: body.ctraderAccountId,
      currency:         body.currency ?? 'GBP',
      status:           'pending',
    });
    return c.json(account, 201);
  });

  app.delete('/api/v1/ctrader/accounts/:id', async (c) => {
    const id = c.req.param('id');
    if (id === 'default') return c.json({ error: 'Cannot delete the default account' }, 403);
    await c.env.KV.delete(tokenKey(id));
    await c.env.KV.delete(refreshKey(id));
    const ok = await deleteAccount(c.env.DB, id);
    if (!ok) return c.json({ error: 'Account not found' }, 404);
    return c.json({ ok: true });
  });

  // ── Activate / deactivate — the normal way to stop using an account without losing its
  // credentials or trade history. An inactive account is excluded everywhere except this
  // management screen (see listAccounts's includeInactive) until switched back on.
  app.post('/api/v1/ctrader/accounts/:id/activate', async (c) => {
    const id = c.req.param('id');
    if (!(await getAccount(c.env.DB, id))) return c.json({ error: 'Account not found' }, 404);
    await setAccountActive(c.env.DB, id, true);
    return c.json({ ok: true });
  });
  app.post('/api/v1/ctrader/accounts/:id/deactivate', async (c) => {
    const id = c.req.param('id');
    if (!(await getAccount(c.env.DB, id))) return c.json({ error: 'Account not found' }, 404);
    await setAccountActive(c.env.DB, id, false);
    return c.json({ ok: true });
  });

  // ── Default account — the one Dashboard/Positions/History etc. show initially instead
  // of "All". Only one account can be default at a time (see setAccountDefault).
  app.post('/api/v1/ctrader/accounts/:id/set-default', async (c) => {
    const id = c.req.param('id');
    if (!(await getAccount(c.env.DB, id))) return c.json({ error: 'Account not found' }, 404);
    await setAccountDefault(c.env.DB, id, true);
    return c.json({ ok: true });
  });
  app.post('/api/v1/ctrader/accounts/:id/unset-default', async (c) => {
    const id = c.req.param('id');
    if (!(await getAccount(c.env.DB, id))) return c.json({ error: 'Account not found' }, 404);
    await setAccountDefault(c.env.DB, id, false);
    return c.json({ ok: true });
  });

  // ── OAuth: initiate — account-specific ───────────────────────────────────────
  // GET /auth/ctrader?accountId=<id>
  app.get('/auth/ctrader', async (c) => {
    const accountId = c.req.query('accountId') ?? 'default';
    // cTrader's OAuth server doesn't reliably echo the `state` param back on the callback
    // (confirmed live: connecting a second account silently reconnected "default" instead,
    // because callback's `state` came back empty and fell through to the 'default' guess).
    // Don't depend on it — stash which account this flow is for in KV and read it back in
    // the callback, falling back to `state` only if present for extra safety.
    await c.env.KV.put('oauth:pending_account', accountId, { expirationTtl: 600 });
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id',     c.env.CTRADER_CLIENT_ID);
    url.searchParams.set('redirect_uri',  REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         'trading');
    url.searchParams.set('state',         accountId);
    return c.redirect(url.toString());
  });

  // ── OAuth: callback ──────────────────────────────────────────────────────────
  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return c.json({ error: 'No code' }, 400);

    // KV is the reliable source (see comment on the initiate route) — `state` is only a
    // fallback in case the KV entry expired or this callback fires from an older in-flight
    // flow that predates this fix.
    const pendingAccountId = await c.env.KV.get('oauth:pending_account');
    const stateAccountId   = c.req.query('state');
    const accountId        = pendingAccountId || stateAccountId || 'default';
    await c.env.KV.delete('oauth:pending_account');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     c.env.CTRADER_CLIENT_ID,
        client_secret: c.env.CTRADER_CLIENT_SECRET,
      }),
    });

    if (!res.ok) return c.json({ error: 'Token exchange failed', status: res.status }, 502);

    const tokens = await res.json() as {
      access_token: string; refresh_token: string; expires_in: number;
    };

    // Store per-account token
    await c.env.KV.put(tokenKey(accountId), tokens.access_token, { expirationTtl: tokens.expires_in });
    await c.env.KV.put(refreshKey(accountId), tokens.refresh_token);

    // Also keep the legacy global token for backward compat (used by old code paths)
    if (accountId === 'default') {
      await c.env.KV.put('ctrader:access_token',  tokens.access_token,  { expirationTtl: tokens.expires_in });
      await c.env.KV.put('ctrader:refresh_token', tokens.refresh_token);
    }

    // Mark account as connected
    const account = await getAccount(c.env.DB, accountId);
    if (account) {
      await updateAccountStatus(c.env.DB, accountId, 'connected');
      // Best-effort: fetch and cache the live balance right away so it shows in the UI immediately
      try { await refreshAccountBalance(c.env, accountId); } catch { /* shown as "—" until next refresh */ }
    }

    return c.redirect(`/?ctrader=connected&account=${accountId}`);
  });

  // ── Refresh cached balance for an account ─────────────────────────────────────
  app.post('/api/v1/ctrader/accounts/:id/refresh-balance', async (c) => {
    const id = c.req.param('id');
    try {
      const account = await refreshAccountBalance(c.env, id);
      return c.json(account);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Disconnect a specific account ────────────────────────────────────────────
  app.post('/api/v1/ctrader/accounts/:id/disconnect', async (c) => {
    const id = c.req.param('id');
    await c.env.KV.delete(tokenKey(id));
    await c.env.KV.delete(refreshKey(id));
    if (id === 'default') {
      await c.env.KV.delete('ctrader:access_token');
      await c.env.KV.delete('ctrader:refresh_token');
    }
    await updateAccountStatus(c.env.DB, id, 'pending');
    return c.json({ disconnected: true });
  });

  // ── Legacy: disconnect (kept for UI back-compat) ──────────────────────────────
  app.post('/api/v1/ctrader/disconnect', async (c) => {
    await c.env.KV.delete('ctrader:access_token');
    await c.env.KV.delete('ctrader:refresh_token');
    return c.json({ disconnected: true });
  });

  // ── Status (legacy) ──────────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/status', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    return c.json({ connected: !!token, accountId: c.env.CTRADER_ACCOUNT_ID });
  });

  // ── Diagnose ─────────────────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/diagnose', async (c) => {
    const accountId = c.req.query('accountId') ?? 'default';
    const account   = await getAccount(c.env.DB, accountId);

    // Fall back to legacy global token for default account
    const token = account
      ? await c.env.KV.get(tokenKey(accountId))
      : await c.env.KV.get('ctrader:access_token');

    if (!token) return c.json({ ok: false, steps: ['No access token'], hasToken: false });

    const result = await diagnoseCTrader({
      clientId:     c.env.CTRADER_CLIENT_ID,
      clientSecret: c.env.CTRADER_CLIENT_SECRET,
      accessToken:  token,
      accountId:    parseInt(account?.ctraderAccountId ?? c.env.CTRADER_ACCOUNT_ID),
      accountType:  account?.type ?? 'demo',
    });
    return c.json(result);
  });

  // ── Discover accounts available via an already-connected account's token ──────
  // A single OAuth token covers every account under the same cTrader ID — not just the
  // one it was originally authorized for — so once ANY account is connected, every other
  // account on that cTID (including ones created after the fact) can be listed and added
  // with no further manual entry, instead of asking the user to type in a broker account
  // ID (which is how a previous account ended up with its Login number instead of the
  // actual ctidTraderAccountId the Open API needs).
  app.get('/api/v1/ctrader/discover-accounts', async (c) => {
    // Include inactive accounts here — a deactivated account still has a valid token (it's
    // hidden, not disconnected) and should still count as "already added" so it isn't
    // offered again and duplicated.
    const accounts        = await listAccounts(c.env.DB, { includeInactive: true });
    // Different connected accounts can carry different OAuth grants (e.g. a token authorized
    // only against demo accounts can't see live ones on the same cTrader ID) — allow searching
    // from a specific account's token instead of always defaulting to the first connected one.
    const requestedId     = c.req.query('tokenAccountId');
    const connected       = requestedId
      ? accounts.find(a => a.id === requestedId && a.status === 'connected')
      : accounts.find(a => a.status === 'connected');
    const legacyToken     = await c.env.KV.get('ctrader:access_token');
    const token           = connected ? await c.env.KV.get(tokenKey(connected.id)) : legacyToken;
    const tokenAccountId  = connected?.id ?? (legacyToken ? 'default' : null);

    if (!token || !tokenAccountId) {
      return c.json({ error: 'Connect at least one account first, then accounts on the same cTrader ID can be discovered automatically.' }, 400);
    }

    try {
      const discovered = await getAccountsByToken({
        clientId:     c.env.CTRADER_CLIENT_ID,
        clientSecret: c.env.CTRADER_CLIENT_SECRET,
        accessToken:  token,
      });
      const existingIds = new Set(accounts.map(a => a.ctraderAccountId));
      return c.json({
        tokenAccountId,
        accounts: discovered.map(d => ({
          ctidTraderAccountId: d.ctidTraderAccountId,
          isLive:              d.isLive,
          traderLogin:         d.traderLogin,
          brokerName:          d.brokerName,
          alreadyAdded:        existingIds.has(String(d.ctidTraderAccountId)),
        })),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Adopt a discovered account — no manual ID entry, reuses an existing token ──
  app.post('/api/v1/ctrader/accounts/adopt', async (c) => {
    const body = await c.req.json<{
      ctidTraderAccountId: number;
      isLive:               boolean;
      tokenAccountId:       string;
      name?:                string;
    }>().catch(() => null);
    if (!body?.ctidTraderAccountId || !body.tokenAccountId) {
      return c.json({ error: 'ctidTraderAccountId and tokenAccountId are required' }, 400);
    }

    const sourceToken   = body.tokenAccountId === 'default'
      ? await c.env.KV.get('ctrader:access_token')
      : await c.env.KV.get(tokenKey(body.tokenAccountId));
    const sourceRefresh = body.tokenAccountId === 'default'
      ? await c.env.KV.get('ctrader:refresh_token')
      : await c.env.KV.get(refreshKey(body.tokenAccountId));
    if (!sourceToken) return c.json({ error: 'Source account token not found' }, 400);

    const account = await createAccount(c.env.DB, {
      id:               crypto.randomUUID(),
      name:             body.name ?? `${body.isLive ? 'Live' : 'Demo'} ${body.ctidTraderAccountId}`,
      type:             body.isLive ? 'live' : 'demo',
      ctraderAccountId: String(body.ctidTraderAccountId),
      currency:         'GBP',
      status:           'connected',
    });

    // Same token works for every account on this cTrader ID — no separate OAuth needed.
    await c.env.KV.put(tokenKey(account.id), sourceToken);
    if (sourceRefresh) await c.env.KV.put(refreshKey(account.id), sourceRefresh);

    try {
      const updated = await refreshAccountBalance(c.env, account.id);
      return c.json(updated, 201);
    } catch {
      return c.json(account, 201); // adopted fine — balance will show once refreshed
    }
  });

  // ── Open positions (account-aware) ───────────────────────────────────────────
  app.get('/api/v1/ctrader/positions', async (c) => {
    try {
      const accountId = c.req.query('accountId');
      const svc = accountId
        ? await connectAccount(c.env, accountId)
        : await TradingService.connect(c.env);
      const positions = await svc.getPositions();
      const withPnl = await attachUnrealizedPnl(c.env, positions);
      const pendingOrders = await getPendingOrders(c.env, positions, accountId);
      return c.json({ positions: withPnl, count: withPnl.length, pendingOrders });
    } catch (e) {
      const msg = (e as Error).message;
      return msg.includes('Not connected') || msg.includes('not connected')
        ? c.json({ error: msg }, 401)
        : c.json({ error: msg }, 502);
    }
  });

  // ── Close position ────────────────────────────────────────────────────────────
  app.post('/api/v1/ctrader/positions/:id/close', async (c) => {
    const positionId = parseInt(c.req.param('id'));
    const body       = await c.req.json<{ volume?: number; accountId?: string }>().catch(() => ({} as { volume?: number; accountId?: string }));
    try {
      const svc = body.accountId
        ? await connectAccount(c.env, body.accountId)
        : await TradingService.connect(c.env);
      await svc.closePosition(positionId, body.volume);
      return c.json({ success: true, positionId });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Not connected') || msg.includes('not connected')) return c.json({ error: msg }, 401);
      if (msg.includes('not found'))     return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 502);
    }
  });

  // ── Amend position SL/TP (account-aware) ──────────────────────────────────────
  app.post('/api/v1/ctrader/positions/:id/amend', async (c) => {
    const positionId = parseInt(c.req.param('id'));
    const body = await c.req.json<{ stopLoss: number; takeProfit?: number; accountId?: string }>()
      .catch(() => null);
    if (!body || !body.stopLoss) return c.json({ error: 'stopLoss is required' }, 400);
    try {
      const svc = body.accountId
        ? await connectAccount(c.env, body.accountId)
        : await TradingService.connect(c.env);
      await svc.amendPosition(positionId, body.stopLoss, body.takeProfit);
      return c.json({ success: true, positionId });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Not connected') || msg.includes('not connected')) return c.json({ error: msg }, 401);
      return c.json({ error: msg }, 502);
    }
  });

  // ── Place order (account-aware) ───────────────────────────────────────────────
  app.post('/api/v1/ctrader/orders', async (c) => {
    const body = await c.req.json<{
      pair:        string;
      direction:   'buy' | 'sell';
      lots:        number;
      orderType?:  'market' | 'limit';
      limitPrice?: number;
      stopLoss?:   number;
      takeProfit?: number;
      accountId?:  string;
    }>();

    try {
      const svc = body.accountId
        ? await connectAccount(c.env, body.accountId)
        : await TradingService.connect(c.env);
      await svc.placeOrder({
        pair:       body.pair,
        direction:  body.direction,
        lots:       body.lots,
        limitPrice: body.orderType === 'limit' ? body.limitPrice : undefined,
        stopLoss:   body.stopLoss,
        takeProfit: body.takeProfit,
      });
      return c.json({ success: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Not connected') || msg.includes('not connected')) return c.json({ error: msg }, 401);
      if (msg.includes('Unknown pair'))  return c.json({ error: msg }, 400);
      return c.json({ error: msg }, 502);
    }
  });

  // ── Trade history (account-aware) ─────────────────────────────────────────────
  app.get('/api/v1/ctrader/history', async (c) => {
    const days      = parseInt(c.req.query('days') ?? '30');
    const accountId = c.req.query('accountId');
    const to   = Date.now();
    const from = to - days * 24 * 60 * 60 * 1000;
    try {
      const svc = accountId
        ? await connectAccount(c.env, accountId)
        : await TradingService.connect(c.env);
      const deals  = await svc.getHistory(from, to);
      const trades = mergeDealsIntoTrades(deals);
      return c.json({ trades, count: trades.length });
    } catch (e) {
      const msg = (e as Error).message;
      return msg.includes('Not connected') || msg.includes('not connected')
        ? c.json({ error: msg }, 401)
        : c.json({ error: msg }, 502);
    }
  });

  return app;
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function connectAccount(env: Env, accountId: string): Promise<TradingService> {
  const account = await getAccount(env.DB, accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  return TradingService.connectToAccount(env, account);
}

// A "pending order" here means one of OUR bot's own limit orders that's been sent to the
// broker but hasn't filled into a real position yet (or has already expired unfilled — that
// gets excluded once monitor.ts processes it, per the expiry fix). We deliberately don't parse
// cTrader's own pending-order wire data for this — we already know everything about an order
// WE placed from bot_signals (pair/direction/lots/entry/SL/TP), so this just cross-references
// that against the live positions list to see which "executed" signals haven't filled yet.
// Note: this won't show a pending limit order placed manually via the Trade tab — those aren't
// tracked in bot_signals at all.
//
// Scoped to the requesting account's own bot(s) — bot_signals has no accountId column of its
// own (a signal only knows its botId), so account scoping goes via which bot(s) are assigned
// to this account. Without this, every account's view showed every other account's pending
// signals too: a signal only gets excluded via openIds when its ctraderPositionId happens to
// match a position actually open on the account being queried, which is never true for an
// unrelated account, so an unscoped query left every account (including ones with no bot
// assigned at all) displaying orders that were never placed on it.
async function getPendingOrders(env: Env, openPositions: Position[], accountId?: string) {
  const openIds = new Set(openPositions.map(p => p.positionId));
  const now = Date.now();
  const resolvedAccountId = accountId ?? 'default';
  const bots    = await listBots(env.DB);
  const botIds  = new Set(bots.filter(b => b.accountId === resolvedAccountId).map(b => b.id));
  const signals = await getBotSignals(env.DB, { status: 'executed', limit: 50 });
  return signals
    .filter(s =>
      botIds.has(s.botId) &&
      s.ctraderPositionId !== null &&
      !openIds.has(s.ctraderPositionId) &&
      s.outcome === null &&
      s.expiresAt > now
    )
    .map(s => ({
      id: s.id,
      pair: s.pair,
      direction: s.direction,
      lots: s.lots,
      limitPrice: s.entryPrice,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      placedAt: s.executedAt,
      expiresAt: s.expiresAt,
    }));
}

// Attach an estimated unrealised P&L (in GBP) to each open position, computed from the
// latest hourly close of the position's own pair — cTrader's ProtoOAPosition carries no
// live floating-profit field, unlike a closing Deal's closePositionDetail.grossProfit, so
// this has to be derived rather than read off the wire. P&L is exact in the pair's own
// quote currency (no lot-size guessing — volume comes straight from the broker); the only
// approximation is converting that into GBP for non-GBP-quoted pairs, using GBP/USD and
// GBP/CAD (both already tracked pairs) as conversion anchors.
async function attachUnrealizedPnl(env: Env, positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;
  if (!env.TWELVE_DATA_API_KEY) return positions;

  const pairs = new Set(positions.map(p => p.symbol));
  // Conversion anchors, only fetched if a position actually needs them.
  if (positions.some(p => quoteCurrency(p.symbol) === 'USD')) pairs.add('GBP/USD');
  if (positions.some(p => quoteCurrency(p.symbol) === 'CAD')) pairs.add('GBP/CAD');
  if (positions.some(p => quoteCurrency(p.symbol) === 'JPY')) { pairs.add('GBP/USD'); pairs.add('USD/JPY'); }

  const provider = createMarketDataProvider({
    provider: env.MARKET_DATA_PROVIDER ?? 'live',
    apiKey:   env.TWELVE_DATA_API_KEY,
    kv:       env.KV,
  });

  const prices = new Map<string, number>();
  await Promise.all([...pairs].map(async (pair) => {
    try {
      const candles = await provider.getCandles(pair as CurrencyPair, '1H', 2);
      const last = candles[candles.length - 1];
      if (last) prices.set(pair, last.close);
    } catch { /* leave unpriced — profit stays unset for affected positions below */ }
  }));

  // GBP/USD price = USD per 1 GBP; GBP/CAD price = CAD per 1 GBP. Dividing a quote-currency
  // amount by these gives GBP directly.
  const usdPerGbp = prices.get('GBP/USD');
  const cadPerGbp = prices.get('GBP/CAD');
  const usdPerJpy = prices.get('USD/JPY');

  return positions.map(p => {
    const mark = prices.get(p.symbol);
    if (mark === undefined) return p;

    const dir = p.direction === 'buy' ? 1 : -1;
    // p.volume is the broker's raw internal scaling (this broker: 1 lot = 10,000,000 raw
    // units) — not base-currency units. p.lots is already normalised via the real per-symbol
    // lotSize, so derive notional from that (1 standard lot = 100,000 units of base currency)
    // rather than assuming a fixed raw-volume divisor.
    const notional = p.lots * 100_000;
    const profitInQuote = (mark - p.openPrice) * notional * dir;

    const quote = quoteCurrency(p.symbol);
    let quotePerGbp: number | undefined;
    if (quote === 'GBP') quotePerGbp = 1;
    else if (quote === 'USD') quotePerGbp = usdPerGbp;
    else if (quote === 'CAD') quotePerGbp = cadPerGbp;
    else if (quote === 'JPY' && usdPerGbp !== undefined && usdPerJpy !== undefined) quotePerGbp = usdPerGbp * usdPerJpy;

    return {
      ...p,
      currentPrice: mark,
      ...(quotePerGbp !== undefined ? { profit: Number((profitInQuote / quotePerGbp).toFixed(2)) } : {}),
    };
  });
}

function quoteCurrency(pair: string): string {
  return pair.split('/')[1] ?? '';
}

async function refreshAccountBalance(env: Env, accountId: string) {
  const account = await getAccount(env.DB, accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const svc = await TradingService.connectToAccount(env, account);
  const { balance } = await svc.getBalance();
  const updatedAt = Date.now();
  await updateAccountBalance(env.DB, accountId, balance, updatedAt);
  return { ...account, balance, balanceUpdatedAt: updatedAt };
}
