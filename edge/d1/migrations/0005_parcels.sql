-- Per-parcel details for the lot / unit views, served on demand
-- (`/api/parcel`, hover / select) and searched (`/api/search`), so they needn't
-- ship with every parcel's geometry. Replaces `owners`. Filled by `jct bundle`.
DROP TABLE IF EXISTS owners;
CREATE TABLE IF NOT EXISTS parcels (
  view       TEXT NOT NULL,   -- lot | unit
  id         TEXT NOT NULL,   -- the app's `featureIdOf`: block-lot[-qual]
  addr       TEXT,
  bldg_desc  TEXT,
  stories    REAL,
  units      INTEGER,
  bldg_sqft  INTEGER,
  lng        REAL,            -- bbox center of the parcel geometry
  lat        REAL,
  owners     TEXT NOT NULL,   -- JSON run-length `[[firstYear, owner], …]`
  PRIMARY KEY (view, id)
);
-- Address search (lot rows; `jct bundle` rebuilds it after loading).
CREATE VIRTUAL TABLE IF NOT EXISTS parcels_fts USING fts5(addr, content='parcels', content_rowid='rowid', tokenize='unicode61');
