-- Migration 003: Bot signals queue
-- Stores trade setups identified by the bot, pending approval or auto-executed

CREATE TABLE IF NOT EXISTS bot_signals (
  id                  TEXT    NOT NULL PRIMARY KEY,
  pair                TEXT    NOT NULL,
  direction           TEXT    NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry_price         REAL    NOT NULL,
  stop_loss           REAL    NOT NULL,
  take_profit         REAL    NOT NULL,
  lots                REAL    NOT NULL,
  score               REAL    NOT NULL,
  recommendation_id   TEXT,
  reasons_json        TEXT    NOT NULL,    -- JSON string[]
  status              TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','executed','expired','failed')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,    -- signal expires if not actioned within 4 hours
  executed_at         INTEGER,
  ctrader_position_id INTEGER,
  journal_id          TEXT,
  rejection_reason    TEXT,
  error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_signals_status ON bot_signals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_signals_pair   ON bot_signals (pair, created_at DESC);
