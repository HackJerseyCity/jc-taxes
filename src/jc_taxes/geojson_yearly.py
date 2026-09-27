#!/usr/bin/env python3
"""Generate year-specific GeoJSON files showing taxes paid per parcel."""
import gzip
import json
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
import shapely.wkb
import shapely.ops
from pyproj import Transformer
from utz import err


def _iter_cache_jsons(cache_dir: Path):
    """Yield parsed JSON dicts from cached account files (.json or .json.gz)."""
    paths = list(cache_dir.glob("*.json")) + list(cache_dir.glob("*.json.gz"))
    for path in paths:
        try:
            if path.suffixes[-2:] == [".json", ".gz"]:
                with gzip.open(path, "rt") as f:
                    yield json.load(f)
            else:
                with open(path) as f:
                    yield json.load(f)
        except Exception:
            continue

from .building_desc import parse_building_desc
from .census import load_jc_census_blocks, load_jc_neighborhoods, load_jc_wards
from .coastline import clip_parcel
from .paths import CACHE, DATA, PARCELS, PARCELS_COMBINED

# Transformers for different CRS scenarios
wgs84_to_njsp = Transformer.from_crs("EPSG:4326", "EPSG:3424", always_xy=True)
njsp_to_wgs84 = Transformer.from_crs("EPSG:3424", "EPSG:4326", always_xy=True)


@lru_cache(maxsize=None)
def load_owners(cache_dir: Path = CACHE) -> tuple[dict[str, str], dict[str, str]]:
    """Load property owners from cached account JSON files.

    Returns:
        (lot_owners, unit_owners) where:
        - lot_owners: "block-lot" → owner name (from base record, i.e. no qualifier;
          this is the building owner or HOA for condos)
        - unit_owners: "block-lot-qual" → owner name (individual unit owners)
    """
    lot_owners: dict[str, str] = {}
    unit_owners: dict[str, str] = {}
    for data in _iter_cache_jsons(cache_dir):
        acct = data.get("accountInquiryVM", {})
        block = str(acct.get("Block", "")).strip()
        lot = str(acct.get("Lot", "")).strip()
        qual = str(acct.get("Qualifier", "")).strip()
        owner = str(acct.get("OwnerName", "")).strip()
        if not (block and lot and owner):
            continue
        lot_key = f"{block}-{lot}"
        if not qual:
            # Base record: building-level owner or HOA
            lot_owners[lot_key] = owner
        else:
            unit_key = f"{block}-{lot}-{qual}"
            unit_owners[unit_key] = owner
            # Also set lot owner if no base record exists and all units share owner
            if lot_key not in lot_owners:
                lot_owners[lot_key] = owner
            elif lot_owners[lot_key] != owner:
                # Multiple different owners → mark as multi-owner (condo)
                # Keep the first one (base record will overwrite if it exists)
                pass
    return lot_owners, unit_owners


@lru_cache(maxsize=None)
def load_addresses(cache_dir: Path = CACHE) -> dict[str, str]:
    """Load property addresses from cached account JSON files.

    Returns:
        dict mapping "block-lot" to PropertyLocation address string
    """
    addresses = {}
    for data in _iter_cache_jsons(cache_dir):
        acct = data.get("accountInquiryVM", {})
        block = str(acct.get("Block", "")).strip()
        lot = str(acct.get("Lot", "")).strip()
        prop_loc = acct.get("PropertyLocation", "")
        if block and lot and prop_loc:
            key = f"{block}-{lot}"
            if key not in addresses:
                addresses[key] = prop_loc.strip()
    return addresses


@lru_cache(maxsize=None)
def load_building_info(data_dir: Path = DATA) -> dict[str, dict]:
    """Load building info from taxrecords_enriched.parquet.

    Returns dict mapping "block-lot" → {stories, units, yr_built, bldg_sqft, bldg_desc}.
    For lots with multiple records (condos), takes the base record (no qualifier)
    or the first record with building info.
    """
    path = data_dir / "taxrecords_enriched.parquet"
    if not path.exists():
        err(f"Warning: {path} not found, skipping building info")
        return {}

    df = pd.read_parquet(path, columns=[
        "Block", "Lot", "Qual", "Building Desc", "Sq. Ft.", "Yr. Built",
    ])
    info: dict[str, dict] = {}
    for _, row in df.iterrows():
        block = str(row["Block"]).strip()
        lot = str(row["Lot"]).strip()
        qual = str(row.get("Qual", "")).strip() if pd.notna(row.get("Qual")) else ""
        key = f"{block}-{lot}"

        # Prefer base record (no qualifier); skip if we already have one
        if key in info and qual:
            continue

        bldg_desc = row["Building Desc"] if pd.notna(row["Building Desc"]) else None
        parsed = parse_building_desc(bldg_desc)

        yr_str = row["Yr. Built"] if pd.notna(row["Yr. Built"]) else None
        yr_built = None
        if yr_str:
            try:
                yr_val = int(float(str(yr_str)))
                if yr_val >= 1700:
                    yr_built = yr_val
            except (ValueError, TypeError):
                pass

        sqft = row["Sq. Ft."] if pd.notna(row["Sq. Ft."]) else None
        bldg_sqft = int(sqft) if sqft and sqft > 0 else None

        entry = {}
        if parsed["stories"] is not None:
            entry["stories"] = parsed["stories"]
        if parsed["units"] is not None:
            entry["units"] = parsed["units"]
        if yr_built:
            entry["yr_built"] = yr_built
        if bldg_sqft:
            entry["bldg_sqft"] = bldg_sqft
        if bldg_desc:
            entry["bldg_desc"] = bldg_desc

        if entry:
            info[key] = entry

    return info


@lru_cache(maxsize=None)
def load_improved_lots(data_dir: Path = DATA) -> set[str]:
    """"block-lot" keys with any building assessment (exempt from the coastline clip)."""
    df = pd.read_parquet(data_dir / "taxrecords_enriched.parquet", columns=["join_key", "bldg_assmnt"])
    return set(df.loc[df["bldg_assmnt"].fillna(0) > 0, "join_key"].astype(str))


def tag_regions(features: list[dict]) -> None:
    """Set `ward` and `hood` (neighborhood) on each feature, by its representative point.

    Features whose point falls outside every polygon (e.g. slivers past a boundary's
    shoreline) are left untagged.
    """
    pts = [shapely.geometry.shape(f["geometry"]).representative_point() for f in features]
    for gdf, col in ((load_jc_wards(), "ward"), (load_jc_neighborhoods(), "hood")):
        tree = shapely.STRtree(gdf.geometry.values)
        names = gdf[col].tolist()
        pt_idx, poly_idx = tree.query(pts, predicate="within")
        tagged: set[int] = set()
        for i, j in zip(pt_idx, poly_idx):
            if i in tagged:
                continue
            tagged.add(i)
            features[i]["properties"][col] = names[j]
        err(f"  Tagged {len(tagged):,}/{len(features):,} features with `{col}`")


def load_unit_sqft(data_dir: Path = DATA) -> dict[str, int]:
    """Load per-unit square footage from taxrecords_enriched.parquet.

    Returns dict mapping "block-lot-qual" → sqft (interior area from tax records).
    """
    path = data_dir / "taxrecords_enriched.parquet"
    if not path.exists():
        return {}

    df = pd.read_parquet(path, columns=["Block", "Lot", "Qual", "Sq. Ft."])
    result: dict[str, int] = {}
    for _, row in df.iterrows():
        qual = str(row.get("Qual", "")).strip() if pd.notna(row.get("Qual")) else ""
        if not qual:
            continue
        sqft = row["Sq. Ft."] if pd.notna(row["Sq. Ft."]) else None
        if not sqft or sqft <= 0:
            continue
        key = f"{str(row['Block']).strip()}-{str(row['Lot']).strip()}-{qual}"
        result[key] = int(sqft)
    return result


def normalize_street(s: str) -> str:
    """Normalize street name variants (AVENUE→AVE, STREET→ST, etc.)."""
    s = re.sub(r"\s*\(.*\)$", "", s)  # Remove parenthetical notes like (INSD)
    s = s.rstrip(".")
    s = re.sub(r"\bSTREET$", "ST", s)
    s = re.sub(r"\bAVENUE$", "AVE", s)
    s = re.sub(r"\bROAD$", "RD", s)
    s = re.sub(r"\bDRIVE$", "DR", s)
    s = re.sub(r"\bPLACE$", "PL", s)
    s = re.sub(r"\bBOULEVARD$", "BLVD", s)
    s = re.sub(r"\bLANE$", "LN", s)
    s = re.sub(r"\bCOURT$", "CT", s)
    s = re.sub(r"\bTERRACE$", "TER", s)
    return s.strip()


def summarize_block_streets(addresses: dict[str, str]) -> dict[str, str]:
    """Build a street summary per block from lot-level addresses.

    Returns:
        dict mapping block number to summary like "HOPKINS AVE 147-179 / ST PAULS AVE 144-174"
    """
    block_addrs: dict[str, list[str]] = defaultdict(list)
    for key, addr in addresses.items():
        block = key.split("-")[0]
        block_addrs[block].append(addr)

    summaries = {}
    for block, addrs in block_addrs.items():
        streets: dict[str, list[int]] = defaultdict(list)
        for addr in addrs:
            m = re.match(r"(\d+)\s+(.+)", addr)
            if m:
                num = int(m.group(1))
                street = normalize_street(m.group(2))
                streets[street].append(num)
        parts = []
        for street in sorted(streets, key=lambda s: -len(streets[s])):
            nums = sorted(streets[street])
            if nums:
                parts.append(f"{street} {min(nums)}-{max(nums)}")
            if len(parts) >= 3:
                break
        if parts:
            summaries[block] = " / ".join(parts)
    return summaries


# Known omnibus payments: qualifier-X payments that cover multiple adjacent lots.
# Block 18702 Lot 29 (Qual X, "106 Harmon St") is a single payment for the
# Salem Lafayette urban renewal complex spanning lots 27, 28, 29.
OMNIBUS_LOT_GROUPS = [
    {"source": "18702-29", "lots": ["18702-27", "18702-28", "18702-29"]},
]

def _parent_lot(lot: str) -> str:
    """Strip a trailing sub-lot suffix: '3.17' -> '3', '55.01' -> '55', '6' -> '6'."""
    return lot.rsplit(".", 1)[0] if "." in lot else lot


def fold_orphan_payments(pay_dict: dict, present: list[tuple]) -> dict:
    """Fold payments whose join_key has no parcel geometry onto a same-block sink.

    Orphan block-lots (e.g. Newport tower sub-lots that exist in `payments.parquet`
    but not the parcel snapshot) would otherwise be silently DROPPED from lot/unit
    views. Each orphan's Paid/Billed is added onto the best available present key in
    the same block, preferring, in order:
     -1. a commercial-condo qualifier alias: tax account `C8nnn` ↔ geometry `C0nnn`
         (same lot), when that geometry key has no payments of its own,
      0. a present key with the exact same (block, lot) — a sibling unit/qualifier,
      1. the exact parent lot (trailing `.NN` stripped),
      2. a sibling lot sharing the integer lot prefix,
      3. the largest-area present lot anywhere in the block.

    Args:
        pay_dict: join_key -> {"Paid":, "Billed":}. Mutated in place: orphan amounts
            are ADDED onto sink keys. Orphan entries themselves are left as-is (they
            are never read without geometry, so leaving them causes no double count).
        present: list of (join_key, block, lot, area_sqft) for keys that HAVE geometry.

    Returns:
        {"folded": n, "folded_amt": $, "dropped": n, "dropped_amt": $}
    """
    present_keys = {p[0] for p in present}
    by_block: dict[str, list[tuple]] = defaultdict(list)       # block -> [(key, area)]
    by_block_lot: dict[tuple, list[tuple]] = defaultdict(list)  # (block,lot) -> [(key, area)]
    for key, block, lot, area in present:
        by_block[block].append((key, area))
        by_block_lot[(block, lot)].append((key, area))

    def _pick(candidates: list[tuple]) -> str | None:
        return max(candidates, key=lambda ka: ka[1])[0] if candidates else None

    # Keys with their own payments, before any folding mutates `pay_dict`.
    paid_keys = {
        k for k, v in pay_dict.items()
        if float(v.get("Paid", 0) or 0) or float(v.get("Billed", 0) or 0)
    }

    def _qual_alias(key: str) -> str | None:
        parts = key.split("-")
        if len(parts) != 3:
            return None
        m = re.fullmatch(r"C8(\d{3})", parts[2])
        if not m:
            return None
        alias = f"{parts[0]}-{parts[1]}-C0{m.group(1)}"
        return alias if alias in present_keys and alias not in paid_keys else None

    folded = dropped = 0
    folded_amt = dropped_amt = 0.0
    for key in list(pay_dict.keys()):
        if key in present_keys:
            continue
        parts = key.split("-")
        block, lot = parts[0], parts[1] if len(parts) > 1 else ""
        paid = float(pay_dict[key].get("Paid", 0) or 0)
        billed = float(pay_dict[key].get("Billed", 0) or 0)
        if paid == 0 and billed == 0:
            continue
        parent = _parent_lot(lot)
        prefix = lot.split(".")[0]
        sink = (
            _qual_alias(key)
            or _pick(by_block_lot.get((block, lot), []))
            or (_pick(by_block_lot.get((block, parent), [])) if parent != lot else None)
            or _pick([(k, a) for k, a in by_block.get(block, []) if k.split("-")[1].split(".")[0] == prefix])
            or _pick(by_block.get(block, []))
        )
        if sink is None:
            dropped += 1
            dropped_amt += paid
            continue
        bucket = pay_dict.setdefault(sink, {"Paid": 0.0, "Billed": 0.0})
        bucket["Paid"] = float(bucket.get("Paid", 0) or 0) + paid
        bucket["Billed"] = float(bucket.get("Billed", 0) or 0) + billed
        folded += 1
        folded_amt += paid
    return {"folded": folded, "folded_amt": folded_amt, "dropped": dropped, "dropped_amt": dropped_amt}


AGGREGATE_CHOICES = ["block", "census-block", "lot", "unit", "ward"]
SUFFIX_MAP = {
    "unit": "-units",
    "block": "-blocks",
    "lot": "-lots",
    "census-block": "-census-blocks",
    "ward": "-wards",
}


def generate_yearly_geojson(
    year: int,
    output_dir: Path | None = None,
    aggregate: str = "lot",
) -> dict:
    """
    Generate GeoJSON for a specific tax year showing payments.

    Args:
        year: Tax year to visualize
        output_dir: Output directory (default: www/public/)
        aggregate: "block", "census-block", "lot", "unit", or "ward"

    Returns:
        GeoJSON FeatureCollection dict
    """
    if output_dir is None:
        output_dir = DATA.parent / "www" / "public"
    output_dir.mkdir(parents=True, exist_ok=True)

    payments_path = DATA / "payments.parquet"
    if not payments_path.exists():
        err(f"Payments file not found: {payments_path}")
        err("Run: python -m jc_taxes.payments")
        return {}

    # Load data - prefer combined parcels if available
    parcels_path = PARCELS_COMBINED if PARCELS_COMBINED.exists() else PARCELS
    err(f"Loading parcels from {parcels_path}")
    parcels = pd.read_parquet(parcels_path)
    if "years" in parcels.columns:
        # Year-aware parcel sets (`jct parcels combine`): the lots on this year's roll.
        parcels = parcels[parcels["years"].map(lambda ys: year in set(ys))].drop(columns="years").reset_index(drop=True)
        err(f"  {len(parcels):,} parcels active in {year}")

    err(f"Loading payments for year {year}")
    payments = pd.read_parquet(payments_path)
    payments = payments[payments["Year"] == year]
    err(f"  {len(payments):,} payment records for {year}")

    # Load addresses and owners from cached accounts
    err("Loading addresses and owners from cache...")
    addresses = load_addresses()
    lot_owners, unit_owners = load_owners()
    err(f"  {len(addresses):,} addresses, {len(lot_owners):,} lot owners, {len(unit_owners):,} unit owners loaded")

    # Load building info from enriched tax records
    err("Loading building info from enriched tax records...")
    building_info = load_building_info()
    improved_lots = load_improved_lots()
    unit_sqft = load_unit_sqft()
    err(f"  {len(building_info):,} lots with building info, {len(unit_sqft):,} units with sqft")

    # Build block-level street summaries
    block_streets = summarize_block_streets(addresses)

    # Census-block and ward aggregation: area-weighted lot → census block allocation
    if aggregate in ("census-block", "ward"):
        return _generate_census_geojson(
            year=year,
            aggregate=aggregate,
            parcels=parcels,
            payments=payments,
            output_dir=output_dir,
        )

    # Create join keys based on aggregation level
    if aggregate == "unit":
        # Join on block-lot-qualifier for individual unit payments
        parcels["join_key"] = (
            parcels["block"].str.strip() + "-" +
            parcels["lot"].str.strip() + "-" +
            parcels["qual"].fillna("").str.strip()
        )
        payments["join_key"] = (
            payments["Block"].str.strip() + "-" +
            payments["Lot"].str.strip() + "-" +
            payments["Qualifier"].fillna("").str.strip()
        )
        # For address lookup, use block-lot key
        parcels["addr_key"] = parcels["block"].str.strip() + "-" + parcels["lot"].str.strip()
    elif aggregate == "block":
        # Join on block only for block-level aggregation
        parcels["join_key"] = parcels["block"].str.strip()
        payments["join_key"] = payments["Block"].str.strip()
        parcels["addr_key"] = parcels["join_key"]
    else:
        # Join on block-lot for lot-level aggregation
        parcels["join_key"] = parcels["block"].str.strip() + "-" + parcels["lot"].str.strip()
        payments["join_key"] = payments["Block"].str.strip() + "-" + payments["Lot"].str.strip()
        parcels["addr_key"] = parcels["join_key"]

    # Aggregate payments
    pay_agg = payments.groupby("join_key").agg({
        "Billed": "sum",
        "Paid": "sum",
    }).reset_index()
    pay_dict = pay_agg.set_index("join_key").to_dict("index")

    # Redistribute omnibus payments across their lot groups
    if aggregate == "lot":
        for group in OMNIBUS_LOT_GROUPS:
            src = group["source"]
            if src not in pay_dict:
                continue
            paid = pay_dict[src]["Paid"]
            billed = pay_dict[src]["Billed"]
            lots = group["lots"]
            n = len(lots)
            for key in lots:
                if key not in pay_dict:
                    pay_dict[key] = {"Paid": 0.0, "Billed": 0.0}
            # Split evenly (lots are similar size)
            for key in lots:
                pay_dict[key]["Paid"] = paid / n
                pay_dict[key]["Billed"] = billed / n
            err(f"  Redistributed {src} (${paid:,.0f}) across {n} lots: {lots}")

    def clean_val(v):
        return None if pd.isna(v) else v

    def is_njsp(geom) -> bool:
        """Check if geometry is in NJ State Plane (large coordinate values)."""
        bounds = geom.bounds  # (minx, miny, maxx, maxy)
        # NJSP coordinates are typically 400k-700k for x, 0-900k for y
        # WGS84 for NJ is around -75 to -74 for x, 39-41 for y
        return bounds[0] > 1000  # Simple heuristic: x > 1000 means projected

    def get_geometry(row):
        """Extract geometry from row, handling both old and new parcel formats."""
        geom = None
        # Try 'geometry' column first (combined parcels from geopandas)
        g = row.get("geometry")
        if g is not None and not pd.isna(g):
            if isinstance(g, bytes):
                geom = shapely.wkb.loads(g)
            elif hasattr(g, 'geom_type'):  # Already a shapely object
                geom = g
        # Fall back to 'geo_shape' (old JC parcels format)
        if geom is None:
            geo_shape = row.get("geo_shape")
            if geo_shape is not None and not pd.isna(geo_shape):
                if isinstance(geo_shape, bytes):
                    geom = shapely.wkb.loads(geo_shape)
                elif isinstance(geo_shape, str):
                    geom = shapely.geometry.shape(json.loads(geo_shape))
        return geom

    def to_wgs84(geom):
        return shapely.ops.transform(njsp_to_wgs84.transform, geom) if is_njsp(geom) else geom

    def lot_improved(row) -> bool:
        return f"{str(row.get('block', '')).strip()}-{str(row.get('lot', '')).strip()}" in improved_lots

    def process_geometry(geom, improved: bool | None):
        """Convert geometry to WGS84, clip to land, and calculate area in sqft.

        Coastline clip (Mode B, see `clip_parcel`): the geometry is cropped to the
        land mask before `area_sqft` is computed, so both the rendered polygon and
        $/sqft exclude underwater area. `improved=None` means the caller already
        clipped (per lot, before dissolving).
        """
        if geom is None:
            return None, None, 0.0

        geom_wgs84 = to_wgs84(geom)
        if improved is not None:
            geom_wgs84 = clip_parcel(geom_wgs84, improved)
        if geom_wgs84 is None or geom_wgs84.is_empty:
            return None, None, 0.0

        projected = shapely.ops.transform(wgs84_to_njsp.transform, geom_wgs84)
        area_sqft = projected.area
        geojson = json.loads(shapely.to_geojson(geom_wgs84))

        return geojson, geom_wgs84, area_sqft

    features = []

    if aggregate == "unit":
        # Unit-level: one feature per parcel row with individual payments.
        err("Generating unit-level features...")
        # Pass 1: clip + measure geometry for every parcel row.
        processed = []       # (row, geometry, area_sqft)
        present: list[tuple] = []  # (join_key, block, lot, area) for orphan folding
        for _, row in parcels.iterrows():
            geom = get_geometry(row)
            if geom is None:
                continue
            try:
                geometry, _, area_sqft = process_geometry(geom, lot_improved(row))
                if geometry is None:
                    continue
            except Exception:
                continue
            key = row["join_key"]
            block = str(row.get("block", "")).strip()
            lot = str(row.get("lot", "")).strip()
            processed.append((row, geometry, area_sqft))
            present.append((key, block, lot, area_sqft))

        # Fold orphan payments (block-lot-qual in payments but not in geometry).
        stats = fold_orphan_payments(pay_dict, present)
        err(f"  Orphan payments folded: {stats['folded']} keys "
            f"(${stats['folded_amt']:,.0f} paid); dropped: {stats['dropped']} keys "
            f"(${stats['dropped_amt']:,.0f} paid)")

        # Pass 2: emit features.
        for row, geometry, area_sqft in processed:
            key = row["join_key"]
            addr_key = row["addr_key"]
            pay_data = pay_dict.get(key, {})
            paid = float(pay_data.get("Paid", 0) or 0)
            billed = float(pay_data.get("Billed", 0) or 0)

            paid_per_sqft = paid / area_sqft if area_sqft > 0 else 0.0
            billed_per_sqft = billed / area_sqft if area_sqft > 0 else 0.0

            qual_str = str(row.get("qual", "")).strip() if pd.notna(row.get("qual")) else ""
            owner = unit_owners.get(key) if qual_str else lot_owners.get(addr_key)
            properties = {
                "block": str(row.get("block", "")).strip(),
                "lot": str(row.get("lot", "")).strip(),
                "qual": clean_val(row.get("qual")),
                "year": year,
                "paid": round(paid, 2),
                "billed": round(billed, 2),
                "area_sqft": round(area_sqft, 1),
                "paid_per_sqft": round(paid_per_sqft, 2),
                "billed_per_sqft": round(billed_per_sqft, 2),
            }
            true_sqft = unit_sqft.get(key)
            if true_sqft:
                properties["unit_sqft"] = true_sqft
            addr = addresses.get(addr_key)
            if addr:
                properties["addr"] = addr
            if owner:
                properties["owner"] = owner
            bldg = building_info.get(addr_key)
            if bldg:
                properties.update(bldg)
            features.append({"type": "Feature", "geometry": geometry, "properties": properties})
    else:
        # Lot-level or block-level: dissolve geometries
        level = "block" if aggregate == "block" else "lot"
        err(f"Aggregating geometries by {level}...")
        agg_geoms = {}   # join_key -> list of geometries
        agg_props = {}   # join_key -> {block, lot, addr_key}

        for _, row in parcels.iterrows():
            geom = get_geometry(row)
            if geom is None:
                continue

            key = row["join_key"]
            addr_key = row["addr_key"]
            if key not in agg_geoms:
                agg_geoms[key] = []
                agg_props[key] = {
                    "block": str(row.get("block", "")).strip(),
                    "lot": str(row.get("lot", "")).strip() if aggregate != "block" else None,
                    "addr_key": addr_key,
                }
            # Clip per lot before dissolving, so a block keeps its piers (improved
            # lots) while shedding underwater riparian lots.
            try:
                clipped = clip_parcel(to_wgs84(geom), lot_improved(row))
            except Exception:
                continue
            if clipped is not None and not clipped.is_empty:
                agg_geoms[key].append(clipped)

        err(f"Dissolving {len(agg_geoms)} {level}s...")
        # Pass 1: dissolve (members already clipped) + measure.
        processed: dict[str, tuple] = {}  # key -> (geometry, area_sqft)
        present = []                       # (join_key, block, lot, area)
        for key, geoms in agg_geoms.items():
            if not geoms:
                continue
            try:
                if len(geoms) == 1:
                    dissolved = geoms[0]
                else:
                    dissolved = shapely.ops.unary_union(geoms)
                geometry, _, area_sqft = process_geometry(dissolved, None)
                if geometry is None:
                    continue
            except Exception:
                continue
            processed[key] = (geometry, area_sqft)
            props = agg_props[key]
            present.append((key, props["block"], props["lot"] or "", area_sqft))

        # Fold orphan payments into parent/sibling/block lots. Lot view only: block
        # view's join_key IS the block, so it already sums every payment in a block.
        if aggregate == "lot":
            stats = fold_orphan_payments(pay_dict, present)
            err(f"  Orphan payments folded: {stats['folded']} keys "
                f"(${stats['folded_amt']:,.0f} paid); dropped: {stats['dropped']} keys "
                f"(${stats['dropped_amt']:,.0f} paid)")

        # Pass 2: emit features.
        for key, (geometry, area_sqft) in processed.items():
            pay_data = pay_dict.get(key, {})
            paid = float(pay_data.get("Paid", 0) or 0)
            billed = float(pay_data.get("Billed", 0) or 0)
            paid_per_sqft = paid / area_sqft if area_sqft > 0 else 0.0
            billed_per_sqft = billed / area_sqft if area_sqft > 0 else 0.0

            props = agg_props[key]
            addr_key = props["addr_key"]
            block_num = props["block"]
            properties = {
                "block": block_num,
                "lot": props["lot"],
                "year": year,
                "paid": round(paid, 2),
                "billed": round(billed, 2),
                "area_sqft": round(area_sqft, 1),
                "paid_per_sqft": round(paid_per_sqft, 2),
                "billed_per_sqft": round(billed_per_sqft, 2),
            }
            addr = addresses.get(addr_key)
            if addr:
                properties["addr"] = addr
            if aggregate == "lot":
                owner = lot_owners.get(key)
                if owner:
                    properties["owner"] = owner
                bldg = building_info.get(key)
                if bldg:
                    properties.update(bldg)
            if aggregate == "block":
                streets = block_streets.get(block_num)
                if streets:
                    properties["streets"] = streets
            features.append({"type": "Feature", "geometry": geometry, "properties": properties})

    err(f"Generated {len(features)} features")
    tag_regions(features)

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    suffix = SUFFIX_MAP.get(aggregate, "-lots")
    output = output_dir / f"taxes-{year}{suffix}.geojson"
    with open(output, "w") as f:
        json.dump(geojson, f)
    err(f"Wrote {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")

    return geojson


def _build_lot_gdf(
    parcels: pd.DataFrame,
    payments: pd.DataFrame,
    improved_lots: set[str],
) -> gpd.GeoDataFrame:
    """Build lot-level GeoDataFrame in WGS84 with aggregated payments.

    Dissolves condo units into lots, converts all geometries to WGS84.
    Returns GeoDataFrame with columns: join_key, paid, billed, geometry (WGS84)
    """
    # Lot-level join key
    parcels = parcels.copy()
    parcels["join_key"] = parcels["block"].str.strip() + "-" + parcels["lot"].str.strip()
    payments = payments.copy()
    payments["join_key"] = payments["Block"].str.strip() + "-" + payments["Lot"].str.strip()

    pay_agg = payments.groupby("join_key").agg({"Billed": "sum", "Paid": "sum"}).reset_index()
    pay_dict = pay_agg.set_index("join_key").to_dict("index")

    # Redistribute omnibus payments across their lot groups
    for group in OMNIBUS_LOT_GROUPS:
        src = group["source"]
        if src not in pay_dict:
            continue
        paid = pay_dict[src]["Paid"]
        billed = pay_dict[src]["Billed"]
        lots = group["lots"]
        n = len(lots)
        for key in lots:
            if key not in pay_dict:
                pay_dict[key] = {"Paid": 0.0, "Billed": 0.0}
        for key in lots:
            pay_dict[key]["Paid"] = paid / n
            pay_dict[key]["Billed"] = billed / n

    # Collect geometries per lot, dissolve, convert to WGS84
    lot_geoms: dict[str, list] = defaultdict(list)
    for _, row in parcels.iterrows():
        geom = None
        g = row.get("geometry")
        if g is not None and not pd.isna(g):
            if isinstance(g, bytes):
                geom = shapely.wkb.loads(g)
            elif hasattr(g, "geom_type"):
                geom = g
        if geom is None:
            geo_shape = row.get("geo_shape")
            if geo_shape is not None and not pd.isna(geo_shape):
                if isinstance(geo_shape, bytes):
                    geom = shapely.wkb.loads(geo_shape)
                elif isinstance(geo_shape, str):
                    geom = shapely.geometry.shape(json.loads(geo_shape))
        if geom is not None:
            lot_geoms[row["join_key"]].append(geom)

    # Dissolve each lot, convert to WGS84, and clip to land (coastline crop).
    geoms_wgs84: dict[str, shapely.Geometry] = {}
    present: list[tuple] = []  # (join_key, block, lot, area) for orphan folding
    for key, geoms in lot_geoms.items():
        try:
            dissolved = geoms[0] if len(geoms) == 1 else shapely.ops.unary_union(geoms)
            if dissolved.bounds[0] > 1000:
                dissolved = shapely.ops.transform(njsp_to_wgs84.transform, dissolved)
            dissolved = clip_parcel(dissolved, key in improved_lots)
            if dissolved is None or dissolved.is_empty:
                continue
        except Exception:
            continue
        geoms_wgs84[key] = dissolved
        block, _, lot = key.partition("-")
        present.append((key, block, lot, dissolved.area))  # degree-area OK for local sink ranking

    # Fold orphan payments (sub-lots in payments but not geometry) onto parent/
    # sibling/block lots so census/ward allocations don't drop them either.
    stats = fold_orphan_payments(pay_dict, present)
    err(f"  Orphan payments folded: {stats['folded']} keys "
        f"(${stats['folded_amt']:,.0f} paid); dropped: {stats['dropped']} keys "
        f"(${stats['dropped_amt']:,.0f} paid)")

    rows = []
    for key, dissolved in geoms_wgs84.items():
        pay = pay_dict.get(key, {})
        rows.append({
            "join_key": key,
            "paid": float(pay.get("Paid", 0) or 0),
            "billed": float(pay.get("Billed", 0) or 0),
            "geometry": dissolved,
        })

    gdf = gpd.GeoDataFrame(rows, crs="EPSG:4326")
    err(f"Built {len(gdf)} lot geometries in WGS84")
    return gdf


_MIN_HOLE_SQFT = 200_000  # ~5 acres; keeps LSP, reservoir, large parks

def _remove_small_holes(geom):
    """Remove interior holes smaller than threshold from polygon/multipolygon."""
    from shapely.geometry import Polygon, MultiPolygon
    if geom is None or geom.is_empty:
        return geom
    if geom.geom_type == 'Polygon':
        kept = [r for r in geom.interiors if Polygon(r).area >= _MIN_HOLE_SQFT]
        return Polygon(geom.exterior, kept)
    if geom.geom_type == 'MultiPolygon':
        return MultiPolygon([_remove_small_holes(p) for p in geom.geoms])
    return geom


def _generate_census_geojson(
    year: int,
    aggregate: str,
    parcels: pd.DataFrame,
    payments: pd.DataFrame,
    output_dir: Path,
) -> dict:
    """Generate census-block or ward level GeoJSON via area-weighted allocation."""
    lot_gdf = _build_lot_gdf(parcels, payments, load_improved_lots())
    cb_gdf = load_jc_census_blocks()

    # Project to NJSP for accurate area computation
    lot_proj = lot_gdf.to_crs("EPSG:3424")
    cb_proj = cb_gdf.to_crs("EPSG:3424")

    lot_proj["lot_area"] = lot_proj.geometry.area

    err("Computing lot × census-block overlay...")
    overlay = gpd.overlay(lot_proj, cb_proj, how="intersection")
    overlay["intersection_area"] = overlay.geometry.area
    overlay["weight"] = overlay["intersection_area"] / overlay["lot_area"]
    overlay["w_paid"] = overlay["paid"] * overlay["weight"]
    overlay["w_billed"] = overlay["billed"] * overlay["weight"]

    err(f"  {len(overlay)} intersection fragments from {len(lot_proj)} lots × {len(cb_proj)} census blocks")

    # Aggregate to census-block level
    cb_agg = overlay.groupby("GEOID").agg({
        "w_paid": "sum",
        "w_billed": "sum",
    }).rename(columns={"w_paid": "paid", "w_billed": "billed"})

    # Merge back census block attributes and geometry (WGS84)
    cb_result = cb_gdf.set_index("GEOID").join(cb_agg, how="left").reset_index()
    cb_result["paid"] = cb_result["paid"].fillna(0)
    cb_result["billed"] = cb_result["billed"].fillna(0)

    # Compute area from tax-paying lots only (excludes parks, state land, water, etc.)
    paying_overlay = overlay[overlay["paid"] > 0]
    cb_lot_area = paying_overlay.groupby("GEOID")["intersection_area"].sum().reset_index()
    cb_lot_area = cb_lot_area.rename(columns={"intersection_area": "area_sqft"})
    cb_result = cb_result.merge(cb_lot_area, on="GEOID", how="left")
    cb_result["area_sqft"] = cb_result["area_sqft"].fillna(0)

    cb_result["paid_per_sqft"] = cb_result.apply(
        lambda r: r["paid"] / r["area_sqft"] if r["area_sqft"] > 0 else 0, axis=1
    )
    cb_result["billed_per_sqft"] = cb_result.apply(
        lambda r: r["billed"] / r["area_sqft"] if r["area_sqft"] > 0 else 0, axis=1
    )
    cb_result["paid_per_capita"] = cb_result.apply(
        lambda r: r["paid"] / r["POP100"] if r["POP100"] > 0 else None, axis=1
    )
    cb_result["billed_per_capita"] = cb_result.apply(
        lambda r: r["billed"] / r["POP100"] if r["POP100"] > 0 else None, axis=1
    )

    # Build trimmed geometries from tax-paying lot fragments
    # Dissolve in projected CRS (NJSP) for accurate simplification, then convert to WGS84
    err("Building trimmed geometries from tax-paying lots...")
    paying_proj = paying_overlay.copy()  # already in EPSG:3424
    cb_trimmed_proj = paying_proj.dissolve(by="GEOID").geometry
    # Simplify: 5ft tolerance ≈ invisible at map zoom levels, big vertex reduction
    cb_trimmed_proj = cb_trimmed_proj.simplify(5)
    cb_trimmed = cb_trimmed_proj.to_crs("EPSG:4326") if hasattr(cb_trimmed_proj, 'to_crs') else gpd.GeoSeries(cb_trimmed_proj, crs="EPSG:3424").to_crs("EPSG:4326")
    # Build per-ward lot-fragment geometry (paying lots dissolved per ward)
    err("Building ward lot-fragment geometries...")
    paying_proj_ward = paying_overlay.copy()
    paying_proj_ward["ward"] = paying_proj_ward["GEOID"].map(
        cb_result.set_index("GEOID")["ward"]
    )
    ward_lots_proj = paying_proj_ward.dissolve(by="ward").geometry.simplify(5)
    ward_lots = gpd.GeoSeries(ward_lots_proj, crs="EPSG:3424").to_crs("EPSG:4326")

    # Build per-ward block-level geometry (lots dissolved per block, collected per ward)
    err("Building ward block-level geometries...")
    paying_proj_ward["block_num"] = paying_proj_ward["join_key"].str.split("-").str[0]
    block_dissolved = paying_proj_ward.dissolve(by=["ward", "block_num"]).geometry.simplify(5)
    from shapely.geometry import MultiPolygon as ShapelyMultiPolygon
    ward_blocks_dict: dict[str, shapely.Geometry] = {}
    for ward_name, group in block_dissolved.groupby(level="ward"):
        polys = []
        for geom in group.values:
            if geom.geom_type == 'Polygon':
                polys.append(geom)
            elif geom.geom_type == 'MultiPolygon':
                polys.extend(geom.geoms)
        ward_blocks_dict[ward_name] = ShapelyMultiPolygon(polys) if polys else None
    ward_blocks = gpd.GeoSeries(ward_blocks_dict, crs="EPSG:3424").to_crs("EPSG:4326")

    # Build per-ward merged boundary: buffer-dissolve ALL lots (not just paid)
    # to create cohesive ward shapes that excise large parks, LSP, water
    err("Building ward merged boundaries from buffered lot geometries...")
    all_overlay_ward = overlay.copy()
    all_overlay_ward["ward"] = all_overlay_ward["GEOID"].map(
        cb_result.set_index("GEOID")["ward"]
    )
    # 50ft buffer bridges typical JC street widths (40-60ft curb-to-curb)
    all_overlay_ward["geometry"] = all_overlay_ward.geometry.buffer(50)
    ward_buffered = all_overlay_ward.dissolve(by="ward").geometry
    # Negative buffer restores outer boundary, simplify to reduce vertices
    ward_merged_proj = ward_buffered.buffer(-50).simplify(10)
    # Remove small interior holes (< 200,000 sqft / ~5 acres) to avoid swiss-cheese
    ward_merged_proj = ward_merged_proj.apply(_remove_small_holes)
    ward_merged = gpd.GeoSeries(ward_merged_proj, crs="EPSG:3424").to_crs("EPSG:4326")

    if aggregate == "ward":
        return _aggregate_to_wards(year, cb_result, ward_merged, ward_lots, ward_blocks, output_dir)

    # census-block output
    features = []
    for _, row in cb_result.iterrows():
        geoid = row["GEOID"]
        geom = cb_trimmed.get(geoid, row.geometry)
        if geom is None or geom.is_empty:
            geom = row.geometry
        geojson_geom = json.loads(shapely.to_geojson(geom))
        props = {
            "geoid": geoid,
            "ward": row["ward"],
            "year": year,
            "paid": round(row["paid"], 2),
            "billed": round(row["billed"], 2),
            "area_sqft": round(row["area_sqft"], 1),
            "paid_per_sqft": round(row["paid_per_sqft"], 2),
            "billed_per_sqft": round(row["billed_per_sqft"], 2),
            "population": int(row["POP100"]),
            "paid_per_capita": round(row["paid_per_capita"], 2) if pd.notna(row["paid_per_capita"]) else None,
            "billed_per_capita": round(row["billed_per_capita"], 2) if pd.notna(row["billed_per_capita"]) else None,
        }
        features.append({"type": "Feature", "geometry": geojson_geom, "properties": props})

    err(f"Generated {len(features)} census-block features")
    return _write_geojson(features, year, "census-block", output_dir)


def _aggregate_to_wards(
    year: int,
    cb_result: gpd.GeoDataFrame,
    ward_merged: gpd.GeoSeries,
    ward_lots: gpd.GeoSeries,
    ward_blocks: gpd.GeoSeries,
    output_dir: Path,
) -> dict:
    """Aggregate census-block results to ward level."""
    wards_gdf = load_jc_wards()

    ward_agg = cb_result.groupby("ward").agg({
        "paid": "sum",
        "billed": "sum",
        "POP100": "sum",
        "area_sqft": "sum",
    }).rename(columns={"POP100": "population"})

    ward_result = wards_gdf.set_index("ward").join(ward_agg, how="left").reset_index()
    ward_result["paid"] = ward_result["paid"].fillna(0)
    ward_result["billed"] = ward_result["billed"].fillna(0)
    ward_result["population"] = ward_result["population"].fillna(0).astype(int)
    ward_result["area_sqft"] = ward_result["area_sqft"].fillna(0)

    ward_result["paid_per_sqft"] = ward_result.apply(
        lambda r: r["paid"] / r["area_sqft"] if r["area_sqft"] > 0 else 0, axis=1
    )
    ward_result["billed_per_sqft"] = ward_result.apply(
        lambda r: r["billed"] / r["area_sqft"] if r["area_sqft"] > 0 else 0, axis=1
    )
    ward_result["paid_per_capita"] = ward_result.apply(
        lambda r: r["paid"] / r["population"] if r["population"] > 0 else None, axis=1
    )
    ward_result["billed_per_capita"] = ward_result.apply(
        lambda r: r["billed"] / r["population"] if r["population"] > 0 else None, axis=1
    )

    features = []
    for _, row in ward_result.iterrows():
        ward = row["ward"]
        merged = ward_merged.get(ward)
        geom = merged if merged is not None and not merged.is_empty else row.geometry
        geojson_geom = json.loads(shapely.to_geojson(geom))
        props = {
            "ward": ward,
            "council_person": row["council_person"],
            "year": year,
            "paid": round(row["paid"], 2),
            "billed": round(row["billed"], 2),
            "area_sqft": round(row["area_sqft"], 1),
            "paid_per_sqft": round(row["paid_per_sqft"], 2),
            "billed_per_sqft": round(row["billed_per_sqft"], 2),
            "population": int(row["population"]),
            "paid_per_capita": round(row["paid_per_capita"], 2) if pd.notna(row["paid_per_capita"]) else None,
            "billed_per_capita": round(row["billed_per_capita"], 2) if pd.notna(row["billed_per_capita"]) else None,
        }
        # Alternate geometry options for frontend toggle
        lots = ward_lots.get(ward)
        if lots is not None and not lots.is_empty:
            props["lots"] = json.loads(shapely.to_geojson(lots))
        blocks = ward_blocks.get(ward)
        if blocks is not None and not blocks.is_empty:
            props["blocks"] = json.loads(shapely.to_geojson(blocks))
        props["boundary"] = json.loads(shapely.to_geojson(row.geometry))
        features.append({"type": "Feature", "geometry": geojson_geom, "properties": props})

    err(f"Generated {len(features)} ward features")
    return _write_geojson(features, year, "ward", output_dir)


def _write_geojson(features: list, year: int, aggregate: str, output_dir: Path) -> dict:
    """Write GeoJSON FeatureCollection to disk."""
    geojson = {"type": "FeatureCollection", "features": features}
    suffix = SUFFIX_MAP.get(aggregate, "-lots")
    output = output_dir / f"taxes-{year}{suffix}.geojson"
    with open(output, "w") as f:
        json.dump(geojson, f)
    err(f"Wrote {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")
    return geojson


if __name__ == "__main__":
    import click

    @click.command()
    @click.option("-a", "--aggregate", default="lot", type=click.Choice(AGGREGATE_CHOICES), help="Aggregation level")
    @click.option("-o", "--output-dir", type=Path, help="Output directory")
    @click.option("-y", "--year", default=2024, help="Tax year")
    def main(aggregate: str, output_dir: Path | None, year: int):
        """Generate yearly GeoJSON for tax visualization."""
        generate_yearly_geojson(year, output_dir, aggregate)

    main()
