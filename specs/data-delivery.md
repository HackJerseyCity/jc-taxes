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
4. **Aggregates → precomputed.** Totals chip, sparkline, focus camera (bbox + per-member tops), and height/color scale maxima come from one precomputed `aggregates.json` (citywide, wards, neighborhoods, portfolios × years × metrics; tens of KB). Extends today's `jct stats` / `stats.json`. The client never needs every feature loaded to show a total.

Plus: **search** (omnibar address → parcel) becomes a lazy index (`addr → id, centroid`, ~0.4 MB gz) fetched when the omnibar first opens, or a Worker endpoint.

**Serving:** every data object gets a proper `Content-Type`; tiles / values / aggregates / details are served with compression and long-lived caching (content-addressed names, `Cache-Control: immutable`), either by setting R2 object metadata at upload or by routing through the `jct-edge` Worker.

### Budget

| | today (prod, lots) | target |
|---|---|---|
| first paint | 25 MB | basemap + tiles in view (~0.2–0.6 MB) + aggregates (~50 KB) + values (~0.9 MB, can load after first paint) |
| animation, all years | +250 MB | 0 |
| hover / select | 0 (already downloaded) | ~few KB per block, cached |

## Phases

1. **Serving fix (hours).** Content-Type + compression + caching for the existing R2 objects (object metadata at `dvc push`, or serve via the Worker). Immediate 6× on prod, no format change.
2. **Split values from geometry (≈1 day).** Emit `values-{view}.bin` + `aggregates.json`; client loads geometry once (still GeoJSON for now, trimmed properties) + values; details split out. Lots animation ≈ 3–4 MB gz total. The client-side interfaces (values array, aggregates, detail fetch) are the ones phase 3 keeps.
3. **Vector tiles for geometry (≈2–3 days).** PMTiles per view, `MVTLayer`, id-indexed values; verify extrusion across tiles, picking, focus fade / hide via `DataFilterExtension` or accessor, and portfolio membership by id set.
4. **Search index + details endpoint polish.**

## Open questions

- Values in tiles vs side array: side array chosen above; revisit if tile-local values simplify the `MVTLayer` accessors enough to matter.
- Unit view: 58k features; tiles make it viable, but consider whether it should be a zoomed-in-only view (minzoom ~15).
- The scrns capture / `animYr` path relies on per-year GeoJSON today; port it to the values array.
