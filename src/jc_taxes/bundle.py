"""Per-view geometry + all-years values bundles for the map (block / lot / unit).

Each year's `taxes-{year}-{view}.geojson` repeats the same geometry and fixed
properties; only the amounts change (and, for lots / units, the owner). The app
instead loads, once per view:

- `geom-{view}.geojson`: geometry + fixed properties (latest year's values),
  minus the per-year amounts and owner.
  Coordinates are rounded to 6 decimals (~0.1 m).
- `values-{view}-{year}.bin`: that year's paid and billed, integer cents aligned
  to the geometry's feature order (format below). One file per year, so a first
  load fetches one year (~0.13 MB brotli for lots) and each year step or
  playback frame fetches only what it shows (all 12 years ≈ 1.6 MB). A custom
  layout, not Parquet: it's smaller here (Parquet: ~1.6× for the same data) and
  reads straight into typed arrays. Derived metrics
  (`paid_per_sqft`, …) are recomputed client-side, as the pipeline does.

Per-parcel details (address, building info, owner history by year) go to the
D1 `parcels` table, fetched on hover / select (`/api/parcel`) and searched
(`/api/search`, FTS5 on address), instead of shipping with the geometry. Wards and census blocks keep per-year GeoJSON: their
geometry is trimmed to each year's tax-paying lots, and they're small.

Outputs are DVC data (`dvx add` + `dvc push`, then served by the Worker's `/d`);
the owners SQL goes to `tmp/` (not committed).
"""
import json
import struct
import subprocess
from pathlib import Path

import click
from utz import err

from . import assessed
from .aggregates import YEARS
from .paths import D1_SQL, ROOT
from .stats import WWW_PUBLIC, _load_geojson

VIEWS = {"block": "blocks", "lot": "lots", "unit": "units", "ward": "wards", "census-block": "census-blocks"}
# Wards / census blocks: a few thousand features at most, so values are small
# JSON (`values-{view}-{year}.json`), and include each year's `area_sqft` (their
# shapes are trimmed to that year's tax-paying lots, so area varies by year;
# the geometry file carries the latest year's shape).
SMALL_VIEWS = {"ward", "census-block"}
SMALL_VALUE_PROPS = ("paid", "billed", "area_sqft")
# Alternate ward shapes (Settings → ward geometry "lots" / "blocks"): big and
# rarely used, so a separate per-year file (`ward-shapes-{year}.json`), fetched on demand.
WARD_ALT_SHAPES = ("lots", "blocks")
DYNAMIC = {"paid", "billed", "paid_per_sqft", "billed_per_sqft", "paid_per_capita", "billed_per_capita", "year"}
PER_YEAR_DETAILS = {"owner"}
# Lot / unit views also get MOD-IV assessed values (`av`, `av_x`) and a
# `yr_built` fallback: `assessed.annotate`.
ASSESSED_VIEWS = {"lot", "unit"}
# Moved from the geometry to D1 `parcels` (lot / unit views): only the tooltip
# and search use them. (`yr_built` stays: color-by-year-built needs it for every parcel.)
DETAIL_PROPS = ("addr", "bldg_desc", "stories", "units", "bldg_sqft")
EDGE = ROOT / "edge"
DEFAULT_SQL = D1_SQL / "parcels.sql"
COORD_DECIMALS = 6

# `values-{view}-{year}.bin` (little-endian; parsed by `www/src/bundle.ts`):
#   magic  b"JCTV"
#   u32    version (1)
#   u32    element type: 1 = i32, 2 = f64 (i32 unless some amount overflows,
#          e.g. block totals over ~$21M)
#   u32    first year
#   u32    years (Y)
#   u32    features (N)
#   elem   paid cents              [N][Y]
#   elem   billed − paid cents     [N][Y]   (mostly 0)
VALUES_MAGIC = b"JCTV"
VALUES_VERSION = 1
I32_MAX = 2**31 - 1


def encode_values(values: dict) -> bytes:
    years, n = values["years"], values["count"]
    if years != list(range(years[0], years[0] + len(years))):
        raise ValueError(f"years must be contiguous: {years}")
    flat = [
        [rows[y][i] for i in range(n) for y in range(len(years))]
        for rows in (values["paid"], values["billed_minus_paid"])
    ]
    fits = all(-I32_MAX - 1 <= v <= I32_MAX for arr in flat for v in arr)
    elem, fmt = (1, "i") if fits else (2, "d")
    head = VALUES_MAGIC + struct.pack("<5I", VALUES_VERSION, elem, years[0], len(years), n)
    return head + b"".join(struct.pack(f"<{len(arr)}{fmt}", *arr) for arr in flat)


def small_values(view: str, per_year: dict[int, list[dict]], order: list[tuple[str, int]]) -> dict[int, dict]:
    """Per-year `{count, paid, billed, area_sqft}` arrays (feature order = `order`)."""
    index = {k: i for i, k in enumerate(order)}
    out = {}
    for y, feats in per_year.items():
        cols = {k: [0.0] * len(order) for k in SMALL_VALUE_PROPS}
        for k, f in zip(keyed(feats), feats):
            for c in SMALL_VALUE_PROPS:
                cols[c][index[k]] = round(f["properties"].get(c) or 0, 2)
        out[y] = {"count": len(order), **cols}
    return out


def ward_shapes(feats: list[dict]) -> dict[str, dict]:
    """`{ward: {lots, blocks}}` alternate shapes for one year."""
    return {
        f["properties"]["ward"]: {k: f["properties"][k] for k in WARD_ALT_SHAPES if f["properties"].get(k)}
        for f in feats
    }


def year_values(values: dict, year: int) -> dict:
    """One year's slice of `values` (the per-year file's contents)."""
    y = values["years"].index(year)
    return {"years": [year], "count": values["count"], "paid": [values["paid"][y]], "billed_minus_paid": [values["billed_minus_paid"][y]]}


def round_coords(c, n: int = COORD_DECIMALS):
    return [round_coords(x, n) for x in c] if isinstance(c[0], list) else [round(v, n) for v in c]


def feature_id(pr: dict) -> str:
    """`featureIdOf` in MapView.tsx."""
    if pr.get("geoid"):
        return pr["geoid"]
    if pr.get("ward") and not pr.get("block"):
        return f"ward-{pr['ward']}"
    return "-".join(str(pr.get(k) or "") for k in ("block", "lot", "qual")).rstrip("-")


def keyed(features: list[dict]) -> list[tuple[str, int]]:
    """(id, occurrence) per feature: ids are unique but for a stray duplicate,
    which pairs up across years by order of appearance."""
    seen: dict[str, int] = {}
    out = []
    for f in features:
        i = feature_id(f["properties"])
        n = seen.get(i, 0)
        seen[i] = n + 1
        out.append((i, n))
    return out


def run_length(by_year: dict[int, str | None]) -> list[list]:
    out: list[list] = []
    for y in sorted(by_year):
        v = by_year[y]
        if not out or out[-1][1] != v:
            out.append([y, v])
    return [e for e in out if e[1] is not None] if any(e[1] is not None for e in out) else []


def bbox_center(geom: dict) -> tuple[float, float]:
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    xs, ys = [c[0] for c in ring], [c[1] for c in ring]
    return round((min(xs) + max(xs)) / 2, 6), round((min(ys) + max(ys)) / 2, 6)


# Paid-cents value marking a feature absent in a year (year-aware parcel sets:
# a lot split / merged / renumbered exists only in some years). Fits i32 and f64.
INACTIVE = -(2**31)


def build(view: str, per_year: dict[int, list[dict]]) -> tuple[dict, dict, dict[str, dict]]:
    """(geom FeatureCollection, values, details by id) for one view. Features are
    the union over years (latest year's order first, then features absent from
    it, most recent first); each carries its last appearance's geometry and fixed
    properties. Years a feature is absent from get `INACTIVE` paid. Details
    (lot / unit views only): `DETAIL_PROPS`, center, owner history."""
    years = sorted(per_year)
    last: dict[tuple[str, int], dict] = {}  # key → feature from its latest year
    for y in reversed(years):
        for k, f in zip(keyed(per_year[y]), per_year[y]):
            last.setdefault(k, f)
    order = list(last)
    index = {k: i for i, k in enumerate(order)}
    n = len(order)
    detailed = any("owner" in f["properties"] for f in last.values())
    geom = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {**f["geometry"], "coordinates": round_coords(f["geometry"]["coordinates"])},
                "properties": {
                    k: v for k, v in f["properties"].items()
                    if k not in DYNAMIC and k not in PER_YEAR_DETAILS and k not in WARD_ALT_SHAPES
                    and (not detailed or k not in DETAIL_PROPS) and (view not in SMALL_VIEWS or k != "area_sqft")
                },
            }
            for f in last.values()
        ],
    }
    paid, billed = [], []
    owners: dict[str, dict[int, str | None]] = {}
    for y in years:
        p, b = [INACTIVE] * n, [0] * n
        for k, f in zip(keyed(per_year[y]), per_year[y]):
            pr = f["properties"]
            i = index[k]
            p[i] = round((pr.get("paid") or 0) * 100)
            b[i] = round((pr.get("billed") or 0) * 100)
            if "owner" in pr and k[1] == 0:
                owners.setdefault(k[0], {})[y] = pr.get("owner")
        paid.append(p)
        billed.append([0 if pi == INACTIVE else bi - pi for pi, bi in zip(p, b)])
    values = {"years": years, "count": n, "paid": paid, "billed_minus_paid": billed}
    details = {}
    if detailed:
        for (i, occ), f in last.items():
            if occ:
                continue
            pr = f["properties"]
            lng, lat = bbox_center(f["geometry"])
            details[i] = {**{k: pr.get(k) for k in DETAIL_PROPS}, "lng": lng, "lat": lat, "owners": run_length(owners.get(i, {}))}
    return geom, values, details


def _sql(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


@click.command()
@click.option("-c", "--cache-dir", type=click.Path(file_okay=False, path_type=Path), help="Cache GeoJSON not checked out locally (see `jct stats`).")
@click.option("-d", "--db", default="jct", show_default=True, help="D1 database name.")
@click.option("-m", "--modiv", "modiv_path", type=click.Path(dir_okay=False, path_type=Path), default=assessed.LATEST_PATH, show_default=True, help="MOD-IV parquet for lot / unit assessed values.")
@click.option("-l", "--local", is_flag=True, help="Apply owners to the local (wrangler dev) D1 instead of remote.")
@click.option("-n", "--dry-run", is_flag=True, help="Write files + SQL, but don't load D1.")
@click.option("-o", "--out-dir", type=click.Path(file_okay=False, path_type=Path), default=WWW_PUBLIC, show_default=True, help="Where to write geom-*/values-* (DVC-tracked).")
@click.option("-v", "--view", "views", multiple=True, type=click.Choice(list(VIEWS)), help="Only these views (default: all).")
def bundle(cache_dir: Path | None, db: str, modiv_path: Path, local: bool, dry_run: bool, out_dir: Path, views: tuple[str, ...]):
    """Write per-view geometry + all-years values; load owner history into D1."""
    stmts = []
    records = None
    for view in views or tuple(VIEWS):
        suffix = VIEWS[view]
        per_year = {y: _load_geojson(view, y, cache_dir, force=False)["features"] for y in YEARS}
        geom, values, details = build(view, per_year)
        if view in ASSESSED_VIEWS:
            if records is None:
                records = assessed.load(modiv_path)
            st = assessed.annotate(view, geom["features"], records)
            err(f"{view}: {st['matched']:,}/{st['features']:,} features matched MOD-IV ({modiv_path.name}); yr_built filled on {st['yr_filled']:,}")
        dump = lambda o: (json.dumps(o, separators=(",", ":")) + "\n").encode()
        outputs = [(f"geom-{suffix}.geojson", dump(geom))]
        if view in SMALL_VIEWS:
            order = [(f["properties"].get("geoid") or f"ward-{f['properties'].get('ward')}", 0) for f in geom["features"]]
            outputs += [(f"values-{suffix}-{y}.json", dump(v)) for y, v in small_values(view, per_year, order).items()]
            if view == "ward":
                outputs += [(f"ward-shapes-{y}.json", dump(ward_shapes(fs))) for y, fs in per_year.items()]
        else:
            outputs += [(f"values-{suffix}-{y}.bin", encode_values(year_values(values, y))) for y in values["years"]]
        for name, data in outputs:
            path = out_dir / name
            path.write_bytes(data)
            err(f"wrote {path} ({len(data) / 1e6:.1f} MB)")
        if details:
            stmts.append(f"DELETE FROM parcels WHERE view = {_sql(view)};")
            cols = ("view", "id", *DETAIL_PROPS, "lng", "lat", "owners")
            for i, d in details.items():
                vals = (view, i, *(d[k] for k in DETAIL_PROPS), d["lng"], d["lat"], json.dumps(d["owners"], separators=(",", ":")))
                stmts.append(f"INSERT INTO parcels ({', '.join(cols)}) VALUES ({', '.join(_sql(v) for v in vals)});")
    if not stmts:
        return
    stmts.append("INSERT INTO parcels_fts(parcels_fts) VALUES('rebuild');")
    DEFAULT_SQL.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_SQL.write_text("\n".join(stmts) + "\n")
    err(f"wrote {DEFAULT_SQL} ({len(stmts)} statements)")
    if dry_run:
        return
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", db, "--local" if local else "--remote", "--file", str(DEFAULT_SQL), "-y"],
        cwd=EDGE, check=True,
    )


if __name__ == "__main__":
    bundle()
