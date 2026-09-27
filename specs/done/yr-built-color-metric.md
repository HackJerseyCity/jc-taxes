# Year Built as Color Metric

## Summary
Add `yr_built` (year built) as an optional color metric for the map, alongside the existing `per_sqft` and `per_capita` metrics. This enables visualizing the age distribution of buildings across Jersey City.

## Prerequisites
- `yr_built` field already present in lot-level and unit-level GeoJSON properties (from the building desc parsing work).

## Data Profile
- Coverage: ~85.6% of records (55,541 / 64,821) have `Yr. Built`
- Range: ~1800s to 2020s; most common values: 1900, 2008, 2007, 1925, 1890
- Distribution is bimodal: pre-war cluster (~1880-1930) and modern cluster (~2000-2020)

## Plan

### 1. Extend `MetricMode` type
Currently `'per_sqft' | 'per_capita'`. Add `'yr_built'`.

### 2. Make `yr_built` available for lot/unit views
Currently `per_capita` is only available for census-block/ward views. `yr_built` should be available for lot and unit views (where the data lives). Possibly also block (could use median or mode of constituent lots).

### 3. Color scale configuration
- Scale type: `linear` (years are naturally linear)
- Suggested range: ~1870 to ~2025
- Color stops: old → new, e.g.:
  - Dark theme: deep red (oldest) → yellow → green (newest)
  - Light theme: similar but adjusted for legibility
- Features with no `yr_built` → neutral gray

### 4. Elevation
When `yr_built` is the active metric and 3D is enabled, the elevation should represent `yr_built`. The "tallest" buildings would be the newest (or oldest, depending on preference — newest-tallest seems more intuitive since newer buildings are often literally taller).

### 5. Hoverbox
`yr_built` is already displayed in the hoverbox building info line. When it's the active color metric, highlight it with `var(--text-accent)` like the other metrics.

### 6. Settings panel
Add `yr_built` to the Metric dropdown for lot/unit views. Label: "Year built".

### 7. Gradient editor
The gradient editor currently shows $/sqft or $/capita labels. For `yr_built`, labels should show years (e.g., "1900", "1960", "2020"). The `metricLabel` prop or gradient formatting would need to handle this.

## Files to Change
| File | Change |
|------|--------|
| `www/src/App.tsx` | Add `yr_built` to `MetricMode`, `MODE_DEFAULTS`, metric dropdown, `getMetricValue`, accent highlighting |
| `www/src/GradientEditor.tsx` | Handle year formatting in labels (no `$` prefix, no `/sqft` suffix) |

## Open Questions
- Should `yr_built` metric be available at block level? Would require computing median/mode per block in `geojson_yearly.py`.
- Color direction: old=red→new=green, or reversed? Old=warm/new=cool could also work.
- Should null `yr_built` values be visually distinct from 0 (which doesn't exist in the data)?

## Status (2026-09-27)

Done: color-by-year-built (`cb=yr_built`, lot / unit views; `Y` key) with its own gradient, and grey for unknown year.
