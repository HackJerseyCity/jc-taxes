-- Curated developer/owner portfolios (schema only; rows are seeded from the DVC-tracked `portfolios.json` by `scripts/seed-portfolios.mjs`,
-- never committed). List columns hold JSON arrays of strings.
CREATE TABLE IF NOT EXISTS portfolios (
  key       TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  note      TEXT,
  blocks    TEXT,  -- JSON array of tax-block ids, e.g. ["7301","7301.01"]
  parcels   TEXT,  -- JSON array of "block-lot" ids
  keywords  TEXT,  -- JSON array of omnibar search aliases
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
