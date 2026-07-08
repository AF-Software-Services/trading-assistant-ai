-- Migration 002: Trade Journal ML Feature Capture
-- Adds feature vector, exit tracking, and ML stats to trade_journal

ALTER TABLE trade_journal ADD COLUMN timeframe        TEXT;
ALTER TABLE trade_journal ADD COLUMN exit_price       REAL;
ALTER TABLE trade_journal ADD COLUMN pnl_pips         REAL;
ALTER TABLE trade_journal ADD COLUMN rr_achieved      REAL;
ALTER TABLE trade_journal ADD COLUMN session          TEXT;         -- 'london' | 'ny' | 'asian' | 'overlap'
ALTER TABLE trade_journal ADD COLUMN day_of_week      INTEGER;     -- 0=Sun..6=Sat
ALTER TABLE trade_journal ADD COLUMN features_json    TEXT;        -- TradeFeatures JSON
