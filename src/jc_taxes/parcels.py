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
    out = np.zeros(len(rows))
    if not len(geoms):
        return out
    tree = STRtree(geoms)
    for i, g in enumerate(rows.geometry.values):
        if g is None or g.is_empty or g.area == 0:
            continue
        hits = tree.query(g, predicate="intersects")
        if len(hits):
            out[i] = shapely.union_all(geoms[hits]).intersection(g).area / g.area
    return out


def _overlap_losers(rows, lot_keys, amt) -> set[str]:
    """Lots billed in the same year whose shapes overlap (> MAX_COVERED of the
    smaller): all but the one with the largest amount that year."""
    from shapely import STRtree

    geoms = rows.geometry.values
    tree = STRtree(geoms)
    losers: set[str] = set()
    for i, g in enumerate(geoms):
        if g is None or g.is_empty or g.area == 0:
            continue
        for j in tree.query(g, predicate="intersects"):
            if j <= i or lot_keys[j] == lot_keys[i]:
                continue
            h = geoms[j]
            if h.area and g.intersection(h).area > MAX_COVERED * min(g.area, h.area):
                a, b = lot_keys[i], lot_keys[j]
                losers.add(a if amt.get(a, 0) < amt.get(b, 0) else b)
    return losers


def _norm(s) -> str:
    return "" if s is None or (isinstance(s, float) and s != s) else str(s).strip()


@parcels.command()
@click.option("-c", "--county", "county_path", type=click.Path(dir_okay=False, path_type=Path), help="County GeoJSON (default: newest `data/parcels/Hudson_County_Parcels_*.geojson`).")
def combine(county_path: Path | None):
    """Rebuild `jc_parcels_combined.parquet` with per-year parcel sets (`years` column).

    The county layer is a current snapshot (sometimes ahead of the tax roll);
    the legacy rows hold lots since split / merged / renumbered. Each year shows
    the lots billed that year, so historical payments land on their own lots:
    1. rows whose lot is billed that year (county shape when both have the key).
       Around a subdivision / merger both the old and new lots can appear on a
       year's roll (the old one with a trivial amount); when two billed lots
       overlap, the one with the larger amount that year keeps the area;
    2. then unbilled rows (exempt land, …), county before legacy, that aren't
       mostly (> MAX_COVERED) under rows already chosen for that year.
    Rows active in no year are dropped.
    """
    import geopandas as gpd
    import numpy as np
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
        "source": service,
    }, crs=county.crs)
    legacy = gpd.read_parquet(LEGACY)
    legacy = legacy.to_crs(county.crs) if legacy.crs and legacy.crs.to_epsg() != 3424 else legacy.set_crs(county.crs, allow_override=True)
    key = lambda df: df["block"].map(_norm) + "|" + df["lot"].map(_norm) + "|" + df["qual"].map(_norm)
    legacy = legacy[~key(legacy).isin(set(key(county)))]  # same key: county shape wins
    rows = gpd.GeoDataFrame(
        pd.concat([county, legacy[["block", "lot", "qual", "geometry", "source"]]], ignore_index=True),
        geometry="geometry", crs=county.crs,
    )
    is_county = (rows["source"] == service).values
    lot_key = (rows["block"].map(_norm) + "-" + rows["lot"].map(_norm)).values

    pay = pd.read_parquet(DATA / "payments.parquet", columns=["Year", "Block", "Lot", "Billed", "Paid"])
    pay = pay[pay["Year"].between(YEARS[0], YEARS[-1])].copy()
    pay["key"] = pay["Block"].map(_norm) + "-" + pay["Lot"].map(_norm)
    pay["amt"] = pay["Billed"].fillna(0).abs() + pay["Paid"].fillna(0).abs()
    amount = pay.groupby(["Year", "key"])["amt"].sum()
    billed_by_year = {y: set(pay.loc[pay["Year"] == y, "key"]) for y in YEARS}

    active = np.zeros((len(rows), len(YEARS)), dtype=bool)
    for yi, y in enumerate(YEARS):
        sel = np.isin(lot_key, list(billed_by_year[y]))
        amt_y = amount.loc[y] if y in amount.index.get_level_values(0) else pd.Series(dtype=float)
        losers = _overlap_losers(rows[sel], lot_key[sel], amt_y)
        sel &= ~np.isin(lot_key, list(losers))
        for group in (is_county & ~sel, ~is_county & ~sel):
            idx = np.flatnonzero(group)
            covered = _covered_frac(rows.iloc[idx], rows[sel])
            sel[idx[covered <= MAX_COVERED]] = True
        active[:, yi] = sel
        err(f"{y}: {int(sel.sum()):,} parcels ({int((sel & is_county).sum()):,} county, {int((sel & ~is_county).sum()):,} legacy); "
            f"billed lots without geometry: {len(billed_by_year[y] - set(lot_key[sel])):,}")
    rows["years"] = [[YEARS[j] for j in np.flatnonzero(r)] for r in active]
    keep = active.any(axis=1)
    rows = rows[keep].reset_index(drop=True)
    rows["join_key"] = rows["block"] + "-" + rows["lot"]
    rows.to_parquet(PARCELS_COMBINED)
    err(f"wrote {PARCELS_COMBINED}: {len(rows):,} rows ({int(is_county[keep].sum()):,} county, {int((~is_county[keep]).sum()):,} legacy); "
        f"dropped {int((~keep).sum()):,} active in no year")
