-- Curated display order (the `portfolios.json` array order): focus picker,
-- omnibar actions and the shortcuts modal list portfolios in this order.
ALTER TABLE portfolios ADD COLUMN ord INTEGER NOT NULL DEFAULT 0;
