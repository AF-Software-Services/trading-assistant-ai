CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  config_json TEXT NOT NULL,
  summary_json TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  lots REAL NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  signal_time INTEGER NOT NULL,
  outcome TEXT,
  close_price REAL,
  close_time INTEGER,
  pnl_pips REAL,
  pnl_gbp REAL,
  source TEXT NOT NULL DEFAULT 'backtest'
);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run ON backtest_trades(run_id);
CREATE INDEX IF NOT EXISTS idx_bt_trades_pair ON backtest_trades(pair);
