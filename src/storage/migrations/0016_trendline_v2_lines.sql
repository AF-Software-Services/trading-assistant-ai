-- Trendline V2's line lifecycle state — the existing trendline bot re-derives its candidate
-- lines fresh every scan with no memory of "this exact line already broke"; Trendline V2 needs
-- persisted state instead: a line stays in the active/watched set until a genuine close-based
-- break retires it, and the active set doesn't grow while a trade is open on that pair (no new
-- buildLines() discovery), only ever gets checked for a break against what's already known.
CREATE TABLE IF NOT EXISTS trendline_v2_lines (
  id             TEXT    NOT NULL PRIMARY KEY,
  bot_id         TEXT    NOT NULL,
  pair           TEXT    NOT NULL,
  line_type      TEXT    NOT NULL CHECK (line_type IN ('resistance', 'support')),
  p1_ts          INTEGER NOT NULL,
  p2_ts          INTEGER NOT NULL,
  p1_price       REAL    NOT NULL,
  p2_price       REAL    NOT NULL,
  slope          REAL    NOT NULL,
  touches        INTEGER NOT NULL,
  discovered_at  INTEGER NOT NULL,
  retired_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trendline_v2_lines_lookup ON trendline_v2_lines(bot_id, pair, retired_at);

-- Which specific opposite-type line (by id above) a Trendline V2 signal uses as its dynamic
-- take-profit reference, instead of a fixed price set once at entry.
ALTER TABLE bot_signals ADD COLUMN opposite_line_id TEXT;
