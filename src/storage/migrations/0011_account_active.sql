-- Accounts are deactivated rather than deleted — this hides them from every view
-- (Dashboard, Positions, Bot assignment, etc.) while keeping their trade history,
-- credentials, and settings intact so they can be reactivated later.
ALTER TABLE ctrader_accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
