-- Multiple cTrader accounts (demo and live)
-- Each account stores its own ctrader_account_id and currency.
-- Access tokens are stored separately in KV: ctrader:account:{id}:access_token

CREATE TABLE IF NOT EXISTS ctrader_accounts (
  id                 TEXT    NOT NULL PRIMARY KEY,
  name               TEXT    NOT NULL,
  type               TEXT    NOT NULL CHECK (type IN ('demo', 'live')),
  ctrader_account_id TEXT    NOT NULL,
  currency           TEXT    NOT NULL DEFAULT 'GBP',
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error')),
  created_at         INTEGER NOT NULL
);

-- Associate bots with a specific trading account; NULL = default/any connected account
ALTER TABLE bots ADD COLUMN account_id TEXT REFERENCES ctrader_accounts(id);
