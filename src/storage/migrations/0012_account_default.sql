-- Marks one account as the default view — the account that Dashboard, Positions, History,
-- etc. should initially show instead of "All", until the user explicitly changes it.
ALTER TABLE ctrader_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
