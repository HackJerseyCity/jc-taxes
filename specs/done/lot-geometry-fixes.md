# Lot Geometry Anomalies

## Overview
Some parcel geometries in the combined dataset (`jc_parcels_combined.parquet`) don't match the apparent physical reality. This spec documents known cases and investigates root causes, rather than unilaterally overriding government data.

## Approach: Notes, Not Overrides
Rather than silently replacing official geometry, the app should support an optional **Notes** field in hoverboxes where we can surface contextual information about anomalous lots. This keeps the visualization honest to the source data while informing users about known issues.

## Case: 33 Bayside Terrace (Block 26001, Lot 47)

### The Anomaly
Lot 47 is a **46.3 sqft sliver polygon** (6-vertex thin triangle). It pays $3,220/yr in taxes, producing an extreme $/sqft outlier ($69.70/sqft) — visible as a tall spike in 3D mode.

### Key Facts

| Field | Lot 47 (33 Bayside Terr) | Lot 15 (536 Garfield Ave) |
|-------|--------------------------|---------------------------|
| Owner | JC BAYSIDE SBEW, LLC | GARCIA, PIERRE G. |
| Land Desc | `40X2 IRR` | `45.74X200 IR.` |
| Building Desc | VACANT LAND | 2.5S-F-D-3U-H-G |
| GIS area | 46 sqft | 8,575 sqft |
| Land assessment | $133,500 | $118,800 |
| Total assessment | $133,500 | $362,800 |
| Sale Price | $1 (nominal LLC transfer) | $1 |
| Deed | Book 9477, Page 467 | Book 9788, Page 352 |

### Why Lot 15 Is Suspicious
Garfield Ave lots on this block are consistently ~20ft wide and ~100ft deep:

| Lot | Address | Dimensions |
|-----|---------|------------|
| 10 | 524 Garfield | 20.69x105 |
| 11 | 526 Garfield | 20.31x104 |
| 12 | 528 Garfield | 20.69x102 |
| 13 | 530 Garfield | 20.20x102 |
| 14 | 532 Garfield | 20.30x101 |
| **15** | **536 Garfield** | **45.74x200** |
| 16 | 538 Garfield | 42x100 |

Lot 15 is **2x wider and 2x deeper** than its neighbors — 200ft deep means it extends all the way from Garfield Ave through to Bayside Terrace. Meanwhile Bayside Terrace lots (27-40) are consistently ~25-42ft wide and ~100ft deep, and lot 47 (33 Bayside) should be about 40x100 based on its neighbors (lots 31 and 32 are 42x100 and 41x101).

The address numbering also jumps from 532 (lot 14) to 536 (lot 15), skipping 534 — suggesting lot 15 was consolidated from multiple original lots.

### What's Visible in Satellite
Google Maps/Earth (as of ~2024) show a large grassy empty lot at 33 Bayside Terrace, clearly delineated, extending roughly half the block depth. A building (which GMaps labels as 33 Bayside Terrace) sits immediately east. The grassy area aligns with where a ~40x100 lot would be; instead, the GIS shows this area as part of lot 15 (536 Garfield).

### Theory: Lot Line Adjustment
Best guess: lot 15 was extended to absorb the back portion of what was lot 47 during a **lot line adjustment or consolidation**. The 40x2 remnant was left as a separate legal parcel (perhaps an access strip or boundary marker along the Bayside Terrace frontage). The assessor still taxes lot 47 at $133,500 because they know there's a substantial vacant parcel, but the GIS polygon only reflects the 2ft remnant.

Supporting evidence:
- Lot 47 is numbered out of sequence with the Bayside Terrace lots (27-40), then jumps to 47 — suggesting it was created/renumbered after the original platting
- The $1 sale price on lot 47 indicates a nominal LLC-to-LLC transfer (common in development or lot-line adjustments)
- Pierre Garcia owns both lot 13 (530 Garfield, normal) and lot 15 (536 Garfield, anomalous) — consolidation of adjacent lots is common
- The $133,500 land assessment on a 40x2 strip only makes sense if the assessor is taxing a larger area than the GIS polygon shows

### Open Questions
- Could the `40X2 IRR` land description be a **data entry error** (e.g., `40X2` instead of `40X102`)? This would explain the assessment but not the GIS polygon.
- NJ deed records (Book 9477, Page 467) might show the actual lot line adjustment. Hudson County deed records may be searchable online.
- The Tax Map Page is 260 — the official JC tax map sheet might show the correct lot boundaries.
- Are there other lots in JC with similarly tiny remnant geometries that produce $/sqft outliers?

### Impact on Visualization
- Lot 47 shows as a tiny bright spike at ~$69.70/sqft (vs ~$1-10/sqft for neighbors)
- At block level, the effect is diluted (block 26001 is large — includes a park)
- At lot level with 3D enabled, it's a very visible artifact

### Current Decision: No Override
We are **not overriding** the government geometry data. Instead:
1. Add a hoverbox "Notes" feature for annotating anomalous lots
2. For lot 47, show a note explaining the sliver geometry and likely lot-line-adjustment history
3. Potentially add outlier detection / capping in the visualization (e.g. percentile-based $/sqft cap)

### References
- [Google Maps (satellite, 120m)](https://www.google.com/maps/place/33+Bayside+Terrace,+Jersey+City,+NJ+07305/@40.6992333,-74.0806087,120m/data=!3m1!1e3)
- [Google Earth (3D)](https://earth.google.com/web/search/33+Bayside+Terrace,+Jersey+City,+NJ/@40.69933431,-74.08044733,13.41026608a,149.03853473d,35y)
- [jc-taxes map (lot view, selected)](http://m3.rbw.sh:3201/?v=40.6993-74.0804+17.8+20+123&wl=1&agg=lot&sel=26001-47)

## Status (2026-09-27)

Done via the notes approach: `www/src/notes.ts` (`getLotNote`) surfaces the 26001-47 note in the tooltip. Geometry itself is left as published.
