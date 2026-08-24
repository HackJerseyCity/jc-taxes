#!/usr/bin/env python3
"""Generate per-muni (and combined) GeoJSON files from the NJGIN Hudson dump.

Source data:
  - data/njgin/HudsonTaxList.dbf (TY2024 per-account tax data, 12 munis)
  - data/njgin/HudsonCountyParcels.shp (polygon geometries, 12 munis)

Outputs (under www/public/county/):
  - {Muni}-lots.geojson for each of the 12 munis
  - all-lots.geojson combining all 12

This is parallel to (not a replacement for) `geojson_yearly.py`, which uses the
JC-only HLS payment-history scrape.
"""
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from utz import err

from .building_desc import parse_building_desc
from .paths import HUDSON_PARCELS, HUDSON_TAXLIST, MUNIS, ROOT


# NJGIN parcel CRS is NJ State Plane (EPSG:3424, US survey foot).
NJSP_CRS = "EPSG:3424"
WGS84_CRS = "EPSG:4326"


def _norm_str(s: pd.Series) -> pd.Series:
    """Normalize a join-key column: cast to str, strip, and replace nan→''."""
    return s.fillna("").astype(str).str.strip().replace({"nan": "", "None": ""})


def _clean(v):
    """Coerce a pandas value to a JSON-friendly Python value (None for NaN)."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def _int_or_none(v):
    v = _clean(v)
    if v is None or v == "":
        return None
    try:
        i = int(v)
    except (ValueError, TypeError):
        return None
    return i


def _round(v, ndigits: int = 2):
    v = _clean(v)
    if v is None:
        return None
    try:
        return round(float(v), ndigits)
    except (ValueError, TypeError):
        return None


def load_taxlist() -> pd.DataFrame:
    """Load HudsonTaxList.dbf, normalize join keys, return as pandas DataFrame."""
    err(f"Loading {HUDSON_TAXLIST}")
    tl = gpd.read_file(HUDSON_TAXLIST)
    # GeoPandas reads .dbf as a GeoDataFrame with a None geometry column; drop it.
    if "geometry" in tl.columns:
        tl = pd.DataFrame(tl.drop(columns=["geometry"]))
    err(f"  {len(tl):,} tax records, {tl['CD_CODE'].nunique()} munis")

    tl["_mun"]   = _norm_str(tl["CD_CODE"])
    tl["_block"] = _norm_str(tl["BLOCK"])
    tl["_lot"]   = _norm_str(tl["LOT"])
    tl["_qual"]  = _norm_str(tl["QUALIFIER"])
    return tl


def load_parcels() -> gpd.GeoDataFrame:
    """Load HudsonCountyParcels.shp, project to WGS84, normalize join keys.

    Polygon area (in NJSP feet) is computed before reprojection and stored as
    `_area_sqft`.
    """
    err(f"Loading {HUDSON_PARCELS}")
    p = gpd.read_file(HUDSON_PARCELS)
    err(f"  {len(p):,} polygons, CRS={p.crs.name if p.crs else None}")

    # Compute area in NJSP feet (CRS unit is US survey foot → area is sqft).
    if p.crs is None:
        raise RuntimeError(f"Parcels shapefile missing CRS: {HUDSON_PARCELS}")
    p_proj = p.to_crs(NJSP_CRS) if str(p.crs).find("3424") < 0 else p
    p["_area_sqft"] = p_proj.geometry.area

    # Reproject to WGS84 for GeoJSON output.
    p = p.to_crs(WGS84_CRS)

    p["_mun"]   = _norm_str(p["MUN"])
    p["_block"] = _norm_str(p["BLOCK"])
    p["_lot"]   = _norm_str(p["LOT"])
    p["_qual"]  = _norm_str(p["QCODE"])
    return p


def join_taxlist_parcels(
    tl: pd.DataFrame,
    parcels: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Inner-join taxlist rows to parcel polygons on (mun, block, lot, qual)."""
    keys = ["_mun", "_block", "_lot", "_qual"]
    # Some munis have multiple polygons per (block, lot, qual) (rare).
    # Keep the largest polygon to ensure 1:1 join.
    parcels = (
        parcels.sort_values("_area_sqft", ascending=False)
        .drop_duplicates(subset=keys, keep="first")
    )
    merged = tl.merge(
        parcels[keys + ["_area_sqft", "geometry"]],
        on=keys,
        how="left",
    )
    matched = merged["geometry"].notna().sum()
    err(
        f"  Joined: {matched:,}/{len(merged):,} taxlist rows matched a polygon "
        f"({matched / len(merged) * 100:.1f}%)"
    )
    return gpd.GeoDataFrame(merged, geometry="geometry", crs=WGS84_CRS)


def _bldg_sqft_from_desc(desc: str | None) -> int | None:
    """Best-effort building square footage from BLDG_DESC.

    The NJGIN BLDG_DESC encoding doesn't carry true sqft (that's in JC's HLS
    scrape only). We can only confirm the field is parseable; return None.

    Kept as a hook for future enhancement (e.g. estimating from stories × dwell
    counts × land area).
    """
    parsed = parse_building_desc(desc)
    # No sqft in the encoding — leave to FE to decide whether to estimate.
    _ = parsed
    return None


def build_feature(row: pd.Series) -> dict | None:
    """Build a GeoJSON Feature from one merged tax+geometry row."""
    geom = row.get("geometry")
    if geom is None or (hasattr(geom, "is_empty") and geom.is_empty):
        return None

    block = row["_block"]
    lot   = row["_lot"]
    qual  = row["_qual"]
    blq   = "-".join([block, lot] + ([qual] if qual else []))

    last_yr_tx = _round(row.get("LAST_YR_TX"))
    if last_yr_tx is None:
        last_yr_tx = 0.0

    area_sqft = _clean(row.get("_area_sqft"))
    if area_sqft is None or area_sqft <= 0:
        tax_per_sqft = None
    else:
        tax_per_sqft = round(last_yr_tx / area_sqft, 4)

    calc_acre = _clean(row.get("CALC_ACRE"))
    if calc_acre is None or calc_acre <= 0:
        tax_per_acre = None
    else:
        tax_per_acre = round(last_yr_tx / float(calc_acre), 2)

    yr_built = _int_or_none(row.get("YR_CONSTR"))
    if yr_built is not None and yr_built < 1700:
        yr_built = None

    bldg_desc = _clean(row.get("BLDG_DESC"))
    bldg_sqft = _bldg_sqft_from_desc(bldg_desc) if bldg_desc else None

    properties = {
        "mun_code":    row["_mun"],
        "mun_name":    _clean(row.get("MUN_NAME")),
        "block":       block,
        "lot":         lot,
        "qual":        qual or None,
        "blq":         blq,
        "prop_loc":    _clean(row.get("PROP_LOC")),
        "owner_name":  _clean(row.get("OWNER_NAME")),
        "prop_class":  _clean(row.get("PROP_CLASS")),
        "land_val":    _int_or_none(row.get("LAND_VAL")),
        "imprvt_val":  _int_or_none(row.get("IMPRVT_VAL")),
        "net_value":   _int_or_none(row.get("NET_VALUE")),
        "last_yr_tx":  last_yr_tx,
        "bldg_desc":   bldg_desc,
        "yr_built":    yr_built,
        "bldg_sqft":   bldg_sqft,
        "calc_acre":   _round(calc_acre, 4),
        "sale_price":  _int_or_none(row.get("SALE_PRICE")),
        "area_sqft":   _round(area_sqft, 1),
        "tax_per_sqft": tax_per_sqft,
        "tax_per_acre": tax_per_acre,
    }

    geometry_geojson = json.loads(shapely.to_geojson(geom))
    return {"type": "Feature", "geometry": geometry_geojson, "properties": properties}


def _sort_key(feat: dict) -> tuple:
    p = feat["properties"]
    return (p["mun_code"] or "", p["block"] or "", p["lot"] or "", p["qual"] or "")


def write_geojson(features: list[dict], output: Path) -> None:
    """Write a sorted FeatureCollection to disk (idempotent / byte-stable)."""
    output.parent.mkdir(parents=True, exist_ok=True)
    features = sorted(features, key=_sort_key)
    fc = {"type": "FeatureCollection", "features": features}
    with open(output, "w") as f:
        # sort_keys for stable property ordering; separators to omit spaces.
        json.dump(fc, f, sort_keys=True, separators=(",", ":"))
    size_mb = output.stat().st_size / 1024 / 1024
    err(f"  Wrote {output} ({len(features):,} features, {size_mb:.1f} MB)")


def generate(output_dir: Path | None = None) -> dict[str, int]:
    """Generate per-muni and combined county GeoJSONs.

    Returns: {muni_name: n_features} (plus 'all').
    """
    if output_dir is None:
        output_dir = ROOT / "www" / "public" / "county"
    output_dir.mkdir(parents=True, exist_ok=True)

    tl = load_taxlist()
    parcels = load_parcels()
    merged = join_taxlist_parcels(tl, parcels)

    miss_count = int(merged["geometry"].isna().sum())
    err(f"  {miss_count:,} taxlist rows had no matching polygon (skipped)")

    # Drop unjoined rows for output.
    matched = merged[merged["geometry"].notna()].copy()

    # Build features grouped by muni.
    counts: dict[str, int] = {}
    all_features: list[dict] = []
    by_mun_code: dict[str, str] = {m.mun_code: m.name for m in MUNIS.values()}

    for muni_name, m in MUNIS.items():
        sub = matched[matched["_mun"] == m.mun_code]
        err(f"\n[{muni_name}] {len(sub):,} matched rows")
        if sub.empty:
            err(f"  Warning: no rows for {muni_name} ({m.mun_code})")
            continue
        feats: list[dict] = []
        for _, row in sub.iterrows():
            feat = build_feature(row)
            if feat is not None:
                feats.append(feat)
        out_path = output_dir / f"{muni_name}-lots.geojson"
        write_geojson(feats, out_path)
        counts[muni_name] = len(feats)
        all_features.extend(feats)

    # Also include any matched rows whose mun_code isn't in MUNIS (shouldn't
    # happen for Hudson, but be defensive).
    extra = matched[~matched["_mun"].isin(by_mun_code)]
    if not extra.empty:
        err(f"\nWarning: {len(extra):,} rows with unknown mun_code: "
            f"{sorted(extra['_mun'].unique().tolist())}")
        for _, row in extra.iterrows():
            feat = build_feature(row)
            if feat is not None:
                all_features.append(feat)

    err(f"\n[all] {len(all_features):,} combined features")
    write_geojson(all_features, output_dir / "all-lots.geojson")
    counts["all"] = len(all_features)
    return counts


def sanity_check(output_dir: Path | None = None) -> None:
    """Load a few outputs, print feature counts and tax totals to stderr."""
    if output_dir is None:
        output_dir = ROOT / "www" / "public" / "county"
    err("\n=== Sanity check ===")
    sample_munis = ["JerseyCity", "Hoboken", "Bayonne", "EastNewark"]
    for muni in sample_munis:
        path = output_dir / f"{muni}-lots.geojson"
        if not path.exists():
            err(f"{muni}: MISSING {path}")
            continue
        with open(path) as f:
            fc = json.load(f)
        feats = fc["features"]
        with_geom = sum(1 for ff in feats if ff.get("geometry"))
        total_tax = sum((ff["properties"].get("last_yr_tx") or 0) for ff in feats)
        nonzero = sum(1 for ff in feats if (ff["properties"].get("last_yr_tx") or 0) > 0)
        size_mb = path.stat().st_size / 1024 / 1024
        err(
            f"  {muni:14s} features={len(feats):>6,}  with_geom={with_geom:>6,}  "
            f"tax_total=${total_tax:>14,.0f}  nonzero_tax={nonzero:>6,}  "
            f"size={size_mb:>5.1f} MB"
        )

    all_path = output_dir / "all-lots.geojson"
    if all_path.exists():
        with open(all_path) as f:
            fc = json.load(f)
        feats = fc["features"]
        # Per-muni summary in the combined file
        by_mun: dict[str, dict] = {}
        for ff in feats:
            mc = ff["properties"]["mun_code"]
            d = by_mun.setdefault(mc, {"n": 0, "tax": 0.0})
            d["n"] += 1
            d["tax"] += ff["properties"].get("last_yr_tx") or 0
        err(f"\n  all-lots.geojson: {len(feats):,} features")
        for mc in sorted(by_mun):
            d = by_mun[mc]
            err(f"    {mc}: n={d['n']:>6,}  tax=${d['tax']:>14,.0f}")


if __name__ == "__main__":
    import click

    @click.command()
    @click.option("-o", "--output-dir", type=Path, default=None,
                  help="Output dir (default: www/public/county/)")
    @click.option("-S", "--no-sanity-check", is_flag=True,
                  help="Skip post-write sanity check")
    def main(output_dir: Path | None, no_sanity_check: bool):
        """Generate per-muni and combined county GeoJSONs from NJGIN dumps."""
        generate(output_dir)
        if not no_sanity_check:
            sanity_check(output_dir)

    main()
