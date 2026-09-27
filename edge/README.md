# `jct-edge`: Worker + Static Assets origin

This Worker serves the built map SPA (`../www/dist`) and adds per-URL Open Graph previews at the edge. Social crawlers don't run JS, so a query-string-specific preview (`?pf=`, `?agg=`, `?mt=`, `?y=`) needs the Worker to rewrite the HTML shell.

| Path | What it does |
|---|---|
| `/`, `/about`, `/files/*`, `/index.html` | SPA shell, with `<title>`, `og:*` and `twitter:*` tags rewritten per query (HTMLRewriter) |
| `/og?agg=&mt=&y=[&w=]` / `/og?pf=&y=` `[&layout=a\|b\|c\|d]` | 1200×630 PNG card (satori + resvg-wasm), cached in R2 by content hash. Totals + sparkline from the D1 `aggregates`; layouts `b`–`d` embed a pre-rendered map (`jct-og` bucket `maps/<view>-WxH.jpg`, e.g. `citywide`, `ward-e`, `<portfolio key>`; falls back to `citywide`) |
| `/og/review` | Side-by-side comparison of card layouts for a few views |
| `/api/portfolios` | Curated portfolios as JSON (D1 if bound, else R2 `portfolios.json`) |
| `/d/files/md5/…` | DVC-cached map data from the `jc-taxes` bucket (read-only binding), as compressed JSON with immutable edge caching; the SPA is built with `VITE_DVC_BASE_URL=/d` |
| everything else | Static assets (SPA fallback serves `index.html` with the default tags) |

The test deploy is at <https://jct-edge.ryan-0dc.workers.dev> (`workers_dev: true`, no custom domain).

## Data (kept out of git)

The `jct-og` R2 bucket is separate from the production `jc-taxes` bucket and holds:
- `stats.json`: per-view (agg×year) and per-portfolio `count`/`paid`, written by `python -m jc_taxes.cli stats -u` (~11 KB; the edge never parses the 20–40 MB GeoJSONs).
- `portfolios.json`: a mirror of the DVC-tracked `www/public/portfolios.json`, used as the `/api/portfolios` fallback and for validating `?pf=`.
- `cards/<CARD_VERSION>/<stats-generated>/<view>-<year>.png`: rendered cards. The key embeds the stats generation time, so regenerating stats yields fresh cards without a purge. Bump `CARD_VERSION` in `src/worker.ts` when the layout changes.

To refresh after a data change:
```bash
python -m jc_taxes.cli stats -u -p www/public/portfolios.json
npx wrangler r2 object put jct-og/portfolios.json --file ../www/public/portfolios.json --content-type application/json --remote
```

## Dev / deploy

```bash
pnpm install          # postinstall extracts satori's Yoga wasm → generated/yoga.wasm
pnpm dev              # wrangler dev on :3205 (R2 binding is remote → real jct-og bucket)
(cd ../www && VITE_DVC_BASE_URL=/d pnpm build)
pnpm run deploy
```

Two Workers constraints drive the wasm setup in `src/og/card.ts`:
- Workers can't compile wasm from bytes at runtime, so the code uses `satori/standalone` and wrangler-precompiled modules.
- The `yoga.wasm` that satori publishes is corrupt (UTF-8-mangled), so `scripts/extract-yoga.mjs` recovers it from the base64 inlined in satori's default build.

## Verify

```bash
U=https://jct-edge.ryan-0dc.workers.dev
curl -s -A "facebookexternalhit/1.1" "$U/?pf=newport" | grep -E 'og:|twitter:'
curl -s -A "Twitterbot/1.0" "$U/?agg=lot&mt=total&y=2021" | grep -E 'og:(title|description|image")'
curl -s -o card.png -w '%{http_code} %{content_type} x-og=%header{x-og-cache}\n' "$U/og?agg=block&mt=per_sqft&y=2025"   # MISS, then HIT
curl -s "$U/api/portfolios" | jq '.source, (.portfolios | length)'
```

## D1

Database `jct` (bound as `DB`) holds app data that shouldn't live in git: currently the `portfolios` table (`d1/schema.sql`). Re-seed after editing the DVC-tracked `portfolios.json`:
```bash
node scripts/seed-portfolios.mjs ../www/public/portfolios.json   # applies d1/schema.sql + upserts; full replace
curl -s "$U/api/portfolios" | jq .source        # → "d1"
```
The seed script also accepts a URL. Keys missing from the JSON are deleted.

## Production

`jct.rbw.sh` is a Workers custom domain on `jct-edge` (cut over from GitHub Pages on 2026-09-27; Pages is unpublished). CI (`.github/workflows/deploy.yml`) builds `www` with `VITE_DVC_BASE_URL=/d`, runs the e2e suite, and on `main` runs `wrangler deploy` here (repo secret `CLOUDFLARE_API_TOKEN`).

Rollback: remove the custom domain from the Worker, recreate `CNAME jct → runsascoded.github.io` (DNS only), and re-publish Pages.
