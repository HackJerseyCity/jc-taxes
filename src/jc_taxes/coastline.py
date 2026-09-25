#!/usr/bin/env python3
"""Coastline clipping: crop parcel geometries to land using TIGER AREAWATER.

Mode B (clip upfront): parcel geometries are clipped against a land mask at load
time, so every downstream view (block / lot / unit / census / ward) is cropped to
the shoreline AND `area_sqft` (thus `$/sqft`) excludes underwater area.

Land mask: TIGER/Line AREAWATER for Hudson County (FIPS 34017), ~144 KB, 127
water polygons (Hudson River, New York Bay, Newark Bay, Hackensack River, …).
CRS is EPSG:4269 (NAD83) ≈ EPSG:4326 for clipping (sub-meter offset, negligible).
"""
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen

import geopandas as gpd
import shapely
from shapely.geometry import MultiPolygon
from shapely.ops import unary_union
from shapely.validation import make_valid
from utz import err

from .paths import DATA

AREAWATER_URL = (
    "https://www2.census.gov/geo/tiger/TIGER2023/AREAWATER/tl_2023_34017_areawater.zip"
)
AREAWATER_DIR = DATA / "tiger"
AREAWATER_ZIP = AREAWATER_DIR / "tl_2023_34017_areawater.zip"


def ensure_areawater() -> Path:
    """Download the Hudson County AREAWATER zip into data/tiger/ if missing."""
    if not AREAWATER_ZIP.exists():
        AREAWATER_DIR.mkdir(parents=True, exist_ok=True)
        err(f"Downloading {AREAWATER_URL}")
        with urlopen(AREAWATER_URL) as resp:
            AREAWATER_ZIP.write_bytes(resp.read())
        err(f"  Wrote {AREAWATER_ZIP} ({AREAWATER_ZIP.stat().st_size / 1024:.0f} KB)")
    return AREAWATER_ZIP


@lru_cache(maxsize=1)
def load_water_union() -> shapely.Geometry:
    """Return the unary_union of Hudson County water polygons in WGS84.

    The returned geometry is `shapely.prepare`d for fast repeated `.intersects()`
    / `.difference()` predicate checks against many parcel geometries.
    """
    zip_path = ensure_areawater()
    water = gpd.read_file(f"zip://{zip_path}").to_crs("EPSG:4326")
    geoms = [make_valid(g) for g in water.geometry.values if g is not None and not g.is_empty]
    wu = unary_union(geoms)
    shapely.prepare(wu)
    err(f"Loaded water mask: {len(geoms)} polygons, union {wu.geom_type}")
    return wu


def _polygonal(geom: shapely.Geometry | None) -> shapely.Geometry | None:
    """Keep only the polygonal part of a geometry.

    A `.difference()` cut can yield a GeometryCollection mixing the clipped polygon
    with stray boundary lines/points; those non-areal parts have no GeoJSON
    `coordinates` and don't render in deck.gl, so drop them and return a
    Polygon/MultiPolygon (or None if nothing areal survives).
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    def walk(g):
        if g.is_empty:
            return
        if g.geom_type == "Polygon":
            yield g
        elif hasattr(g, "geoms"):  # Multi* / (nested) GeometryCollection
            for sub in g.geoms:
                yield from walk(sub)

    parts = list(walk(geom))
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def clip_to_land(geom_wgs84: shapely.Geometry | None) -> shapely.Geometry | None:
    """Clip a WGS84 geometry to land by subtracting the water union.

    Returns the clipped polygonal geometry (None/empty if the input was entirely
    water). Uses an `.intersects()` short-circuit so only waterfront geometries pay
    the cost of a `.difference()`, and strips any non-polygonal difference slivers.
    """
    if geom_wgs84 is None or geom_wgs84.is_empty:
        return geom_wgs84
    if not geom_wgs84.is_valid:
        # make_valid can turn a self-intersecting polygon into a GeometryCollection
        # (polygons + boundary lines), so always polygonalize the final result below.
        geom_wgs84 = make_valid(geom_wgs84)
    wu = load_water_union()
    if geom_wgs84.intersects(wu):
        geom_wgs84 = geom_wgs84.difference(wu)
    return _polygonal(geom_wgs84)
