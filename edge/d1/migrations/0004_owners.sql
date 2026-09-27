-- Per-parcel owner history for the lot / unit views, served on demand
-- (`/api/parcel`) so owner names needn't ship with every parcel's geometry.
-- `owners`: JSON run-length list `[[firstYear, owner], …]` (owner in effect
-- from that year until the next entry). Filled by `jct bundle`.
CREATE TABLE IF NOT EXISTS owners (
  view    TEXT NOT NULL,  -- lot | unit
  id      TEXT NOT NULL,  -- the app's `featureIdOf`: block-lot[-qual]
  owners  TEXT NOT NULL,
  PRIMARY KEY (view, id)
);
