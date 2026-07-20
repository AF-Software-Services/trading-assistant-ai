-- Test bots: full bot configs (same type/settings shape as a live bot) used for backtesting
-- only, with a manually-set starting balance instead of a real account. Hidden from the live
-- Bot tab and cron/monitor by default (see listBots's includeTest option) until promoted to a
-- real bot by assigning a real account_id and flipping is_test back to 0.
ALTER TABLE bots ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN starting_balance REAL;
