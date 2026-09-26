"""Census geography: JC census blocks (with population) and wards."""
from pathlib import Path

import geopandas as gpd
import pandas as pd
from utz import err

from .paths import ROOT

CENSUS_DIR = ROOT / "census"
BLOCKS_GEO = CENSUS_DIR / "hudson-blocks-geo.geojson"
WARDS_GEO = CENSUS_DIR / "jc-wards.geojson"
# JC Open Data `jersey-city-neighborhoods` (53 neighborhoods in 6 areas), props trimmed to `hood` / `area`.
HOODS_GEO = CENSUS_DIR / "jc-neighborhoods.geojson"


def load_jc_wards() -> gpd.GeoDataFrame:
    """Load JC ward boundaries (6 wards A-F).

    Returns GeoDataFrame with columns: ward, council_person, geometry
    """
    gdf = gpd.read_file(WARDS_GEO)
    gdf = gdf.rename(columns={"council_pe": "council_person"})
    gdf = gdf[["ward", "council_person", "geometry"]].copy()
    gdf = gdf.set_crs("EPSG:4326", allow_override=True)
    return gdf


def load_jc_neighborhoods() -> gpd.GeoDataFrame:
    """Load JC neighborhood boundaries. Returns GeoDataFrame with columns: hood, area, geometry."""
    gdf = gpd.read_file(HOODS_GEO)
    return gdf.set_crs("EPSG:4326", allow_override=True)[["hood", "area", "geometry"]]


def load_jc_census_blocks() -> gpd.GeoDataFrame:
    """Load JC census blocks filtered from Hudson County, with ward assignments.

    Filters Hudson County blocks to JC using ward boundary containment,
    assigns each block a ward via centroid spatial join.

    Returns GeoDataFrame with columns: GEOID, POP100, ward, geometry (~1,502 rows)
    """
    wards = load_jc_wards()

    blocks = gpd.read_file(BLOCKS_GEO)
    blocks = blocks[["GEOID", "POP100", "geometry"]].copy()
    blocks = blocks.set_crs("EPSG:4326", allow_override=True)
    blocks["POP100"] = pd.to_numeric(blocks["POP100"], errors="coerce").fillna(0).astype(int)

    # Project to NJSP for accurate centroid/distance calculations
    blocks_proj = blocks.to_crs("EPSG:3424")
    wards_proj = wards.to_crs("EPSG:3424")
    jc_boundary_proj = wards_proj.geometry.unary_union

    # Filter to JC: block centroid inside ward union
    centroids = blocks_proj.geometry.centroid
    in_jc = centroids.within(jc_boundary_proj)
    jc_blocks = blocks[in_jc].copy()
    err(f"Filtered {len(blocks)} Hudson County blocks → {len(jc_blocks)} JC blocks")

    # Assign ward via centroid → ward spatial join (in projected CRS)
    jc_blocks_proj = blocks_proj[in_jc].copy()
    jc_centroids = gpd.GeoDataFrame(
        jc_blocks_proj[["GEOID"]],
        geometry=jc_blocks_proj.geometry.centroid,
        crs=jc_blocks_proj.crs,
    )
    joined = gpd.sjoin(jc_centroids, wards_proj[["ward", "geometry"]], how="left", predicate="within")
    jc_blocks["ward"] = joined["ward"].values

    # A few blocks on exact boundaries may miss; assign to nearest ward
    missing = jc_blocks["ward"].isna()
    if missing.any():
        err(f"  {missing.sum()} blocks missing ward assignment, using nearest")
        for idx in jc_blocks[missing].index:
            centroid = jc_blocks_proj.loc[idx, "geometry"].centroid
            dists = wards_proj.geometry.distance(centroid)
            jc_blocks.loc[idx, "ward"] = wards.loc[dists.idxmin(), "ward"]

    return jc_blocks[["GEOID", "POP100", "ward", "geometry"]].reset_index(drop=True)
