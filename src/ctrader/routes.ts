import { Hono } from 'hono';
import { CTraderClient, SYMBOL_IDS, diagnoseCTrader } from './client.ts';

interface Env {
  KV: KVNamespace;
  CTRADER_CLIENT_ID:     string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID:    string;
}

const REDIRECT_URI = 'https://trading-assistant-ai.andrew-dobson.workers.dev/auth/callback';
const AUTH_URL     = 'https://connect.spotware.com/apps/auth';
const TOKEN_URL    = 'https://connect.spotware.com/apps/token';

function client(env: Env, token: string): CTraderClient {
  return new CTraderClient({
    clientId:     env.CTRADER_CLIENT_ID,
    clientSecret: env.CTRADER_CLIENT_SECRET,
    accessToken:  token,
    accountId:    parseInt(env.CTRADER_ACCOUNT_ID),
  });
}

export function createCTraderRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // ── OAuth: initiate ──────────────────────────────────────────────────────────
  app.get('/auth/ctrader', (c) => {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id',     c.env.CTRADER_CLIENT_ID);
    url.searchParams.set('redirect_uri',  REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         'trading');
    return c.redirect(url.toString());
  });

  // ── OAuth: callback ──────────────────────────────────────────────────────────
  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return c.json({ error: 'No code' }, 400);

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
    await c.env.KV.put('ctrader:access_token',  tokens.access_token,  { expirationTtl: tokens.expires_in });
    await c.env.KV.put('ctrader:refresh_token', tokens.refresh_token);

    return c.redirect('/?ctrader=connected');
  });

  // ── Status ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/status', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    return c.json({ connected: !!token, accountId: c.env.CTRADER_ACCOUNT_ID });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  app.post('/api/v1/ctrader/disconnect', async (c) => {
    await c.env.KV.delete('ctrader:access_token');
    await c.env.KV.delete('ctrader:refresh_token');
    return c.json({ disconnected: true });
  });

  // ── TCP socket diagnostic ─────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/diagnose', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    if (!token) return c.json({ ok: false, steps: ['No access token'], hasToken: false });
    const result = await diagnoseCTrader({
      clientId:     c.env.CTRADER_CLIENT_ID,
      clientSecret: c.env.CTRADER_CLIENT_SECRET,
      accessToken:  token,
      accountId:    parseInt(c.env.CTRADER_ACCOUNT_ID),
    });
    return c.json(result);
  });

  // ── Open positions ────────────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/positions', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    if (!token) return c.json({ error: 'Not connected to cTrader' }, 401);
    try {
      const positions = await client(c.env, token).getPositions();
      return c.json({ positions, count: positions.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Close position ────────────────────────────────────────────────────────────
  app.post('/api/v1/ctrader/positions/:id/close', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    if (!token) return c.json({ error: 'Not connected to cTrader' }, 401);

    const positionId = parseInt(c.req.param('id'));
    const body = await c.req.json<{ volume?: number }>().catch(() => ({}));

    try {
      const ct = client(c.env, token);
      // Get volume from open positions if not supplied
      let volume = body.volume;
      if (!volume) {
        const positions = await ct.getPositions();
        const pos = positions.find(p => p.positionId === positionId);
        if (!pos) return c.json({ error: 'Position not found' }, 404);
        volume = pos.volume;
      }
      await ct.closePosition(positionId, volume);
      return c.json({ success: true, positionId });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Place order ───────────────────────────────────────────────────────────────
  app.post('/api/v1/ctrader/orders', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    if (!token) return c.json({ error: 'Not connected to cTrader' }, 401);

    const body = await c.req.json<{
      pair:        string;
      direction:   'buy' | 'sell';
      lots:        number;
      orderType?:  'market' | 'limit';
      limitPrice?: number;
      stopLoss?:   number;
      takeProfit?: number;
    }>();

    const symbolId = SYMBOL_IDS[body.pair];
    if (!symbolId) return c.json({ error: `Unknown pair: ${body.pair}` }, 400);

    try {
      await client(c.env, token).placeOrder({
        symbolId,
        direction:  body.direction,
        lots:       body.lots,
        limitPrice: body.orderType === 'limit' ? body.limitPrice : undefined,
        stopLoss:   body.stopLoss,
        takeProfit: body.takeProfit,
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Trade history ─────────────────────────────────────────────────────────────
  app.get('/api/v1/ctrader/history', async (c) => {
    const token = await c.env.KV.get('ctrader:access_token');
    if (!token) return c.json({ error: 'Not connected to cTrader' }, 401);

    const days = parseInt(c.req.query('days') ?? '30');
    const to   = Date.now();
    const from = to - days * 24 * 60 * 60 * 1000;

    try {
      const deals = await client(c.env, token).getHistory(from, to);
      return c.json({ deals, count: deals.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  return app;
}
