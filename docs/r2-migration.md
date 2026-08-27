# S3 → R2 migration (public data on Cloudflare R2)

Goal: serve the map's public data (the DVC cache) from **Cloudflare R2** instead of AWS S3, for **zero egress cost**. Then decommission the S3 bucket, and stand up a browsable file tree of the data.

## Status

- ✅ **Data already fully on R2** — the `jc-taxes` R2 bucket holds the whole DVC cache (70,277 objects / 2.86 GB; all geojsons + NJGIN + county). Nothing to copy.
- ✅ **CORS applied** to the R2 bucket (`docs/r2-cors.json`: `GET`/`HEAD` from `jct.rbw.sh` + localhost, Range headers exposed).
- ✅ **App is R2-ready** — `www/vite.config.ts` reads `VITE_DVC_BASE_URL`; unset keeps today's S3 behavior, so nothing breaks until we flip it.
- ✅ **`rbw.sh` on Cloudflare** — zone Active; all 21 records imported DNS-only (Steps 1–2).
- ✅ **`data.jct.rbw.sh` live** — R2 custom domain connected + TLS active; verified 200 + CORS + range (Step 3).
- ✅ **Prod cut over to R2** — `VITE_DVC_BASE_URL` set in `deploy.yml`; deployed bundle has 55 R2 URLs / 0 S3; live map renders from R2 (Step 4, commit `a1fb234`).
- ✅ **File-tree browser live** — `jct r2 publish` copies a friendly `data/` tree into R2; the `jct-files` Worker (`files/`) serves `@rdub/file-tree` at **`jct-files.rbw.sh`** (Step 6).
- ⏳ **Soak, then Step 5** — S3 kept as passive fallback; decommission after soak.

## Why R2

AWS S3 charges ~$0.09/GB egress. A 37 MB units-geojson × many map loads adds up if the map gets traffic (it's being cited in press). R2 egress is **free**; storage is comparable. One provider (you already use R2 for ctbk.dev, nj-crashes.com).

---

## Step 1 — Add `rbw.sh` to Cloudflare *(you)*

1. Cloudflare dashboard → **Add a site** → `rbw.sh` → Free plan.
2. CF scans existing DNS. **Verify these imported** (add any missing) before switching nameservers — otherwise mail/site break:
   | Type | Name | Value | Notes |
   |---|---|---|---|
   | MX | `rbw.sh` | `eforward1.registrar-servers.com` (prio 10) | Namecheap email fwd |
   | MX | `rbw.sh` | `eforward2` (10), `eforward3` (10), `eforward4` (15), `eforward5` (20) | " |
   | TXT | `rbw.sh` | `v=spf1 include:spf.efwd.registrar-servers.com ~all` | SPF |
   | CNAME | `jct` | `runsascoded.github.io` | the live map — set **DNS only (grey cloud)** |
   - `jct` grey-cloud (DNS only) avoids GitHub-Pages-vs-CF-proxy TLS/redirect issues. (If you want it proxied later, set SSL mode **Full**.)
   - Apex (`rbw.sh`) and `www` have no records today — leave them out.

## Step 2 — Switch nameservers at Namecheap *(you)*

Namecheap → Domain List → `rbw.sh` → Nameservers → **Custom DNS** → the two `*.ns.cloudflare.com` hostnames CF assigned in Step 1. Save. Activation takes minutes–hours; CF emails when the zone is Active.

## Step 3 — Attach the R2 custom domain *(you)*

CF dashboard → **R2** → `jc-taxes` bucket → **Settings** → **Public access** → **Custom Domains** → **Connect Domain** → `data.jct.rbw.sh`. CF auto-creates the proxied CNAME + TLS cert. (This is what makes the bucket publicly readable — the bucket stays private except through this hostname.)

Verify:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://data.jct.rbw.sh/.dvc/cache/files/md5/da/63018b1e818870b8433b271ff34605
# → 200 (this is taxes-2025-blocks.geojson)
```

---

## Step 4 — Cut prod over to R2 *(me, once Step 3 verifies)*

Set `VITE_DVC_BASE_URL=https://data.jct.rbw.sh/.dvc/cache` in the GH Actions deploy workflow (`.github/workflows/deploy.yml`), redeploy, then confirm in the browser network tab that geojson requests hit `data.jct.rbw.sh` (not `*.s3.amazonaws.com`) and CORS passes.

## Step 5 — Decommission S3 *(me, after a soak)*

Once R2 is confirmed serving all 55 geojsons: stop pushing to the `s3` remote (drop it from `.dvc/config` or make `r2` the only remote), then delete the AWS `jc-taxes` bucket after a grace period.

## Step 6 — Friendly data tree + file-tree browser ✅

The R2 bucket is content-addressed (`.dvc/cache/files/md5/…`) — useless to browse directly, and `@rdub/file-tree` lists raw keys (no name remapping). So:

- **`jct r2 publish`** (`src/jc_taxes/r2.py`) publishes a friendly `data/` tree. DVC-tracked artifacts (already in R2) are server-side-copied (no egress): 55 yearly geojsons → `data/geojson/<year>/<name>`, 5 MOD-IV parquets → `data/modiv/<year>.parquet`. Local/gitignored artifacts are uploaded from disk: the HLS tax-record parquets → `data/records/` (`payments`, `taxes`, `taxrecords_enriched`) and census → `data/census/`. Idempotent (size-match skip). Instantly browsable at clean URLs, e.g. `https://data.jct.rbw.sh/data/records/taxrecords_enriched.parquet`. All published data is NJ public record (same fields the map surfaces).
- **`files/`** is a combined Cloudflare Worker (`jct-files`): serves the `@rdub/file-tree` UI (Vite build, `[assets]`) *and* the `/api/files/*` R2 protocol via `R2Store(env.R2, { prefixes: ['data/'], publicBaseUrl: 'https://data.jct.rbw.sh' })`. Downloads go direct from R2 (public custom domain), list/get proxy through the Worker (powers in-browser parquet/geojson rendering). Deployed with an account-scoped API token (`CLOUDFLARE_API_TOKEN`); the `jct-files.rbw.sh` custom domain is attached in the dashboard (kept out of `wrangler.jsonc`, ctbk pattern).

**Why `jct-files.rbw.sh` (1-level) and not `files.jct.rbw.sh`:** a Workers custom domain on a 2-level subdomain needs an Advanced cert (paid ACM) — the free Universal cert only covers `*.rbw.sh`, so the 2-level cert sits in "Pending Validation (Error)". (`data.jct.rbw.sh` works at 2 levels only because **R2** custom domains use a separate free per-hostname cert path that Workers domains don't share.) A 1-level host is covered by the active Universal cert → instant HTTPS, no cost.

Re-run `jct r2 publish` whenever the tracked data changes; `cd files && pnpm deploy` (with the token in env) to redeploy the browser.

## Rollback

Unset `VITE_DVC_BASE_URL` and redeploy → instantly back to S3 (kept until Step 5).
