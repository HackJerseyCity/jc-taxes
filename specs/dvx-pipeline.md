# DVX-native pipeline: provenance for every stage

## Problem

Only the 2015–2025 per-year GeoJSONs recorded provenance, and only a `cmd` (no `deps`), so `dvx status` couldn't say what was stale. Intermediates in `data/` (`payments.parquet`, `taxrecords_enriched.parquet`, …) were untracked; the D1 loads, R2 uploads and OG captures were ad-hoc commands run in a remembered order. The HLS re-pull (2026-09-26) even left `data/cache.dvc` stale: `payments.parquet` was built from cache files no `.dvc` recorded.

## Design (implemented)

`src/jc_taxes/pipeline.py` declares every stage with DVX's Python API (`dvx.run.artifact.Artifact` / `Computation`, as ctbk does); `jct pipeline write` (re)writes each stage's `.dvc` `meta.computation`: `cmd`, `deps` (md5s of data inputs), `git_deps` (blob / tree SHAs of the code that runs). Outputs' recorded hashes are kept.

| stage | cmd | deps | outs |
|---|---|---|---|
| packed HLS records | `jct hls pack` | `data/cache` | `data/hls/JerseyCity.parquet` (account + raw JSON, sorted, zstd) |
| payments | `python -m jc_taxes.payments` | packed records | `data/payments.parquet` |
| combine | `jct parcels combine -c <county>` | county GeoJSON, `legacy_combined.parquet`, payments | `data/jc_parcels_combined.parquet` |
| per-year GeoJSON (12 years × 5 views) | `python -m jc_taxes.geojson_yearly -y Y -a V -o www/public` | combined parcels, payments, `taxrecords_enriched.parquet`, packed records (owners, addresses), TIGER water; code + `census/` | `www/public/taxes-Y-V.geojson` |
| bundle (co-outputs, one cmd) | `jct bundle -n` | that view's 12 GeoJSONs | `geom-*`, `values-*`, `ward-shapes-*`, `data/d1/parcels.sql` |
| aggregates | `jct aggregates -n` | all 60 GeoJSONs, `portfolios.json` | `data/d1/aggregates.sql` |
| portfolios | `jct d1 portfolios` | `portfolios.json` | `data/d1/portfolios.sql` |
| R2 brotli copies (side effect) | `jct r2 precompress` | bundle outputs | `deploy/r2-br.dvc` |
| D1 dev (side effect) | `jct d1 load -d jct-dev` | the 3 SQL files; migrations | `deploy/dev/d1.dvc` |
| D1 prod promote (side effect) | `jct d1 load -d jct` | same | `deploy/prod/d1.dvc` |

- The generated D1 SQL is DVX-tracked (R2 cache, not git): it embeds portfolio membership and owner history. A promote replays the same files into prod, so prod gets byte-identical data to what was checked on dev; `deploy/prod/d1.dvc`'s dep hashes record what prod has.
- `jct d1 load` applies `edge/d1/migrations` first, then executes `parcels.sql`, `aggregates.sql`, `portfolios.sql`. It replaces `edge/scripts/seed-portfolios.mjs` (same SQL, now a tracked output).
- External inputs are tracked leaves (no computation); refresh commands:
  - HLS cache (`data/cache`, ~17 h): `jct fetch -m JerseyCity -t 7d data/accounts_index.parquet`, then `dvx add data/cache`
  - county parcels: `jct parcels fetch` (new snapshot-named file; bump `COUNTY` in `pipeline.py`)
  - `taxrecords_enriched.parquet`, `legacy_combined.parquet`, TIGER water zip: static snapshots

## Usage

Pipeline stages run in AWS Batch (RAC account, prefix `jct`; `batch/setup`), not on a laptop: inputs come from, and outputs go to, the R2 DVC remote.

```bash
dvx status                                              # what's stale, and why
AWS_PROFILE=r dvx batch submit -P jct -e REF=$(git rev-parse HEAD) -w <target.dvc…>  # rebuild stale targets in Batch, at a pushed rev
# the job log ends with the `.dvc` diff (between `--- dvc diff ---` / `--- end ---`): `git apply` it
dvx run deploy/dev/d1.dvc       # load dev D1 (wrangler; small)
# check dev (jct-edge-dev), then:
dvx run deploy/prod/d1.dvc      # promote D1 to prod
```

The packed records exist because a Batch job pulling the ~70k-file `data/cache` dir spent 3+ h on per-object fetches without finishing (the one-time pack ran locally instead: 2 min, 2.3 GB peak RSS); downstream stages pull one 276 MB object instead. The pack also fixes record order (sorted by account): `geojson_yearly`'s first-record-wins address / owner lookups previously followed a filesystem-dependent glob order.

Until DVX has explicit-only stages (`~/c/dvx/specs/explicit-only-stages.md`), a bare `dvx run` would also run the prod promote: name targets.

## Remaining

- Move the HLS fetch into Batch, writing / refreshing the packed file directly (then `data/cache` can go).
- `REF` (entrypoint) runs a pushed rev without an image rebuild; rebuild only when the lockfile or `batch/` changes.
- Why is a Fargate pull of many small objects ≫10× slower than locally (~67 objects/s)? Likely serial per-object fetches in `dvx run`'s dep pull: DVX spec.
- Build the Batch image in CI (GHA → ECR via OIDC) instead of locally.
- Fold the re-pull's resilience (`tmp/hls-repull.sh`: truncated-gzip cleanup, stall watchdog, retries) into `jct fetch`, then make the HLS pull a scheduled fetch stage (`fetch.schedule: weekly`) for Batch.
- OG map captures (`www/scripts/og-maps.mjs`) depend on a deployed app, not files: keep as a manual step after a dev deploy.
- `payments.parquet` has stray far-future rows (2032–2035); filter at the `payments` stage.
