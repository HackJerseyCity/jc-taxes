# Data Sources

## 1. Tax Payments & Owner Data — HLS Property Tax API

**Source**: `https://apps.hlssystems.com/JerseyCity/PropertyTaxInquiry`
**Code**: `src/jc_taxes/api.py`, `src/jc_taxes/cli.py`
**Local**: `data/cache/*.json` (70,180 files, one per account)

Jersey City's property tax inquiry system, hosted by HLS Systems. This is the sole source for tax payment data, account details, and owner names.

### Pipeline

1. **`jc-taxes enumerate-accounts`**: Iterates all blocks from parcel data (`data/jc_parcels.parquet`), searches HLS for accounts in each block. Produces `data/accounts_index.parquet` (~70K accounts with block/lot/qualifier).

2. **`jc-taxes fetch`**: Fetches full account details for each account number from HLS `GetAccountDetails` endpoint. One JSON file per account cached at `data/cache/{AccountNumber}.json`. Rate-limited with jitter, resumable.

3. **`jc-taxes export`**: Extracts structured data from cached JSONs into `data/taxes.parquet` (account metadata, assessed values, balances).

4. **`src/jc_taxes/payments.py`**: Extracts yearly payment totals (Billed, Paid per year) from cached JSONs into `data/payments.parquet`.

5. **`src/jc_taxes/geojson_yearly.py`**: Reads `payments.parquet` + `load_owners()` from cached JSONs, joins with parcel geometries, outputs GeoJSON files for the web app.

### What's in each cached JSON

Each `data/cache/{AccountNumber}.json` contains:
- **Account info**: Block, Lot, Qualifier, OwnerName, Address, PropertyLocation
- **Assessed values**: Land, Improvement, NetTaxable
- **Transaction details**: per-quarter Billed/Paid amounts by TaxYear
- **Balance**: Principal, Interest, TotalDue, DelinquentStatus

There is no bulk/zip download from HLS; all data is fetched one account at a time via the `GetAccountDetails` API.

## 2. Parcel Geometries & Tax List — NJGIN + JC Open Data

**Local**: `data/jc_parcels.parquet` (legacy), `data/jc_parcels_combined.parquet` (preferred), `data/njgin/HudsonCountyParcels.shp`, `data/njgin/HudsonTaxList.dbf`
**Code**: `src/jc_taxes/geojson_county.py` (countywide join)

Lot/parcel geometry, combined into one file:

- **JC Open Data** (legacy, Dec 2018): `https://data.jerseycitynj.gov/explore/dataset/jersey-city-parcels/export/` — Downloaded as Shapefile/GeoJSON, converted to `data/jc_parcels.parquet`. ~23K parcels with block/lot/qualifier and polygon geometries.

- **NJGIN** (2024): NJ Geographic Information Network statewide parcel data. Hudson County parcels downloaded as `parcels_shp_dbf_Hudson.zip` → `HudsonCountyParcels.shp` (polygons, all 12 Hudson munis). Provides more up-to-date boundaries.

`data/jc_parcels_combined.parquet` merges both: NJGIN 2024 geometries preferred, falling back to JC 2018 for parcels not in NJGIN.

NJGIN also ships **`HudsonTaxList.dbf`** — a countywide bulk **tax list** (TY2024, all 12 munis): per-account assessed values, class, owner, and exemption fields. This is a bulk download (not the per-account HLS scrape); `geojson_county.py` joins it to `HudsonCountyParcels.shp` for the multi-municipality county view.

## 2b. Assessor Bulk Extract — NJ Treasury MOD-IV

**Source**: `https://www.nj.gov/treasury/taxation/lpt/lpt-year.shtml` (NJ Division of Taxation MOD-IV); per-block records also via the Rutgers MOD-IV DB API (`https://modiv.rutgers.edu/api/v2/findByDbId/{MUN}_{BLOCK}/`)
**Code**: `src/jc_taxes/modiv.py`
**Local**: `data/modiv/treasury/modiv-20{21..25}.zip` → `HudsonRE.txt` (~108MB/yr), `data/modiv/JerseyCity/*.json.gz` (per-block API pulls)

Statewide assessor (MOD-IV) bulk extracts, 2021–2025. Provides assessed values, building descriptions, and PILOT/exemption fields — notably `initial_date`/`further_date` (in-lieu payment start/end dates) and `statute_number` for abated (class 15x) parcels. Used for building-description enrichment and abatement analysis.

## 2c. Levy Splits — NJ DLGS Abstract of Ratables

**Source**: `https://www.nj.gov/dca/dlgs/resources/property_tax.shtml` (NJ Division of Local Government Services)
**Code**: `src/jc_taxes/dlgs.py` (`jct dlgs levy`)
**Local**: `data/dlgs/abstracts/Hudson20{21..25}.xlsx` → `www/public/data/jc_levy_split.json`

Authoritative school / city / county levy breakdown from the annual Abstract of Ratables. Feeds the `/about` page levy charts.

## 3. Census Geography & Population — Census TIGER/Line + Decennial

**Local**: `census/hudson-blocks-geo.geojson`, `census/hudson-blocks-pop.json`, `census/jc-wards.geojson`
**Code**: `src/jc_taxes/census.py`

- **Census blocks**: Hudson County block geometries from [Census TIGER/Line shapefiles][TIGER], with 2020 Decennial Census population (`POP100`). Filtered to JC using ward boundary containment (~1,502 blocks).

- **Wards**: JC's 6 city council wards (A-F) with council member names. Source: [bikejc/maps][bikejc] / [JC Open Data][JCOD].

Used for census-block and ward aggregation views ($/sqft and $/capita metrics).

[TIGER]: https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html
[bikejc]: https://github.com/bikejc/maps/blob/main/public/wards.json
[JCOD]: https://data.jerseycitynj.gov/

## 4. Defunct: Old JC Tax Site

**Local**: `accounts/` (45 account directories, partial scrape)
**Site**: `http://taxes.cityofjerseycity.com/ViewPay` (no longer active)

A partial scrape from the old JC tax website (pre-HLS migration). Each subdirectory contains `original.html`, `attrs.parquet`, `txns.parquet` for one account. Only 45 accounts were captured before the site was decommissioned. Referenced by `blq.py` and `unit-taxes.ipynb`.

This data is superseded by the HLS cache and can be removed.

## Summary

| Source | What | Records | File(s) |
|--------|------|---------|---------|
| HLS API | Tax payments, owners, assessments (per-account scrape) | 70,180 accounts | `data/cache/*.json` |
| NJGIN | Parcel geometries (2024) | ~23K parcels | `data/jc_parcels_combined.parquet`, `data/njgin/HudsonCountyParcels.shp` |
| NJGIN | Countywide tax list, TY2024 (bulk) | 12 munis | `data/njgin/HudsonTaxList.dbf` |
| NJ Treasury MOD-IV | Assessor bulk extract, 2021–2025 (assessments, exemptions, PILOT dates) | statewide | `data/modiv/treasury/modiv-20*.zip` |
| NJ DLGS | Abstract of Ratables — levy splits | 2021–2025 | `data/dlgs/abstracts/Hudson20*.xlsx` |
| JC Open Data | Parcel geometries (2018, fallback) | ~23K parcels | `data/jc_parcels.parquet` |
| Census TIGER/Line | Block geometries + population | ~1,502 blocks | `census/hudson-blocks-*.{geojson,json}` |
| bikejc/JC Open Data | Ward boundaries | 6 wards | `census/jc-wards.geojson` |
| Old JC tax site | Legacy partial scrape | 45 accounts | `accounts/` (defunct) |
