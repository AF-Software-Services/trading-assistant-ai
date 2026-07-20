-- Zone bounds a structure-bot signal's Area of Interest was based on — display parity with
-- trendline's line_p1_ts/line_p2_ts, and a foundation for a future zone-based blacklist if the
-- same "keeps re-entering the same broken level" problem trendline had shows up here too.
ALTER TABLE bot_signals ADD COLUMN zone_low REAL;
ALTER TABLE bot_signals ADD COLUMN zone_high REAL;
