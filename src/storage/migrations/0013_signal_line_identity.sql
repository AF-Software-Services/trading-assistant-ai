-- Identifies which trendline a signal was based on (anchor swing-point timestamps), so a
-- losing setup's exact line can be blacklisted for a cooldown instead of the bot re-entering
-- the same broken level on the next retest.
ALTER TABLE bot_signals ADD COLUMN line_type TEXT;
ALTER TABLE bot_signals ADD COLUMN line_p1_ts INTEGER;
ALTER TABLE bot_signals ADD COLUMN line_p2_ts INTEGER;
