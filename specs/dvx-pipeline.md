# DVX-native pipeline: provenance for every stage

## Problem

Only the 2015–2025 per-year GeoJSONs record provenance, and only a `cmd` (no `deps`), so `dvx status` can't say what's stale. Everything else is either tracked without provenance or not tracked at all:

- Untracked intermediates in `data/`: `payments.parquet`, `taxrecords_enriched.parquet`, `taxrecords_jc.parquet`, `accounts_index.parquet`, `taxes.parquet`, …
- Tracked, no provenance:
  - `data/cache` (HLS pull)
  - 2026 GeoJSONs
  - `geom-*` / `values-*` / `ward-shapes-*` bundles
  - `data/parcels/*`, `jc_parcels_combined.parquet`
  - `portfolios.json`
- Side effects with no stage at all:
  - D1 loads: `jct aggregates`, `jct bundle`'s `parcels` table, `seed-portfolios`
  - R2 uploads: `jct r2 precompress`, `jct r2 publish`, the OG map captures
  - `wrangler deploy` (CI does this on push; data changes don't trigger it)

After an HLS re-pull, rebuilding means remembering the order by hand. That's error-prone: a missed `precompress` just silently serves on-the-fly compression, and a missed `aggregates` leaves the chip and scale stale.

## Stages (inputs → outputs)

| stage | cmd | deps | outs |
|---|---|---|---|
| HLS pull | `python -m jc_taxes.cli pull …` | — (external; fetch schedule) | `data/cache/` |
| payments | `python -m jc_taxes.payments` | `data/cache/` | `data/payments.parquet` |
| enriched records | (existing script) | `data/cache/`, MOD-IV | `data/taxrecords_enriched.parquet` |
| county parcels | `jct parcels fetch` | — (external, snapshot-named) | `data/parcels/Hudson_County_Parcels_<M_YYYY>.geojson` |
| combine | `jct parcels combine` | county GeoJSON, `legacy_combined.parquet`, `payments.parquet` | `data/jc_parcels_combined.parquet` |
| per-year GeoJSON (×12 years × 5 views) | `python -m jc_taxes.geojson_yearly -y Y -a A -o www/public` | combined parcels, `payments.parquet`, `taxrecords_enriched.parquet`, census / neighborhoods, coastline | `www/public/taxes-Y-A.geojson` |
| bundle | `jct bundle -n` | all 60 per-year GeoJSONs | `geom-*`, `values-*`, `ward-shapes-*`, `tmp/parcels.sql` |
| D1 parcels | `wrangler d1 execute jct --file tmp/parcels.sql` | bundle SQL | side effect |
| aggregates | `jct aggregates` | per-year GeoJSONs, `portfolios.json` | side effect (D1 `aggregates`) |
| portfolios | `node edge/scripts/seed-portfolios.mjs …` | `portfolios.json` | side effect (D1 `portfolios`) |
| precompress | `jct r2 precompress` | bundle outputs | side effect (R2 `br/<md5>`) |
| OG maps | (capture script → `jct og maps`) | deployed app | side effect (R2 `jct-og/maps/*`) |

## Plan

1. Track the intermediates in `data/` with DVX (they're large; R2 cache).
2. Write `meta.computation` (`cmd` + `deps` with md5s) into each `.dvc`, via a small `jct dvx provenance` helper that knows the table above. That avoids hand-editing ~80 `.dvc` files.
3. Side-effect stages as DVX side-effect `.dvc`s (no outs; deps + cmd), so `dvx status` flags e.g. "aggregates stale: `taxes-2026-lot.geojson` changed".
4. `dvx run` then rebuilds a re-pull end to end, in parallel where independent (the 60 per-year GeoJSONs).
5. Document the one-command refresh in the README.

## Open questions

- External inputs (HLS, county layer): DVX fetch schedules, or leave as manual `fetch` stages with URL provenance?
- `payments.parquet` also has stray far-future rows (2032–2035); filter at the `payments` stage.
