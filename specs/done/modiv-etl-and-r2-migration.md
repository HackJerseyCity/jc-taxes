# MOD-IV ETL + DVC remote S3 → R2 migration

> **Status: DONE** (implemented on `e`, 2026-06-07). Implementation report
> below; the original task spec follows unchanged.

## Implementation report

### New code (`src/jc_taxes/modiv.py` + `tests/test_modiv_parse.py`)

Three new `jct modiv` subcommands, plus the fixed-width field table and a
zoned-decimal decoder:

- `jct modiv parse` — `Hudson*re.txt` → `data/modiv/treasury/{year}.parquet`
- `jct modiv crossval` — Treasury-vs-HLS per-(BLQ, tax-year) comparison
- `jct modiv blq-history` — `old_property_id` → `data/modiv/blq_history.parquet`

7 unit tests cover the COBOL zoned-decimal/left-justified decoders and record
slicing; all pass.

### 1. Per-year parquets (`data/modiv/treasury/{year}.parquet`, DVC-tracked)

| year | JC rows (MUN=0906) | cols | size |
|------|-------------------:|-----:|-----:|
| 2021 | 63,341 | 27 | 3.0 MB |
| 2022 | 63,944 | 27 | 3.0 MB |
| 2023 | 64,068 | 27 | 3.0 MB |
| 2024 | 64,294 | 27 | 3.0 MB |
| 2025 | 64,885 | 27 | 3.0 MB |

Source files are statewide-Hudson (~151k–154k records each, all 12 munis
0901–0912); filtered to JC. Record count grows ~1.5k/yr as new lots appear.

### 2. Treasury-vs-HLS match rate

**The cross-validation key field is `last_year_tax`, NOT `current_year_tax`.**
`current_year_tax` (610–618) is **all zeros** in every JC record — the
assessment file ships before the tax rate is struck. `last_year_tax`
(601–609) holds the prior year's finalized tax, so **Treasury file-year Y
maps to HLS tax-year Y−1** (verified empirically: file-Y `last_year_tax`
matches `Billed[Y−1]` ~80–85% exact vs ~0% for `Billed[Y]`).

| tax-yr | common BLQ | exact | <$1 | >$10 | treasury-only | hls-only |
|-------:|-----------:|------:|----:|-----:|--------------:|---------:|
| 2020 | 51,867 | 81.5% | 0.7% | 17.7% | 11,474 | 2,768 |
| 2021 | 51,879 | 84.3% | 0.2% | 15.5% | 12,065 | 2,905 |
| 2022 | 52,195 | 80.0% | 0.1% | 19.9% | 11,873 | 2,998 |
| 2023 | 52,506 | 79.6% | 0.4% | 20.1% | 11,788 | 2,992 |
| 2024 | 52,597 | 80.0% | 0.2% | 19.8% | 12,288 | 3,598 |

Of the >$10 mismatches (2024: 10,410), **HLS `Billed` > Treasury in ~93%**
(9,694) — added/omitted assessments, mid-year improvements, and appeals that
HLS bills but the static assessment file doesn't carry. Notably Treasury
`last_year_tax` frequently equals HLS **`Paid`** exactly even when it differs
from HLS `Billed` (homeowner paid the base bill; the delta was billed later).
`treasury_only` rows are mostly exempt/public (2024: 9,004 of 12,288 have
`last_year_tax == 0`). Per-year detail in `tmp/modiv-vs-hls-{tax_year}.parquet`.

### 3. Old-property-ID analysis (`data/modiv/blq_history.parquet`)

`OLD-PROPERTY-ID` (522–550, X(29)) mirrors the `PROPERTY-ID` group:
BLOCK X(9) + LOT X(9) + QUALIFIER X(11).

| year | non-empty | rate | renumbered (old ≠ current) |
|------|----------:|-----:|---------------------------:|
| 2021 | 57,368 | 90.6% | 57,368 (100%) |
| 2022 | 57,106 | 89.3% | 57,106 (100%) |
| 2023 | 56,742 | 88.6% | 56,742 (100%) |
| 2024 | 56,394 | 87.7% | 56,394 (100%) |
| 2025 | 56,132 | 86.5% | 56,132 (100%) |

**Surprise:** wherever `old_property_id` is populated it *always* differs from
the current BLQ → JC underwent a **wholesale block renumbering**, not a few
scattered re-lottings. The non-empty rate declines each year as post-reblock
lots (no prior ID) accumulate. `blq_history.parquet` = 283,742
(year, current_blq, old_blq) tuples; 57,500 distinct renumbering pairs.

5 sample historical mappings (`current_blq <- old_blq`):
```
101-2-HM   <- 1000-104   C-HM
201-1-     <- 985-12-
201-2-     <- 985-11-
101-19-HM  <- 1000-110-HM
101-22-HM  <- 1000-107-HM
```

### 4. DVC remote S3 → R2 — DONE, default flipped

- Created R2 bucket `jc-taxes` in the existing **`cf`** account
  (`0dcad…r2.cloudflarestorage.com`). The spec assumed a fresh bucket + token;
  a working `cf` AWS profile already existed, so the remote uses
  `profile = cf` (committed to `.dvc/config`) instead of copying keys into
  `.dvc/config.local`. **No secrets committed.**
- Mirrored **everything** S3 → R2: 70,192 cache+zip+parquet blobs in the first
  push, then `dvc pull -r s3` fetched the 55 `www/public/taxes-*.geojson`
  outputs I hadn't pulled and a second push synced them. `dvc status -c -r r2`
  → "Cache and remote 'r2' are in sync."
- **Verified** from a fresh dir with an isolated cache: `dvc pull -r r2` of the
  parquets + `blq_history` succeeded and the pulled files are **byte-identical**
  (md5) to source.
- Flipped default: `.dvc/config` now `remote = r2`; `s3` kept as fallback.

### 5. Cleanup

- Deleted the 5 extracted `Hudson*re.txt` (~525 MB, regenerable via
  `jct modiv pull-treasury`). Zips + parquets + `modivlayout.pdf` kept.
- **Skipped** the aggressive `dvc gc -w -r r2 -c` — `e` has 43 GB free, so the
  marginal ~1.8 GB it would reclaim isn't worth the destructiveness. Run it
  there if/when disk gets tight (R2 now backs the cache).

### Other things that surprised me

- **Two encodings in adjacent money fields.** `current_year_tax` uses COBOL
  zoned-decimal overpunch (`00000000{` = +0), but `last_year_tax` is plain
  **left-justified ASCII**, right-space-padded (`9300450  `). The decoder
  handles both.
- **`last_year_tax ÷ 100 = dollars` confirmed** by `last_year_tax / net_value`
  reproducing JC's actual general tax rate per year: 2021 1.610%, 2022 1.604%,
  2023 2.118%, 2024 2.247%, 2025 2.233% — including the 2023 reval rate jump.
- `RECORD-ID` (34–35) is a constant `20` (not `01`); only 1 record differs.
- A few hundred Meadowlands (`HM`-qualifier) parcels have embedded spaces in
  their lot field (`00001  01`, old lot `00104   C`) — minor BLQ-join noise.
- **gitignore foot-gun:** the repo's root `.gitignore` re-includes data dirs
  via `!data/**/`, leaving the freshly-pulled `data/cache/` (70,180 files)
  *exposed* (not ignored). Added a DVC-style `data/.gitignore` (`/cache`) as a
  local guard — note it's itself ignored by `data/*`, so it can't be committed;
  it just prevents accidental `git add data/cache`. Worth a real fix in the
  root `.gitignore` design.

---

## Original spec

## Context

We just added two new data sources and want to (1) parse them into queryable form,
(2) cross-validate against our existing HLS scrape, and (3) shift the DVC remote
from S3 to Cloudflare R2 for cheaper egress. The laptop is at 95% full so the
data-heavy steps belong on `e` (more CPU + headroom).

### What's already in place (don't redo)

- **NJ Treasury MOD-IV zips** are DVC-tracked via `import-url --to-remote` at
  `data/modiv/treasury/modiv-{2021..2025}.zip.dvc`. Pull them with
  `dvc pull data/modiv/treasury/modiv-{YYYY}.zip.dvc`.
- **Extract slice**: `jct modiv pull-treasury -y 2021 -y 2022 …` re-runs the
  download (or skips if cached) and extracts `Hudson*re.txt` into
  `data/modiv/treasury/{year}/`. The extract step shells out to `unzip` because
  Python's `zipfile` chokes on Treasury's compression for some years.
- **Layout reference**: `data/modiv/treasury/modivlayout.pdf` (185KB) has the
  fixed-width field offsets. 700-char records, key in cols 1-35
  (COUNTY-DISTRICT 1-4, BLOCK 5-13, LOT 14-22, QUALIFIER 23-33, RECORD-ID 34-35).
- **Rutgers per-block API**: `jct modiv pull-blocks -m JerseyCity` (polite
  jittered ~24min for full JC, 1239 blocks). Only useful for the
  `propertyTaxInfo[0].record_2014_id` … `record_2025_id` historical-record IDs
  per lot, which Treasury doesn't expose. Optional — skip unless we actually
  need 2014-2020 BLQ history.

### What we already verified

- All 5 Treasury years downloadable + extractable, ~64,885 JC records each.
- HLS's `data/payments.parquet` has dense 2015-2025 records (>90% non-zero `Paid`).
- The `data/cache/JerseyCity/*.json.gz` HLS scrape goes back to 1972 per account
  (we just don't have parcel geometry for years that old).
- The 88 Morgan / 65 Bay address-gap is real: neither HLS nor MOD-IV has any
  field containing "BAY" for Block 11608. That's signage/postal-lobby only —
  fixing requires OSM building polygons or USPS, out of scope for this spec.

---

## Tasks (in dependency order)

### 1. MOD-IV `HudsonRE.txt` → parquet parser

Add `jct modiv parse` that walks `data/modiv/treasury/*/Hudson*re.txt` and
writes one parquet per year to `data/modiv/treasury/{year}.parquet`. Filter
to MUN=0906 (JC). Use the field offsets from `modivlayout.pdf` (pages 1-3
in the PDF). Capture at minimum:

- key: `county_district`, `block`, `lot`, `qualifier`, `record_id`
- address: `property_location` (59-83), `street_address` (211-235),
  `city_state`, `zip_code`
- multi-lot: `addition_lots1` (128-147), `addition_lots2` (148-167)
- old-BLQ tracking: `old_property_id` (522-550)
- values: `land_value` (421-429), `improvement_value` (430-438),
  `net_value` (439-447)
- taxes: `last_year_tax` (601-609), `current_year_tax` (610-618) —
  S9(7)V99 format means signed, 7 digits int + 2 decimal (implied), last
  char may be the sign in zoned-decimal form (see modivlayout for the encoding)
- building: `building_description` (84-98), `land_description` (99-118),
  `calculated_acreage` (119-127), `year_constructed` (416-419)
- census: `census_tract`, `census_block`
- property: `property_class` (56-58), `property_use_code` (560-562)

Notes:
- S9(7)V99 is COBOL zoned-decimal: rightmost char has high nibble overloaded
  with sign info — `{` = positive 0, `}` = negative 0, `A-I` = positive 1-9,
  `J-R` = negative 1-9. Treat as cents (divide by 100).
- Strip trailing spaces on text fields.
- Some lines may be shorter than 700 chars (trailing whitespace stripped) —
  pad before slicing.

Each year's parquet: ~65k rows × ~25 columns → a few MB. DVC-track via
`dvc add data/modiv/treasury/{year}.parquet.dvc` so they're cheap to share.

### 2. Cross-validate Treasury vs HLS

Read `data/modiv/treasury/{year}.parquet` and `data/payments.parquet`. For
each (BLQ, year) pair common to both:

- Compare Treasury `current_year_tax` (cents → dollars) to HLS `Billed` and
  `Paid` for the same `year`. They should match within rounding for years
  the homeowner paid in full. Mismatches → either HLS scrape is stale OR
  the taxpayer is delinquent/abated.
- Quantify: how many BLQs match exactly? Off by <$1? Off by >$10? Missing
  in one side?
- Write `tmp/modiv-vs-hls-{year}.parquet` with the per-BLQ comparison and
  print a summary table.

### 3. Old-property-ID analysis

For each Treasury year, count how many records have a non-empty
`old_property_id` (positions 522-550, X(29)). The field encodes the prior
BLQ for renumbered lots.

- Per-year non-empty count + rate.
- Sample 20 records: show `(current BLQ, old_property_id)` so we can eyeball
  the format. Likely `MUN + old_block + old_lot + old_qualifier` matching
  the 29-char width.
- Build a `data/modiv/blq_history.parquet` cross-year mapping: union of all
  `(year, current_blq, old_blq)` tuples. This is the canonical answer to
  "what was lot Block-Lot-Qual called before YYYY?"

### 4. DVC remote: S3 → Cloudflare R2

Current `.dvc/config`:
```
[core]
    remote = s3
['remote "s3"']
    url = s3://jc-taxes/.dvc/cache
```

Migration steps:
1. Create R2 bucket `jc-taxes` (or similar) at https://dash.cloudflare.com →
   R2 → Create bucket. Region: auto.
2. Generate an R2 API token with R2 Object Read & Write. Save endpoint URL
   (`https://<account>.r2.cloudflarestorage.com`), access key, secret.
3. Configure DVC:
   ```
   dvc remote add r2 s3://jc-taxes/.dvc/cache
   dvc remote modify r2 endpointurl https://<account>.r2.cloudflarestorage.com
   dvc remote modify --local r2 access_key_id <KEY>
   dvc remote modify --local r2 secret_access_key <SECRET>
   ```
   (R2 speaks S3-compatible API; that's why the URL stays `s3://...`.)
4. Mirror everything from S3 → R2:
   ```
   dvc pull -r s3   # ensure local cache has everything
   dvc push -r r2   # push from local cache to R2
   ```
   This will move whatever the cache contains. The 5 Treasury zips were
   `--to-remote`d directly to S3 — need to pull them down first so R2 gets
   them.
5. Verify from a fresh location:
   ```
   git clone … && cd … && dvc pull -r r2 data/cache.dvc
   ```
6. Once R2 is verified working, flip default: edit `.dvc/config` to set
   `remote = r2`. Keep S3 as `remote = s3` for fallback / one cycle.
7. After a few weeks of stable R2 usage, retire S3 (or keep as deep
   archive).

The `--local` modifier on credential settings writes them to
`.dvc/config.local` (gitignored) — never commit access keys.

### 5. Disk cleanup once R2 is verified

- `dvc gc -w -r r2 -c` — remove cache blobs not currently checked out AND
  not in remote. Aggressive cleanup; safe once we trust R2.
- The 5 extracted `Hudson*re.txt` files (~525MB total) can be deleted once
  the parquets exist; regenerable via `jct modiv pull-treasury`.

---

## Reporting back

In `specs/done/modiv-etl-and-r2-migration.md` (after move), include:

- File counts + row counts per parquet
- Treasury-vs-HLS match-rate summary (3-4 lines)
- Old-property-ID non-empty rate per year + sample of 5 historical mappings
- Confirmation that R2 mirror works (`dvc pull -r r2` clean from a tmp dir)
- Anything that surprised you in the data (e.g. encoding quirks, ranges
  outside the layout spec, MUN codes that don't match expectations)

Do NOT commit `data/modiv/treasury/*.parquet` directly — DVC-track them.
Do NOT commit any R2 / S3 credentials.
