# MOD-IV ETL + DVC remote S3 → R2 migration

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
