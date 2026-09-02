# jc-taxes

Interactive 3D choropleth of Jersey City property tax payments, from 2018 to 2025: **[jct.rbw.sh]**

[![Lots and blocks](www/public/og.gif)][jct.rbw.sh]

| | |
|---|---|
| [![Wards](www/public/og-ward.png)](www/public/og-ward.png) | [![Units](www/public/og-unit.png)](www/public/og-unit.png) |
| [![From the west](www/public/og-west-lot.png)](www/public/og-west-lot.png) | [![Lots](www/public/og-lot.png)](www/public/og-lot.png) |

### Total taxes paid

The default views color by tax density (`$/sqft`). Switch the metric to **total dollars** (`mt=total`) and every parcel becomes a uniform-footprint column whose height is its actual tax bill — so a handful of downtown towers stand up against a near-flat periphery, and you can see at a glance where the city's money comes from rather than just how dense it is.

| | |
|---|---|
| [![Total paid, by block](www/public/total-block.png)][total-block-view] | [![Total paid, by lot](www/public/total-lot.png)][total-lot-view] |

All view state is URL-encoded via [use-prms] (`v`iew, `agg`regation, `mt` metric, `sel`ection, `mh` max height, `pct` percentile, `sp` settings position, ...):
- [**Lots**][lot-view] — [`?agg=lot&sel=14507-1`][lot-view]
- [**Wards**][ward-view] — [`?agg=ward&sel=ward-E&wg=blocks`][ward-view]
- [**Units**][unit-view] — [`?agg=unit&mh=1100&pct=99&sp=br`][unit-view]
- [**From the west**][west-view] — [`?v=…+106&agg=lot`][west-view]
- [**Total paid, by block**][total-block-view] — [`?mt=total`][total-block-view]
- [**Total paid, by lot**][total-lot-view] — [`?mt=total&agg=lot`][total-lot-view]

## What it shows

Every property tax payment in Jersey City, visualized as extruded polygons on a map. Color and height encode $/sqft (or $/capita). Parcels can be viewed at five aggregation levels: wards, census blocks, tax blocks, dissolved lots, and individual units.

Payment history (billed/paid per account) is scraped per-account from the [HLS property tax inquiry system][HLS] (~70K JC accounts; Bayonne/Hoboken partially too). Parcel geometry and countywide tax-list attributes (assessments, class, owner, exemptions) come from [NJGIN] (`HudsonCountyParcels` + `HudsonTaxList`, TY2024) and the [NJ Treasury MOD-IV][MODIV] bulk extract (2021–2025), with older [JC Open Data] geometries as fallback. Levy splits (school/city/county) come from the [NJ DLGS Abstract of Ratables][DLGS], and population from [Census TIGER/Line][TIGER].

## Structure

```
src/jc_taxes/       Python package: scrape, process, export
  cli.py            `jct` CLI (enumerate-accounts, fetch, export)
  api.py            HLS API client
  payments.py       Extract yearly payment totals from cached JSONs
  geojson_yearly.py Join payments + geometries → GeoJSON per year/aggregation
  building_desc.py  Parse encoded Building Desc field (stories, units, etc.)
  census.py         Census block + ward geometry/population processing
data/               Parcel data, payment caches, parquet exports
census/             Census block geometries, ward boundaries, population
www/                Vite + React web app (see www/README.md)
```

## Data pipeline

```
jct enumerate-accounts   # discover ~70K accounts from parcel block numbers
jct fetch                # fetch account details from HLS (one JSON per account)
jct export               # extract structured data → data/taxes.parquet
python -m jc_taxes.payments      # → data/payments.parquet
python -m jc_taxes.geojson_yearly  # → www/public/taxes-{year}-{agg}.geojson
```

See [DATA-SOURCES.md] for details on each data source.

## Setup

```bash
# Python (data pipeline)
uv sync

# Web app
cd www && pnpm install
```

## Links

- [ROADMAP.md] — shipped features and future plans
- [DATA-SOURCES.md] — data sources and pipeline details
- [www/README.md](www/README.md) — web app docs

[jct.rbw.sh]: https://jct.rbw.sh/
[lot-view]: https://jct.rbw.sh/?v=40.7309-74.0630+12.3+52-28&agg=lot&sel=14507-1
[ward-view]: https://jct.rbw.sh/?v=40.7085-74.0300+11.8+54+100&agg=ward&sel=ward-E&wg=blocks
[unit-view]: https://jct.rbw.sh/?v=40.7188-74.0563+13.6+66-34&agg=unit&mh=1100&pct=99&sp=br
[west-view]: https://jct.rbw.sh/?v=40.7192-74.0411+12.5+57+106&agg=lot&sel=14507-1
[total-block-view]: https://jct.rbw.sh/?v=40.7426-74.0587+12.3+47-21&mt=total
[total-lot-view]: https://jct.rbw.sh/?v=40.7299-74.0632+12.3+40-26&mt=total&agg=lot
[use-prms]: https://github.com/runsascoded/use-prms
[HLS]: https://apps.hlssystems.com/JerseyCity/PropertyTaxInquiry
[NJGIN]: https://njgin.nj.gov/
[JC Open Data]: https://data.jerseycitynj.gov/
[TIGER]: https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html
[MODIV]: https://www.nj.gov/treasury/taxation/lpt/lpt-year.shtml
[DLGS]: https://www.nj.gov/dca/dlgs/resources/property_tax.shtml
[ROADMAP.md]: ROADMAP.md
[DATA-SOURCES.md]: DATA-SOURCES.md

---

https://github.com/user-attachments/assets/16ee2158-be12-4e8d-82b4-5b21ff8682c7

**[Try it live →][jct.rbw.sh]**

