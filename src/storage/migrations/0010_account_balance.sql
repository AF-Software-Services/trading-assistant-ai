-- Cache live account balance, fetched from cTrader's ProtoOATraderRes.
-- Refreshed on connect, on each bot scan, and via manual "Refresh" in the UI.

ALTER TABLE ctrader_accounts ADD COLUMN balance REAL;
ALTER TABLE ctrader_accounts ADD COLUMN balance_updated_at INTEGER;
