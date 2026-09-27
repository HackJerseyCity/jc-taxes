# Data delivery rethink: small first paint, ~zero-cost animation

## Problem

The map downloads one full GeoJSON per (view, year): geometry + all properties, repeated for every year.

| view | raw / year | gzip / year | 11 years (animation), gzip |
|---|---|---|---|
| blocks | 2.8 MB | 0.9 MB | ~10 MB |
| lots | 25.1 MB | 4.1 MB | ~45 MB |
| units | 40.7 MB | 6.4 MB | ~70 MB |

And prod is worse than the gzip column: R2 objects (DVC cache, `data.jct.rbw.sh/.dvc/cache/files/md5/…`) have no `Content-Type`, so Cloudflare neither compresses nor caches them (`cf-cache-status: DYNAMIC`, `content-length: 25093675` for 2025 lots). Lot-view animation on a phone is ~275 MB today.

Where the bytes go (2025 lots, gzip): geometry 1.9 MB, properties 1.7 MB (addr / owner / building info / streets), per-year `paid` for all 11 years packed as `uint32` dollars: **0.85 MB total**.

## Design

Separate four things that are currently fused, and send each only when needed:

1. **Geometry → vector tiles (PMTiles on R2).** One archive per view (blocks, lots, units; wards / census blocks are small and can stay GeoJSON). Fetched by HTTP range request, only for tiles in view, simplified per zoom (tippecanoe; `brew install tippecanoe`). Features carry a compact integer id plus the few attributes needed for rendering / filtering: `block`, `lot`(, `qual`), `ward`, `hood`, `area_sqft`, `yr_built`.
   - 3D extrusion across tile boundaries: build with `--no-clipping` / `--no-duplication` (each parcel lives whole in one tile per zoom) so walls don't appear at tile edges; parcels are small, so tile bloat is bounded.
   - deck.gl `MVTLayer` (or `TileLayer` + `pmtiles` source) with `uniqueIdProperty` for hover / selection.
2. **Values → one small binary per view with every year.** `values-{view}.bin`: `uint32` paid (and billed) dollars, `[feature][year]`, indexed by tile feature id; header with year range + counts. Lots ≈ 0.85 MB gz for all 11 years; blocks tiny. Colors / heights / interpolation read from this array, so **animation downloads nothing extra**. (Alternative: embed per-year values as tile attributes; costs bytes in every tile at every zoom and bloats low-zoom tiles. Prefer the side array.)
3. **Details → on demand.** Hover box / selection fetches the parcel's detail record (addr, owner, building info, streets) from sharded JSON on R2 (`details/{block}.json`, a few KB each) or a Worker + D1 endpoint. Nothing detailed is downloaded for parcels nobody looks at.
4. **Aggregates → server-side.** Totals chip, sparkline, focus camera (bbox + per-member tops), and height/color scale maxima come from the Worker's aggregates API, backed by D1 tables the pipeline fills (citywide, wards, neighborhoods, portfolios × years × metrics; extends today's `jct stats`). The client never needs every feature loaded to show a total.

Plus: **search** (omnibar address → parcel) becomes a lazy index (`addr → id, centroid`, ~0.4 MB gz) fetched when the omnibar first opens, or a Worker endpoint.

**Serving:** every data object gets a proper `Content-Type`; tiles / values / aggregates / details are served with compression and long-lived caching (content-addressed names, `Cache-Control: immutable`), either by setting R2 object metadata at upload or by routing through the `jct-edge` Worker.

### Budget

| | today (prod, lots) | target |
|---|---|---|
| first paint | 25 MB | basemap + tiles in view (~0.2–0.6 MB) + aggregates (~50 KB) + values (~0.9 MB, can load after first paint) |
| animation, all years | +250 MB | 0 |
| hover / select | 0 (already downloaded) | ~few KB per block, cached |

## Decisions (2026-09-27)

- **Server computes, client renders.** Anything derived from many parcels (height-scale maxima, totals chip, sparkline, focus camera bbox / bar tops, citywide paid-so-far) comes from the `jct-edge` Worker; the client never downloads data just to compute an aggregate. The client only gets per-feature values for what it draws.
- **Storage:** records and queryable data live in **D1** (`jct`, `edge/d1/migrations`): portfolios (done), aggregates / scales / totals, parcel details, search, later TTM-by-date. Bulk arrays read whole by every client (tiles, per-feature values) stay **content-addressed R2 objects** served by the Worker (edge-cached, immutable); the Worker can front them with API URLs so storage stays an implementation detail. No new "small JSON file" app data.
- **Height scale:** default = one scale across all years (so growth over time is visible; playback already does this); Settings toggle for per-year fit. The cross-year max comes from the aggregates API, not from loading every year.
- **Measure:** `www/net` download-size suite (baseline + history) runs against deploys; each phase lands with a baseline update showing its effect.

## Phases

1. ✅ **Serving fix** (done 2026-09-27, via the Worker rather than bucket metadata): `jct-edge` `/d/*` serves the DVC objects as JSON, edge-compressed and immutable-cached, same-origin (lots 25.1 MB → 4.1 MB). `jct.rbw.sh` cut over from GitHub Pages to the Worker.
2. **Aggregates API + values arrays** (mostly done 2026-09-27).
   - ✅ `jct aggregates` → D1 `aggregates` (view × focus × year totals / height maxima) → `/api/summary`: totals chip, sparkline, cross-year height scale (default; `hy` for per-year).
   - ✅ `jct bundle` → per view (block / lot / unit) `geom-{view}.geojson` (fixed props) + `values-{view}.json` (all years' paid, billed − paid; integer cents), DVC → `/d`; owners → D1 `owners` → `/api/parcel` on hover / select. Wards / census blocks keep per-year GeoJSON (geometry varies by year; small).
   - Measured (`www/net`, prod): lots playback 52.6 → 4.9 MB, blocks playback 12.2 → 1.0 MB, year step 8.1 → 4.9 MB; first load +~1 MB (lots 4.0 → 4.9) for having every year.
   - ✅ Values as binary (`values-{view}.bin`: i32 cents, or f64 where block totals overflow; `[feature][year]`), geometry coordinates rounded to 6 decimals, and max-brotli copies (`jct r2 precompress` → `br/<md5>`) served as-is by `/d` with `Content-Encoding: br`.
   - ✅ Per-year values files (`values-{view}-{year}.bin`): first load fetches one year's values (lots 1.38 → 0.13 MB); playback 1.62 MB total. Parquet measured ~1.6× larger than the custom layout.
   - ✅ Details (address, building info, owners) moved from lot / unit geometry to D1 `parcels` → `/api/parcel` on hover / select; address search `/api/search` (FTS5, exact house number ranked first) in the omnibar. Lots geometry 1.29 → 1.00 MB.
   - Dropped: server-side camera extents. The geometry file is loaded once per view anyway, so fitting over in-memory members costs nothing extra.
3. **Vector tiles for geometry.** PMTiles per view (R2, range requests through the Worker), `MVTLayer` extruded with id-indexed values; verify extrusion across tiles (`--no-clipping`), picking, focus fade / hide, portfolio membership by id set.
4. **Search** (`/api/search`, D1 FTS) and details polish.

## Open questions

- Values in tiles vs side array: side array chosen above; revisit if tile-local values simplify the `MVTLayer` accessors enough to matter.
- Unit view: 58k features; tiles make it viable, but consider whether it should be a zoomed-in-only view (minzoom ~15).
- The scrns capture / `animYr` path relies on per-year GeoJSON today; port it to the values array.
