-- Trading Assistant AI — D1 Schema
-- All timestamps are Unix milliseconds (INTEGER)
-- Booleans are stored as INTEGER (0 = false, 1 = true)
-- Prices and ratios are REAL
-- IDs and text fields are TEXT

-- ── Candles Cache ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candles_cache (
  id          TEXT    NOT NULL,          -- pair:timeframe:timestamp
  pair        TEXT    NOT NULL,
  timeframe   TEXT    NOT NULL,
  timestamp   INTEGER NOT NULL,          -- candle open time, unix ms
  open        REAL    NOT NULL,
  high        REAL    NOT NULL,
  low         REAL    NOT NULL,
  close       REAL    NOT NULL,
  volume      REAL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_candles_pair_tf ON candles_cache (pair, timeframe, timestamp DESC);

-- ── Support / Resistance Zones ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_resistance_zones (
  id             TEXT    NOT NULL PRIMARY KEY,  -- pair:timeframe:type:midpoint
  pair           TEXT    NOT NULL,
  timeframe      TEXT    NOT NULL,
  type           TEXT    NOT NULL CHECK (type IN ('support', 'resistance')),
  low            REAL    NOT NULL,
  high           REAL    NOT NULL,
  midpoint       REAL    NOT NULL,
  strength       REAL    NOT NULL DEFAULT 0,
  touch_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at  INTEGER NOT NULL,
  last_tested_at INTEGER NOT NULL,
  is_broken      INTEGER NOT NULL DEFAULT 0,    -- 0 = false, 1 = true
  is_retested    INTEGER NOT NULL DEFAULT 0,
  confidence     REAL    NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_zones_pair_type ON support_resistance_zones (pair, type, is_broken);
CREATE INDEX IF NOT EXISTS idx_zones_strength   ON support_resistance_zones (strength DESC);

-- ── Candlestick / Price Action Signals ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id          TEXT    NOT NULL PRIMARY KEY,   -- pair:timeframe:type:timestamp
  pair        TEXT    NOT NULL,
  timeframe   TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  timestamp   INTEGER NOT NULL,               -- candle timestamp
  price       REAL    NOT NULL,
  confidence  REAL    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_pair      ON signals (pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_type      ON signals (type);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals (timestamp DESC);

-- ── Trade Recommendations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendations (
  id                   TEXT    NOT NULL PRIMARY KEY,
  pair                 TEXT    NOT NULL,
  direction            TEXT    NOT NULL CHECK (direction IN ('buy', 'sell', 'neutral')),
  confidence           REAL    NOT NULL,
  score_breakdown_json TEXT    NOT NULL,       -- JSON: ScoreBreakdown
  setup_type           TEXT    NOT NULL,
  entry_zone_json      TEXT    NOT NULL,       -- JSON: { low, high }
  stop_idea            REAL    NOT NULL,
  target1              REAL    NOT NULL,
  target2              REAL,
  risk_amount          REAL    NOT NULL,
  reward_amount        REAL    NOT NULL,
  reward_risk_ratio    REAL    NOT NULL,
  expected_hold_days   INTEGER NOT NULL DEFAULT 3,
  reasons_json         TEXT    NOT NULL,       -- JSON: string[]
  invalidation_json    TEXT    NOT NULL,       -- JSON: string[]
  action               TEXT    NOT NULL CHECK (action IN ('watch', 'consider_trade', 'manage_trade', 'no_trade')),
  status               TEXT    NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'closed', 'invalidated', 'expired')),
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  closed_at            INTEGER,
  closed_reason        TEXT,
  outcome              TEXT    CHECK (outcome IN ('win', 'loss', 'breakeven') OR outcome IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_recs_pair    ON recommendations (pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recs_status  ON recommendations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recs_action  ON recommendations (action);

-- ── Recommendation Reviews ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_reviews (
  id                    TEXT    NOT NULL PRIMARY KEY,
  recommendation_id     TEXT    NOT NULL REFERENCES recommendations(id),
  action                TEXT    NOT NULL CHECK (action IN ('hold', 'close', 'move_stop', 'partial_profit', 'invalidate')),
  reason                TEXT    NOT NULL,
  suggested_stop        REAL,
  suggested_partial_close REAL,
  urgency               TEXT    NOT NULL CHECK (urgency IN ('low', 'medium', 'high')),
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_rec_id ON recommendation_reviews (recommendation_id, created_at DESC);

-- ── Trade Journal ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_journal (
  id                TEXT    NOT NULL PRIMARY KEY,
  recommendation_id TEXT    REFERENCES recommendations(id),
  pair              TEXT    NOT NULL,
  direction         TEXT    NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry_price       REAL    NOT NULL,
  stop_loss         REAL    NOT NULL,
  target            REAL    NOT NULL,
  confidence        REAL    NOT NULL,
  notes             TEXT,
  screenshot_url    TEXT,
  result            TEXT    CHECK (result IN ('win', 'loss', 'breakeven') OR result IS NULL),
  pnl               REAL,                        -- in GBP
  created_at        INTEGER NOT NULL,
  closed_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_journal_pair ON trade_journal (pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_rec  ON trade_journal (recommendation_id);

-- ── Scan Runs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_runs (
  id                        TEXT    NOT NULL PRIMARY KEY,
  session_name              TEXT    NOT NULL,
  pairs_scanned             TEXT    NOT NULL,    -- JSON: CurrencyPair[]
  recommendations_generated INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  duration_ms               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_session ON scan_runs (session_name, created_at DESC);
