-- Add bot scan outcome fields to scan_runs
ALTER TABLE scan_runs ADD COLUMN signals_found    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN signals_queued   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN signals_executed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN error            TEXT;
