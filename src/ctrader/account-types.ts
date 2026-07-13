export interface CTraderAccount {
  id:                string;   // internal UUID
  name:              string;   // user-given name e.g. "Demo GBP"
  type:              'demo' | 'live';
  ctraderAccountId:  string;   // numeric cTrader account ID (e.g. "12345678")
  currency:          string;   // 'GBP' | 'USD' etc
  status:            'pending' | 'connected' | 'error';
  createdAt:         number;
  balance:           number | null;   // live balance from cTrader, cached
  balanceUpdatedAt:  number | null;
}

// ── D1 helpers ────────────────────────────────────────────────────────────────

export async function listAccounts(db: D1Database): Promise<CTraderAccount[]> {
  const { results } = await db.prepare(
    `SELECT * FROM ctrader_accounts ORDER BY created_at ASC`
  ).all<Record<string, unknown>>();
  return results.map(rowToAccount);
}

export async function getAccount(db: D1Database, id: string): Promise<CTraderAccount | null> {
  const row = await db.prepare(
    `SELECT * FROM ctrader_accounts WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  return row ? rowToAccount(row) : null;
}

export async function createAccount(
  db: D1Database,
  account: Omit<CTraderAccount, 'createdAt' | 'balance' | 'balanceUpdatedAt'>,
): Promise<CTraderAccount> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO ctrader_accounts (id, name, type, ctrader_account_id, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(account.id, account.name, account.type, account.ctraderAccountId, account.currency, account.status, now).run();
  return { ...account, createdAt: now, balance: null, balanceUpdatedAt: null };
}

export async function updateAccountStatus(
  db: D1Database,
  id: string,
  status: CTraderAccount['status'],
): Promise<void> {
  await db.prepare(`UPDATE ctrader_accounts SET status = ? WHERE id = ?`).bind(status, id).run();
}

// Best-known real account balance to use as a sizing default when nothing more
// specific is selected (backtests, MCP tools). Prefers the "default" account,
// then any other account with a cached balance.
export async function getPrimaryAccountBalance(db: D1Database): Promise<number | null> {
  const accounts = await listAccounts(db);
  const primary = accounts.find(a => a.id === 'default' && a.balance != null)
    ?? accounts.find(a => a.balance != null);
  return primary?.balance ?? null;
}

export async function updateAccountBalance(
  db: D1Database,
  id: string,
  balance: number,
  updatedAt: number,
): Promise<void> {
  await db.prepare(
    `UPDATE ctrader_accounts SET balance = ?, balance_updated_at = ? WHERE id = ?`
  ).bind(balance, updatedAt, id).run();
}

export async function deleteAccount(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM ctrader_accounts WHERE id = ?`).bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

function rowToAccount(row: Record<string, unknown>): CTraderAccount {
  return {
    id:               row['id']                  as string,
    name:             row['name']                as string,
    type:             row['type']                as 'demo' | 'live',
    ctraderAccountId: row['ctrader_account_id']  as string,
    currency:         row['currency']            as string,
    status:           row['status']              as CTraderAccount['status'],
    createdAt:        row['created_at']          as number,
    balance:          (row['balance']            as number | null) ?? null,
    balanceUpdatedAt: (row['balance_updated_at'] as number | null) ?? null,
  };
}

// ── KV token helpers ──────────────────────────────────────────────────────────

export function tokenKey(accountId: string): string {
  return `ctrader:account:${accountId}:access_token`;
}

export function refreshKey(accountId: string): string {
  return `ctrader:account:${accountId}:refresh_token`;
}

// ── Seed: migrate legacy single-account setup on first run ───────────────────

export async function seedDefaultAccount(
  db: D1Database,
  kv: KVNamespace,
  ctraderAccountId: string,
): Promise<void> {
  const count = await db
    .prepare(`SELECT COUNT(*) as c FROM ctrader_accounts`)
    .first<{ c: number }>();
  if ((count?.c ?? 0) > 0) return;

  const id = 'default';
  await createAccount(db, {
    id,
    name:             'Demo Account',
    type:             'demo',
    ctraderAccountId,
    currency:         'GBP',
    status:           'pending',
  });

  // Copy legacy global token to the per-account key
  const legacyToken   = await kv.get('ctrader:access_token');
  const legacyRefresh = await kv.get('ctrader:refresh_token');
  if (legacyToken) {
    await kv.put(tokenKey(id), legacyToken);
    if (legacyRefresh) await kv.put(refreshKey(id), legacyRefresh);
    await updateAccountStatus(db, id, 'connected');
  }
}
