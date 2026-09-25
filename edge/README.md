# `jct-edge`: Worker + Static Assets origin

This Worker serves the built map SPA (`../www/dist`) and adds per-URL Open Graph previews at the edge. Social crawlers don't run JS, so a query-string-specific preview (`?pf=`, `?agg=`, `?mt=`, `?y=`) needs the Worker to rewrite the HTML shell.

| Path | What it does |
|---|---|
| `/`, `/about`, `/files/*`, `/index.html` | SPA shell, with `<title>`, `og:*` and `twitter:*` tags rewritten per query (HTMLRewriter) |
| `/og?agg=&mt=&y=` / `/og?pf=&y=` | 1200×630 PNG stats card (satori + resvg-wasm), cached in R2 |
| `/api/portfolios` | Curated portfolios as JSON (D1 if bound, else R2 `portfolios.json`) |
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
(cd ../www && VITE_DVC_BASE_URL=https://data.jct.rbw.sh/.dvc/cache pnpm build)
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

## D1 (groundwork, not yet provisioned)

The current `CLOUDFLARE_API_TOKEN` lacks D1 permissions (`wrangler d1 list` → auth error 10000). Once D1:Edit is added to the token:
```bash
npx wrangler d1 create jct                      # note database_id
# uncomment `d1_databases` in wrangler.jsonc with that id
node scripts/seed-portfolios.mjs ../www/public/portfolios.json   # applies d1/schema.sql + upserts (reads the JSON at seed time; nothing committed)
pnpm run deploy
curl -s "$U/api/portfolios" | jq .source        # → "d1"
```
The seed script also accepts a URL. It fully replaces the table: keys missing from the JSON are deleted.

## Production cutover (manual)

`jct.rbw.sh` is currently a DNS-only `CNAME jct → runsascoded.github.io` (GitHub Pages). It's a 1-level subdomain of `rbw.sh`, so the free Universal cert covers it and no ACM is needed.

1. **Allow the prod origin for geojson** (already done: the `jc-taxes` bucket CORS allows `https://jct.rbw.sh`). For the *test* origin to load map data, also add `https://jct-edge.ryan-0dc.workers.dev` to that bucket's CORS `allowed_origins`.
2. Build `www` from `main` and run `pnpm run deploy` here. Then smoke-test the workers.dev URL.
3. In CF dashboard → DNS for `rbw.sh`, **delete** the `jct` CNAME → `runsascoded.github.io`.
4. Workers & Pages → `jct-edge` → Settings → Domains & Routes → **Add Custom Domain** `jct.rbw.sh`. CF creates the proxied record and the edge cert (usually within a minute or two). CLI alternative: add `"routes": [{ "pattern": "jct.rbw.sh", "custom_domain": true }]` and redeploy.
5. Verify: `curl -sI https://jct.rbw.sh/ | grep -i server` → `cloudflare`, then re-run the checks above against `https://jct.rbw.sh`. The `og:image` URLs switch automatically, since they derive from the request origin.
6. GitHub repo → Settings → Pages: remove the custom domain, or disable Pages / the `deploy.yml` deploy job. Otherwise GH keeps expecting `jct.rbw.sh`.
7. Optional: set up CI to `wrangler deploy` on push (replacing the Pages deploy job), and pre-warm the social caches with the Facebook Sharing Debugger / LinkedIn Post Inspector.

Rollback: remove the custom domain from the Worker and recreate `CNAME jct → runsascoded.github.io` (DNS only).
