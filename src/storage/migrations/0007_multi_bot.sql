-- Multi-bot architecture
-- Each bot instance has its own config, mode, and pair assignment.
-- bot_signals gains a bot_id to attribute signals to a specific bot.

CREATE TABLE IF NOT EXISTS bots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,  -- 'structure' | 'trendline' (extensible)
  mode        TEXT NOT NULL DEFAULT 'off',  -- 'off' | 'approval' | 'autonomous'
  pairs_json  TEXT NOT NULL DEFAULT '[]',   -- JSON array of CurrencyPair strings
  settings_json TEXT NOT NULL DEFAULT '{}', -- JSON blob of type-specific settings
  created_at  INTEGER NOT NULL
);

ALTER TABLE bot_signals ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_bot_signals_bot_id ON bot_signals(bot_id);
