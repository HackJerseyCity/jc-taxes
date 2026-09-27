# Default `og:image`: 3D lot map for the bare homepage

## Problem

The edge Worker (`edge/src/worker.ts`) rewrites `og:image` on every HTML response to the dynamic Satori stats card: `/og?${canonicalQuery(params)}`. `normalizeParams` fills in defaults, so bare `https://jct.rbw.sh/` unfurls as `/og?agg=block&mt=per_sqft&y=2025`. That's a text card: "Jersey City Property Taxes · Paid per sq ft · by block · **$1.23B** paid · 2025 · 1,256 blocks".

The bare homepage is the most-shared URL (e.g. hccs.dev's link-tree, social posts). The static `www/public/og-lot.jpg` (3D per-lot extrusion over the JC basemap) is a far more striking hero. `www/index.html` already names it as the `og:image`, but the Worker overwrites that tag for every request. [hccs.dev] uses `og-lot.jpg` for its jct card for this reason.

## Change

In `edge/src/worker.ts`, when the request has **no view-affecting params** (no `agg`, `mt`/metric, `y`, `pf`, or whatever else `normalizeParams` reads), set:

- `imageUrl: ${url.origin}/og-lot.jpg`
- `og:image:alt`: a description of the map, e.g. "3D map of Jersey City property taxes paid per sq ft, by lot, 2025"

Keep the dynamic stats cards for any explicit view (`?agg=ward`, `?pf=<portfolio>`, `?y=2019`, …). Those cards describe that specific view, and portfolio cards especially are only meaningful dynamically.

Unlike hbt, key this off **"no params present"**, not "params equal defaults". The static hero is a lot-level map, but the app's default `agg` is `block`. So an explicit `?agg=block&mt=per_sqft&y=2025` share should still get the accurate stats card, and only the bare URL gets the showcase image.

`rewriteOg` (`edge/src/rewrite.ts`) currently derives `og:image:alt` from `title`. It needs an optional `imageAlt` override, or the caller can pass it in.

## Also

- Check `og-lot.jpg` is current (tax year 2025, current color gradient/UI). It's generated via `www/scrns.config.ts` `'og-lot'`. Note the scrns entry writes `og-lot.png`. Confirm how the `.jpg` is produced (`sips -s format jpeg -s formatOptions 85`?) and document it in the scrns config or README so regeneration is one command.
- The capture includes the Settings panel and a selected-lot tooltip. Consider a clean mode for the OG capture (no Settings panel), like hbt's `?clean`. Optional; the current image already reads well.
- Consider serving it at `/og.jpg` per the usual convention, keeping `og-lot.jpg` as-is for existing links. `www/public/og.jpg` already exists, so first check what it is and whether it's stale. Low priority.
- Cache-busting: static assets have no version param. Optionally append `?v=<deploy id>` when regenerating.

## Verify

- `curl -s https://jct.rbw.sh/ | grep 'og:image"'` → `https://jct.rbw.sh/og-lot.jpg`
- `curl -s 'https://jct.rbw.sh/?agg=ward' | grep 'og:image"'` → `/og?agg=ward&…` (dynamic, unchanged)
- Portfolio URL (`?pf=…`) → dynamic portfolio card (unchanged)

[hccs.dev]: https://hccs.dev
