"""Path definitions for jc-taxes project."""
from dataclasses import dataclass
from pathlib import Path

# Project root (relative to this file)
ROOT = Path(__file__).parent.parent.parent

# Data directory
DATA = ROOT / "data"

# Cache root (per-muni subdirs underneath)
CACHE_ROOT = DATA / "cache"

# Parcel data from JC Open Data (legacy Dec 2018)
PARCELS = DATA / "jc_parcels.parquet"

# Combined parcels (NJGIN 2024 + JC 2018 fallback)
PARCELS_COMBINED = DATA / "jc_parcels_combined.parquet"

# Hudson County NJGIN snapshots
HUDSON_PARCELS = DATA / "njgin" / "HudsonCountyParcels.shp"
HUDSON_TAXLIST = DATA / "njgin" / "HudsonTaxList.dbf"


@dataclass(frozen=True)
class Muni:
    name: str             # canonical key, also subdir name (e.g. "JerseyCity")
    hls_path: str         # HLS URL path segment
    mun_code: str         # NJ MUN code (CD_CODE in HudsonTaxList)
    mun_name: str         # full name as in HudsonTaxList.MUN_NAME
    enumerate: str = "block"  # "block" (BLQ search by block) or "paginate" (Account search, all rows)


MUNIS = {
    "Bayonne":      Muni("Bayonne",      "Bayonne",      "0901", "BAYONNE CITY", enumerate="paginate"),
    "EastNewark":   Muni("EastNewark",   "EastNewark",   "0902", "EAST NEWARK BORO"),
    "Guttenberg":   Muni("Guttenberg",   "Guttenberg",   "0903", "GUTTENBERG TOWN"),
    "Harrison":     Muni("Harrison",     "Harrison",     "0904", "HARRISON TOWN"),
    "Hoboken":      Muni("Hoboken",      "Hoboken",      "0905", "HOBOKEN CITY"),
    "JerseyCity":   Muni("JerseyCity",   "JerseyCity",   "0906", "JERSEY CITY CITY"),
    "Kearny":       Muni("Kearny",       "Kearny",       "0907", "KEARNY TOWN"),
    "NorthBergen":  Muni("NorthBergen",  "NorthBergen",  "0908", "NORTH BERGEN TWP"),
    "Secaucus":     Muni("Secaucus",     "Secaucus",     "0909", "SECAUCUS TOWN"),
    "UnionCity":    Muni("UnionCity",    "UnionCity",    "0910", "UNION CITY CITY"),
    "Weehawken":    Muni("Weehawken",    "Weehawken",    "0911", "WEEHAWKEN TWP"),
    "WestNewYork":  Muni("WestNewYork",  "WestNewYork",  "0912", "WEST NEW YORK TOWN"),
}


def get_muni(name: str) -> Muni:
    if name not in MUNIS:
        raise ValueError(f"Unknown muni: {name!r}. Known: {sorted(MUNIS)}")
    return MUNIS[name]


def cache_dir(muni: str) -> Path:
    return CACHE_ROOT / muni


def accounts_index(muni: str) -> Path:
    return DATA / f"accounts_index.{muni}.parquet"


def taxes_parquet(muni: str) -> Path:
    return DATA / f"taxes.{muni}.parquet"


# Back-compat aliases — JC-only legacy paths used by older callers.
CACHE = cache_dir("JerseyCity")
ACCOUNTS_INDEX = accounts_index("JerseyCity")
TAXES = taxes_parquet("JerseyCity")


def ensure_dirs():
    """Create required directories if they don't exist."""
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
