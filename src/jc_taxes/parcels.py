"""Parcel (tax-lot) geometry: fetch the Hudson County GIS parcels layer and
combine it with the older sources into `data/jc_parcels_combined.parquet`.

Sources, highest priority first (per block / lot / qualifier):
1. **Hudson County GIS** "Hudson County Parcels <Month YYYY>" (public ArcGIS
   Online layer, all 12 Hudson munis, sub-lots and condo qualifiers; updated a
   few times a year). Fetched for Jersey City (`MUN=0906`), non-owner fields only.
2. **Legacy combined** (`data/parcels/legacy_combined.parquet`): the previous
   `jc_parcels_combined.parquet` (NJGIN 2024 + JC 2018 fallback), snapshotted
   as-is since the script that assembled it wasn't kept.

All geometry is NJ State Plane (EPSG:3424, US survey ft), as the pipeline expects.
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import click
from utz import err

from .aggregates import YEARS
from .paths import DATA, PARCELS_COMBINED

PARCELS_DIR = DATA / "parcels"
LEGACY = PARCELS_DIR / "legacy_combined.parquet"
HUDSON_ORG = "Stu7jwuXrnM0myT0"
HUDSON_SERVICES = f"https://services3.arcgis.com/{HUDSON_ORG}/arcgis/rest/services"
JC_MUN = "0906"
# Owner / mailing fields exist on the layer; never request them.
OUT_FIELDS = ["PAMS_PIN", "MUN", "BLOCK", "LOT", "QCODE", "MAPSHTNO", "SOURCEDATE", "LASTUPDATE"]
PAGE = 2000


def _get_json(url: str, params: dict, tries: int = 4) -> dict:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(full, headers={"User-Agent": "jc-taxes parcels"}), timeout=120) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:
            if i == tries - 1:
                raise
            err(f"  retry {i + 1} ({e})")
            time.sleep(2 ** i)
    raise AssertionError


def latest_service() -> str:
    """Name of the newest "Hudson_County_Parcels_<Month>_<YYYY>" feature service."""
    d = _get_json(f"{HUDSON_SERVICES}", {"f": "json"})
    names = [s["name"] for s in d.get("services", []) if s["name"].startswith("Hudson_County_Parcels_")]
    if not names:
        raise click.ClickException(f"no Hudson_County_Parcels_* service under {HUDSON_SERVICES}")
    months = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}

    def key(n: str):
        parts = n.split("_")
        return (int(parts[-1]), months.get(parts[-2], 0)) if parts[-1].isdigit() else (0, 0)
    return max(names, key=key)


@click.group()
def parcels():
    """Parcel geometry: fetch the county layer, combine sources."""


@parcels.command()
@click.option("-s", "--service", help="Feature service name (default: the newest `Hudson_County_Parcels_*`).")
def fetch(service: str | None):
    """Download Jersey City parcels from the Hudson County GIS layer → `data/parcels/<service>.geojson`."""
    service = service or latest_service()
    url = f"{HUDSON_SERVICES}/{service}/FeatureServer/0/query"
    where = f"MUN='{JC_MUN}'"
    total = _get_json(url, {"where": where, "returnCountOnly": "true", "f": "json"})["count"]
    err(f"{service}: {total:,} Jersey City features")
    feats = []
    while len(feats) < total:
        page = _get_json(url, {
            "where": where, "outFields": ",".join(OUT_FIELDS), "outSR": 3424, "f": "geojson",
            "orderByFields": "OBJECTID", "resultOffset": len(feats), "resultRecordCount": PAGE,
        })["features"]
        if not page:
            break
        feats += page
        err(f"  {len(feats):,} / {total:,}")
    if len(feats) != total:
        raise click.ClickException(f"got {len(feats)} of {total} features")
    PARCELS_DIR.mkdir(parents=True, exist_ok=True)
    out = PARCELS_DIR / f"{service}.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "service": service, "features": feats}, separators=(",", ":")) + "\n")
    err(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


MAX_COVERED = 0.5


def _covered_frac(rows, county):
    """Fraction of each row's area covered by county parcels."""
    import numpy as np
    import shapely
    from shapely import STRtree

    geoms = county.geometry.values
    tree = STRtree(geoms)
    out = np.zeros(len(rows))
    for i, g in enumerate(rows.geometry.values):
        if g is None or g.is_empty or g.area == 0:
            continue
        hits = tree.query(g, predicate="intersects")
        if len(hits):
            out[i] = shapely.union_all(geoms[hits]).intersection(g).area / g.area
    return out


def _contained_in(rows, cover) -> list:
    """Index labels of `rows` whose area is mostly (> MAX_COVERED) inside `cover`."""
    from shapely import STRtree

    geoms = cover.geometry.values
    if not len(geoms):
        return []
    tree = STRtree(geoms)
    out = []
    for idx, g in zip(rows.index, rows.geometry.values):
        if g is None or g.is_empty or g.area == 0:
            continue
        hits = tree.query(g, predicate="intersects")
        if len(hits) and sum(geoms[h].intersection(g).area for h in hits) / g.area > MAX_COVERED:
            out.append(idx)
    return out


def _norm(s) -> str:
    return "" if s is None or (isinstance(s, float) and s != s) else str(s).strip()


@parcels.command()
@click.option("-c", "--county", "county_path", type=click.Path(dir_okay=False, path_type=Path), help="County GeoJSON (default: newest `data/parcels/Hudson_County_Parcels_*.geojson`).")
def combine(county_path: Path | None):
    """Rebuild `jc_parcels_combined.parquet`: county geometry first, legacy rows for keys it lacks."""
    import geopandas as gpd
    import pandas as pd

    if county_path is None:
        cands = sorted(PARCELS_DIR.glob("Hudson_County_Parcels_*.geojson"), key=lambda p: p.stat().st_mtime)
        if not cands:
            raise click.ClickException("no county GeoJSON; run `jct parcels fetch`")
        county_path = cands[-1]
    if not LEGACY.exists():
        raise click.ClickException(f"{LEGACY} missing (`dvc pull` it)")
    service = county_path.stem
    county = gpd.read_file(county_path).set_crs(3424, allow_override=True)
    county = county[county.geometry.notna() & ~county.geometry.is_empty]
    county = gpd.GeoDataFrame({
        "block": county["BLOCK"].map(_norm),
        "lot": county["LOT"].map(_norm),
        "qual": county["QCODE"].map(_norm).replace("", None),
        "geometry": county.geometry,
    }, crs=county.crs)
    county["source"] = service
    legacy = gpd.read_parquet(LEGACY)
    legacy = legacy.to_crs(county.crs) if legacy.crs and legacy.crs.to_epsg() != 3424 else legacy.set_crs(county.crs, allow_override=True)
    key = lambda df: df["block"].map(_norm) + "|" + df["lot"].map(_norm) + "|" + df["qual"].map(_norm)
    have = set(key(county))
    fallback = legacy[~key(legacy).isin(have)].reset_index(drop=True)
    # Lots billed in the latest roll year, and in any year.
    pay = pd.read_parquet(DATA / "payments.parquet", columns=["Year", "Block", "Lot"])
    lot_key = lambda b, l: b.map(_norm) + "-" + l.map(_norm)
    latest = YEARS[-1]  # the map's last year (payments.parquet also has stray future-year rows)
    billed_now = set(lot_key(pay.loc[pay["Year"] == latest, "Block"], pay.loc[pay["Year"] == latest, "Lot"]))
    shown = pay[pay["Year"].between(YEARS[0], latest)]  # not next year's preliminary bills
    billed_ever = set(lot_key(shown["Block"], shown["Lot"]))
    fb_lot = lot_key(fallback["block"], fallback["lot"])
    co_lot = lot_key(county["block"], county["lot"])
    # The county layer can be ahead of the tax roll (e.g. 2026 subdivisions not
    # billed yet) or behind it. Per area, keep the geometry whose lot is billed:
    # - a legacy lot still billed now keeps its shape, and county lots it mostly
    #   contains that have never been billed (not-yet-billed successors) drop;
    # - a legacy lot not billed now and mostly under county parcels is retired /
    #   renumbered: it drops, and its older payments fold to its successors
    #   (`fold_orphan_payments`);
    # - anything else (gaps in the county layer) stays.
    current = fb_lot.isin(billed_now).values
    covered = _covered_frac(fallback, county)
    keep_fb = current | (covered <= MAX_COVERED)
    ahead = _contained_in(county[~co_lot.isin(billed_ever)], fallback[current])
    county = county.drop(index=ahead)
    err(f"legacy rows not in county: {len(fallback):,}: kept {int(current.sum()):,} billed in {latest}, "
        f"{int((~current & (covered <= MAX_COVERED)).sum()):,} filling gaps; dropped {int((~keep_fb).sum()):,} retired. "
        f"County lots never billed and superseded by a billed legacy lot: {len(ahead):,} dropped")
    fallback = fallback[keep_fb]
    combined = pd.concat([county, fallback[["block", "lot", "qual", "geometry", "source"]]], ignore_index=True)
    combined["join_key"] = combined["block"] + "-" + combined["lot"]
    combined = gpd.GeoDataFrame(combined, geometry="geometry", crs=county.crs)
    combined.to_parquet(PARCELS_COMBINED)
    err(f"wrote {PARCELS_COMBINED}: {len(combined):,} rows ({len(county):,} {service}, {len(fallback):,} legacy: "
        + ", ".join(f"{k} {v:,}" for k, v in fallback["source"].value_counts().items()) + ")")
