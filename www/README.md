# jc-taxes/www

Vite + React + TypeScript web app for the [jc-taxes] interactive tax map.

**Live**: [jct.rbw.sh]

## Dev

```bash
pnpm install
pnpm dev        # http://localhost:3201 (3201 = JC area code)
pnpm dev:s3     # use S3 data URLs instead of local GeoJSON files
```

Data files (`taxes-{year}-{agg}.geojson`) are [DVC]-tracked in `public/`. In dev mode, [vite-plugin-dvc] resolves them as local paths; in production builds, as S3 HTTPS URLs.

## Stack

- [deck.gl] — 3D extruded `GeoJsonLayer` on [maplibre-gl] base map
- [use-kbd] — omnibar search, editable keyboard shortcuts, shortcuts modal
- [use-prms] — URL query param state (`v`, `y`, `agg`, `scale`, `mh`, `sel`, ...)
- [vite-plugin-dvc] — resolves `.dvc` files to local paths (dev) or S3 URLs (build)

## Key files

| File | What |
|---|---|
| `src/App.tsx` | Main component: deck.gl map, settings panel, tooltips, ward labels |
| `src/SpeedDial.tsx` | Unified FAB: hover-peek + click-to-pin, search/shortcuts/theme/GitHub |
| `src/GradientEditor.tsx` | Interactive color gradient editor (draggable stops, scale selector) |
| `src/useKeyboardShortcuts.ts` | Hotkey definitions (year, view, pitch, zoom, height, theme) |
| `src/useParcelSearch.ts` | Omnibar endpoint: fuzzy search parcels by address/block/owner |
| `src/useTouchPitch.ts` | Two-finger pitch gesture for mobile (deck.gl workaround) |
| `src/ThemeContext.tsx` | Dark/light theme with per-theme gradient defaults, URL-persisted color stops |
| `src/notes.ts` | Per-lot hoverbox notes for known anomalies |
| `src/types.ts` | `ParcelProperties`, `ParcelFeature` types |

## URL params

| Param | What | Example |
|---|---|---|
| `v` | Viewport (lat, lng, zoom, pitch, bearing) | `40.7177 -74.0695 12.8 54 -10` |
| `y` | Tax year | `2025` |
| `agg` | Aggregation: `ward`, `census-block`, `block`, `lot`, `unit` | `block` |
| `metric` | Metric: `per_sqft`, `per_capita` (wards/census blocks only) | `per_sqft` |
| `scale` | Color scale: `log`, `sqrt`, `linear` | `log` |
| `mh` | Max extrusion height (meters) | `4500` |
| `sel` | Selected parcel ID | `11303-00012` |
| `c` | Custom color stops (theme-specific) | encoded gradient |
| `wg` | Ward geometry: `merged`, `blocks`, `lots`, `boundary` | `merged` |
| `wl` | Ward labels on/off | `1` |

[jc-taxes]: ../README.md
[jct.rbw.sh]: https://jct.rbw.sh/
[deck.gl]: https://deck.gl/
[maplibre-gl]: https://maplibre.org/
[use-kbd]: https://github.com/runsascoded/use-kbd
[use-prms]: https://github.com/runsascoded/use-prms
[vite-plugin-dvc]: https://github.com/runsascoded/vite-plugin-dvc
[DVC]: https://dvc.org/
