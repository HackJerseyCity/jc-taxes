# Homepage rework: landing page with copy + charts + map CTA

> Written by an EC2 session for a `www`-focused session to implement.
> Turns the site from "the whole thing is a fullscreen map" into a regular
> landing page (copy + aggregate charts) that links into the fullscreen map.

> **Status (2026-06-08):** Phases **1–2 are done** (on the EC2 box, where the
> ~1.4GB of source zips live). The all-Hudson parquets are re-DVC-tracked +
> pushed to R2, and the three aggregate JSON files are committed at
> `www/public/data/modiv_{tax_base,class_composition,exempt_share}.json`.
> A laptop session can start at **Phase 3** (frontend) with **no large data
> pull** — the committed JSON is all the charts need.

## Goal

Today the entire site ([jct.rbw.sh]) is a single fullscreen 3D map (`www/src/App.tsx`),
showing **taxes *paid*** per parcel (from the HLS `data/payments.parquet` pipeline).

We've since parsed **NJ Treasury MOD-IV** data, which gives a different axis the
map doesn't surface and which is *better as charts than as a 3D map*:
**assessed value (the tax base) + property classification**, for all of Hudson
County, 2021–2025.

Rework `/` into a scrollable landing page:
- Hero + intro copy
- 3–4 aggregate charts (tax base over time, class composition, exempt share, JC-vs-Hudson)
- A prominent **"Explore the map →"** CTA into the current fullscreen view (moved to `/map`)

## Data we have (ground truth — sanity-check against these)

Parsed Treasury MOD-IV, **JC only (MUN 0906)** today, at
`data/modiv/treasury/{2021..2025}.parquet` (DVC-tracked). Schema includes
`county_district`, `block/lot/qualifier`, `blq`, `property_class`,
`land_value`/`improvement_value`/`net_value` (dollars, int), `last_year_tax`,
`property_use_code`, `year_constructed`, `old_property_id`, etc. See
[`src/jc_taxes/modiv.py`] (`MODIV_FIELDS`).

**JC net assessed value (tax base), $B:**

| Year | Parcels | Net | Land | Improvements |
|------|--------:|----:|-----:|-------------:|
| 2021 | 63,341 | 57.6 | 20.8 | 37.5 |
| 2022 | 63,944 | 58.8 | 21.1 | 38.4 |
| 2023 | 64,068 | 61.4 | 22.8 | 39.2 |
| 2024 | 64,294 | 62.8 | 23.6 | 39.6 |
| 2025 | 64,885 | 64.1 | 23.6 | 40.8 |

→ **+11.3%** over 4 years; ~1,500 net new parcels (JC's construction boom).

**JC 2025 net value by property class** (NJ codes: 1=vacant, 2=residential,
4A=commercial, 4B=industrial, 4C=apartment, 15A–F=exempt):

| Class | Parcels | Net $B | Share |
|-------|--------:|-------:|------:|
| 2 (residential) | 42,138 | 20.3 | 31.7% |
| 4A (commercial) | 4,617 | 15.1 | 23.6% |
| 15F (exempt) | 7,299 | 8.0 | 12.5% |
| 4C (apartment) | 1,771 | 6.6 | 10.4% |
| 15C (exempt) | 973 | 6.3 | 9.8% |
| 1 (vacant) | 6,812 | 2.6 | 4.1% |
| 4B (industrial) | 446 | 2.3 | 3.6% |

→ **Exempt (class 15*) = 26.6% of all assessed value ($17.0B)** — a headline stat.
Residential is 65% of parcels but only 32% of value.

**Hudson County is one filter away.** The Treasury extracts (`data/modiv/treasury/modiv-{year}.zip`,
DVC-tracked; member `HudsonRE.txt`) contain **all 12 Hudson municipalities** — we just
filter to 0906 today. 2025 record counts:

| Code | Municipality | Records |
|------|--------------|--------:|
| 0901 | Bayonne | 13,986 |
| 0902 | East Newark | 421 |
| 0903 | Guttenberg | 2,796 |
| 0904 | Harrison | 2,797 |
| 0905 | Hoboken | 19,668 |
| 0906 | Jersey City | 64,885 |
| 0907 | Kearny | 8,676 |
| 0908 | North Bergen | 12,712 |
| 0909 | Secaucus | 5,623 |
| 0910 | Union City | 9,640 |
| 0911 | Weehawken | 3,844 |
| 0912 | West New York | 8,994 |
|      | **total** | **154,042** |

## Phase 1 — Data: parse Hudson-wide

`jct modiv parse` currently defaults `-m/--mun 0906` and writes JC-only parquets.
Change it to parse **all districts present in the file** and keep `county_district`
in the output (already a column); JC-only consumers filter `county_district == "0906"`.

- Make `-m/--mun` accept `all` (default) or a comma-separated list of codes.
- Re-generate `data/modiv/treasury/{year}.parquet` with all 12 muns and re-`dvc add`
  (the `.dvc` sidecars + DVC remote update; ~150k rows/yr vs ~65k today).
- Verify `jct modiv crossval` / `blq-history` still work (they should filter to 0906,
  or be parameterized by muni). Re-run and confirm JC numbers are unchanged.

**Constraints:** Do **not** commit `*.parquet` directly — DVC-track them
(remote is now R2; see [`specs/done/modiv-etl-and-r2-migration.md`]). Do not commit credentials.

## Phase 2 — Data: tiny aggregate datasets for the charts

Add `jct modiv aggregate` (or extend `parse`) to emit small per-(year, muni) rollups
that the frontend loads directly. All are tiny (≤ a few KB):

1. **`tax_base_by_year_muni`** — `(year, mun_code, mun_name, parcels, net_value, land_value, improvement_value)`. 12 munis × 5 years = 60 rows.
2. **`class_composition_by_year_muni`** — `(year, mun_code, class_group, parcels, net_value)` where `class_group` ∈ {residential, commercial, apartment, industrial, vacant, exempt, other} (map raw `property_class` → group; document the mapping).
3. **`exempt_share_by_year_muni`** — derived (exempt net_value / total), or compute in FE from #2.

**Output location/format — recommended:** write these as **committed JSON** to
`www/public/data/*.json` (a few KB each, derived-not-source, FE-loaded). This keeps
the homepage's data **independent of S3/R2** (see prod caveat below). The "don't commit
parquet" rule is about the large per-parcel files; these tiny rollups are config-sized.
*(Alternative: DVC-track + `vite-plugin-dvc`-resolve like the geojson — but that re-couples
the homepage to the S3 bucket for no real benefit at this size.)* Pick one; recommend committed JSON.

## Phase 3 — Frontend: routing split + charts

`www/` is Vite + React + TS; today `App.tsx` (~66KB) is the only view. No router, no
chart lib yet (only deck.gl + custom canvas in `DistributionChart.tsx`/`GradientEditor.tsx`).

1. **Routing.** Add `react-router`. `/` = new `Home` landing page; move current map to
   `/map` (rename `App.tsx` → `MapView.tsx`, mount under `/map`).
   - **Back-compat:** existing deep links carry map query params (the map uses `use-prms`).
     If `/` is hit *with* known map params, redirect to `/map` preserving the query string,
     so old `jct.rbw.sh/?...` links keep working. Confirm the param set with the current
     `use-prms` usage in `App.tsx`.
2. **Chart library.** Recommend **Observable Plot** (`@observablehq/plot`) — small API,
   strong defaults, easy line/stacked-area/bar; wrap each chart in a React component that
   re-renders on theme change. *(Alt: Recharts if you want pure-React/JSX charts; visx if
   you need full control. Per global prefs, use [@floating-ui/react] for any tooltips, not
   native.)* Default to a unique dev port already set (3201) — no change.
3. **Components** (each reads the Phase-2 JSON):
   - `TaxBaseChart` — stacked area (land vs improvements) over 2021–2025; muni selector (default JC).
   - `ClassCompositionChart` — stacked bar / 100%-stacked by `class_group` for a chosen year+muni.
   - `ExemptShareChart` — exempt share over time, JC vs Hudson average (or small-multiples).
   - `MuniCompareChart` — bar of 2025 net_value (or per-parcel avg) across the 12 munis, JC highlighted.
   - Stat callouts: "$17B (26.6%) of JC value is tax-exempt", "+11.3% tax base since 2021",
     "JC = 42% of all Hudson County assessed value".
4. **Theming:** reuse the existing `ThemeContext` (LM/DM); charts must read theme colors.
5. **CTA:** prominent "Explore the map →" linking to `/map` (and keep the map's SpeedDial /
   `use-kbd` shortcuts on the map view only).

## Phase 4 — Copy (draft; edit freely)

> **Jersey City pays the most property tax in Hudson County — by far.**
> This site maps every parcel's tax bill in 3D. Below: where the city's
> $64B assessed value actually sits, how it's grown, and how JC stacks up
> against its 11 Hudson County neighbors.

Short sections framing each chart (tax base growth; residential vs commercial vs
exempt; the exempt quarter; JC vs Hudson). Keep it tight; let the charts carry it.

## Prod / deploy caveat (important)

The live site fetches geojson from **public S3** (`https://jc-taxes.s3.amazonaws.com/...`).
`vite-plugin-dvc`'s `s3ToHttps()` derives the URL from a remote's `url` field and
**ignores `endpointurl`**, so the recent DVC S3→R2 default-remote flip does **not**
change the site's URLs (both remote sections share `url = s3://jc-taxes/...`). Verified: 200 OK.

Two consequences for this work:
- Keeping the Phase-2 aggregates as **committed JSON** avoids adding any new S3/R2
  dependency for the homepage.
- The MOD-IV spec's step 7 ("retire S3 after a few weeks") would **break the live map**
  as-is, since the map still pulls from `jc-taxes.s3.amazonaws.com`. Before retiring S3,
  either teach `vite-plugin-dvc` to emit a public R2 URL (`baseUrl` option / public
  `r2.dev` or custom domain) or keep S3 as the public web origin. Out of scope here, but
  do not let an S3 retirement land without addressing it.

## Honest caveats

- MOD-IV data is **2021–2025** only; the map's paid-tax data covers 2015–2025.
- `net_value` is **assessed value**, not market value or tax paid; the MOD-IV
  `last_year_tax` is **billed**, not collected (the ~15–20% Treasury-vs-HLS crossval
  gap is largely PILOT/abated properties — a JC-specific quirk worth a footnote).
- Assessment practices differ per muni (revaluation timing), so cross-muni
  *level* comparisons deserve a caveat; *trends* and *composition* are safer.

## Done criteria

- `/` is a styled landing page with copy + the charts above; `/map` is the current
  fullscreen experience; old deep links still resolve.
- Charts driven by committed `www/public/data/*.json` from `jct modiv aggregate`.
- Hudson-wide parse landed (all-muni parquets re-DVC-tracked); JC numbers unchanged.
- Playwright e2e (`www/e2e/`) updated for the new route split; `pnpm build` green.
- On completion, move this spec to `specs/done/` with an implementation report
  (final chart list, chart lib chosen, any data surprises), per the usual workflow.

[jct.rbw.sh]: https://jct.rbw.sh
[`src/jc_taxes/modiv.py`]: ../src/jc_taxes/modiv.py
[`specs/done/modiv-etl-and-r2-migration.md`]: done/modiv-etl-and-r2-migration.md
[@floating-ui/react]: https://floating-ui.com/docs/react

---

## Implementation report (2026-06-08, laptop session)

**Phase 3 landed** (Phases 1-2 had been completed on `e` and pulled in via `git pull h main`).

**Routing:** `react-router-dom@v7` with `BrowserRouter`. `/` = `Home`, `/map` = `MapView` (renamed
from `App.tsx`). `App.tsx` is now the top-level router shell; `HomeOrRedirect` inspects
`useLocation().search` against a 17-element `MAP_PARAMS` allowlist (the params currently
consumed by the map via `use-prms` — `v/agg/y/animYr/3d/metric/mh/pct/scale/sel/so/sp/ti/wg/wl/cb` plus `sp`).
If any are present, `<Navigate>` rewrites to `/map?…` preserving the full search string.

**GH Pages SPA fallback:** Added a small `ghPagesSpaFallback()` plugin to `vite.config.ts` that
copies `dist/index.html` → `dist/404.html` in `closeBundle`. Direct visits to `/map` (or
anything else) hit `404.html`, serve the same SPA bundle, and the router takes over client-side.
Verified after `pnpm build`.

**Charts:** `@observablehq/plot` via a shared `PlotChart` React wrapper that re-renders on
theme change AND container resize (ResizeObserver). Four chart components under
`www/src/charts/`:

- `TaxBaseChart.tsx` — stacked-area Land vs Improvements over 2021-2025 (JC default)
- `ClassCompositionChart.tsx` — stacked bars by `class_group` (residential/commercial/apartment/industrial/exempt/vacant/other)
- `ExemptShareChart.tsx` — line, JC vs (totals-weighted) Hudson average exempt share
- `MuniCompareChart.tsx` — horizontal bar, all 12 munis sorted by 2025 net value, JC highlighted

A shared `palette(theme)` in `PlotChart.tsx` keeps chart colors consistent across the suite
in both light and dark mode; chart components read it inside their `build` callback so
theme flips are instant. Tooltips use Plot's built-in `tip: true` (faster to ship than
@floating-ui — happy to revisit if you want consistent styling with the map's hover boxes).

**Home page:** `Home.tsx` is a single scrollable column with hero + 3 stat callouts
(`$64.1B`, `26.6%`, `~42%`) + 4 sections (one per chart, each with a one-paragraph blurb) +
a footer with data attribution and caveat copy lifted from the spec's Phase 4 draft.

**CSS:** Added a `.home` block to `index.css`. The pre-existing root rule
`html, body, #root { height: 100%; overflow: hidden; }` was the map's
fullscreen lock — kept it (so the map still locks scroll) and made `.home` itself
the scroll container (`overflow-y: auto`). Reused the existing `--text-primary`,
`--text-secondary`, `--panel-bg`, `--border` CSS variables so theme switching
on the home page just works.

**e2e:** Rewrote all `page.goto('/')` calls in `www/e2e/app.spec.ts` to `/map`
(20 sites). Added a `Routing` describe-block with 3 tests: bare `/` shows the
landing page, `/?agg=lot&y=2024` redirects to `/map?agg=lot&y=2024` (params
preserved), and the CTA link click navigates to `/map`. Suite: **23 passed,
0 failed (10.2s)**. `pnpm build`: green.

**Prod-deploy caveat unchanged:** `vite-plugin-dvc` still emits public S3 URLs.
The MOD-IV spec's "retire S3 after a few weeks" step is still gated on either
teaching the plugin a public R2 URL OR keeping S3 as the public web origin —
this homepage rework didn't touch that.

**Files changed**
- new: `www/src/App.tsx`, `www/src/Home.tsx`, `www/src/charts/{PlotChart,TaxBaseChart,ClassCompositionChart,ExemptShareChart,MuniCompareChart}.tsx`
- renamed: `www/src/App.tsx` → `www/src/MapView.tsx` (only the exported function name changed)
- modified: `www/src/main.tsx` (unchanged actually — still mounts `<App />`),
  `www/src/index.css` (+`.home` block, root rules unchanged),
  `www/vite.config.ts` (+`ghPagesSpaFallback()` plugin),
  `www/e2e/app.spec.ts` (paths → `/map`, +Routing describe),
  `www/package.json` + `www/pnpm-lock.yaml` (+react-router-dom, +@observablehq/plot)
