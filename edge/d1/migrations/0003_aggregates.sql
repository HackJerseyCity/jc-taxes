-- Per (view × focus × year) totals and height-scale maxima, computed by the
-- pipeline (`jct aggregates`) from the map's own GeoJSON and served by
-- `/api/summary`, so the client never loads other years (or all features) to
-- total or scale. `focus`: '' (citywide), 'pf:<key>', 'ward:<A-F>', 'hood:<name>'.
-- Amounts are billed for billed-basis years (still being paid), else paid,
-- matching the app's `amountOf` / `metricValue`.
CREATE TABLE IF NOT EXISTS aggregates (
  view            TEXT    NOT NULL,  -- block | lot | unit | ward | census-block
  focus           TEXT    NOT NULL,
  year            INTEGER NOT NULL,
  count           INTEGER NOT NULL,  -- features (the view's own unit: blocks, lots, …)
  amount          REAL    NOT NULL,  -- paid (billed for billed-basis years)
  paid            REAL    NOT NULL,
  billed          REAL    NOT NULL,
  -- Height-scale maxima: max per-feature metric over the focus members. Per-sqft
  -- skips slivers under 500 sqft (the app's `MIN_SCALE_AREA_SQFT`).
  max_per_sqft    REAL,
  max_total       REAL,
  max_per_capita  REAL,              -- ward / census-block only
  PRIMARY KEY (view, focus, year)
);
