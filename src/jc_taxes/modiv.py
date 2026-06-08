"""Rutgers MOD-IV Historical Database bulk-pull.

The Rutgers map at https://modiv.rutgers.edu/map/ exposes two anonymous endpoints:

  - Per-county GeoJSON of block polygons:
      https://modiv.rutgers.edu/common_files/extra/json/{county}.json
    where `{county}` is one of `atlantic`, `bergen`, ..., `hudson`, ..., `warren`.

  - Per-block lot + tax-history JSON:
      https://modiv.rutgers.edu/api/v2/findByDbId/{MUN}_{BLOCK}/
    e.g. `0906_26001/` for Jersey City block 26001. Returns ~200KB JSON per block
    with `mod_iv_id`, `property_id_lot`, `property_class`, `property_location`,
    `building_description`, and `propertyTaxInfo` (historical tax records).

This module mirrors the cache layout used by `api.py` for HLS: per-record JSON
files gzip-compressed under `data/modiv/{muni}/`.

Usage:
    jct modiv pull-polygons -c hudson           # fetch the county polygons file
    jct modiv pull-blocks -m JerseyCity         # bulk-pull every JC block (~1239 reqs)
    jct modiv pull-blocks -m JerseyCity -l 5    # quick sanity-check on the first 5
"""
from __future__ import annotations

import gzip
import json
import random
import sys
import time
from pathlib import Path

import click
import httpx
from utz import err

from .paths import DATA, MUNIS, get_muni


MODIV_BASE = "https://modiv.rutgers.edu"
MODIV_ROOT = DATA / "modiv"

# Canonical NJ Treasury MOD-IV releases — same underlying data the Rutgers
# DB serves up, but as one zip per year (statewide, ~270MB each) instead of
# 1239 HTTP requests per muni. Years 2021-2025 are linked from
# https://www.nj.gov/treasury/taxation/lpt/statdata.shtml; earlier years
# may require a written request to the dept.
TREASURY_BASE = "https://www.nj.gov/treasury/taxation/pdf/lpt"
TREASURY_LAYOUT_URL = f"{TREASURY_BASE}/modivlayout.pdf"
TREASURY_ROOT = MODIV_ROOT / "treasury"

# County name → filename slug at /common_files/extra/json/{slug}.json
# (Lifted from `jsonFiles` at modiv.rutgers.edu/map/, line ~431.)
COUNTY_FILES = {
    "01": "atlantic", "02": "bergen", "03": "burlington", "04": "camden",
    "05": "cape_may", "06": "cumberland", "07": "essex", "08": "gloucester",
    "09": "hudson", "10": "hunterdon", "11": "mercer", "12": "middlesex",
    "13": "monmouth", "14": "morris", "15": "ocean", "16": "passaic",
    "17": "salem", "18": "somerset", "19": "sussex", "20": "union", "21": "warren",
}


def _county_for_muni(muni_code: str) -> str:
    """Hudson munis are 09xx → 'hudson'; first 2 chars of MUN code identify county."""
    return COUNTY_FILES[muni_code[:2]]


def county_polygons_path(county: str) -> Path:
    return MODIV_ROOT / f"{county}.json"


def block_cache_path(muni_name: str, db_id: str) -> Path:
    return MODIV_ROOT / muni_name / f"{db_id}.json.gz"


def _write_json_gz(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def fetch_county_polygons(county: str, *, force: bool = False, timeout: float = 60.0) -> Path:
    """Download a county's MOD-IV block polygons GeoJSON. Skips if cached unless `force`."""
    out = county_polygons_path(county)
    if out.exists() and not force:
        err(f"[modiv] {out.name} cached ({out.stat().st_size / 1e6:.1f}MB), skipping")
        return out
    url = f"{MODIV_BASE}/common_files/extra/json/{county}.json"
    err(f"[modiv] GET {url}")
    out.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=timeout) as client:
        resp = client.get(url)
        resp.raise_for_status()
        out.write_bytes(resp.content)
    err(f"[modiv] saved {out} ({out.stat().st_size / 1e6:.1f}MB)")
    return out


def iter_muni_block_ids(muni_name: str) -> list[str]:
    """Return the `MUN_BLOCK` ids for one muni, fetching the county GeoJSON if needed."""
    m = get_muni(muni_name)
    county = _county_for_muni(m.mun_code)
    poly = county_polygons_path(county)
    if not poly.exists():
        fetch_county_polygons(county)
    with poly.open() as f:
        gj = json.load(f)
    db_ids = []
    for feat in gj["features"]:
        p = feat.get("properties", {})
        if str(p.get("MUN", "")).zfill(4) == m.mun_code:
            db_id = p.get("DB_ID") or f"{m.mun_code}_{p.get('BLOCK')}"
            db_ids.append(db_id)
    # Stable order so resumed runs hit cache on the same prefix.
    return sorted(set(db_ids))


def fetch_block(
    db_id: str,
    muni_name: str,
    *,
    client: httpx.Client,
    force: bool = False,
) -> tuple[Path, bool]:
    """Fetch one block's MOD-IV detail. Returns (path, was_fetched)."""
    out = block_cache_path(muni_name, db_id)
    if out.exists() and not force:
        return out, False
    url = f"{MODIV_BASE}/api/v2/findByDbId/{db_id}/"
    resp = client.get(url)
    resp.raise_for_status()
    _write_json_gz(out, resp.json())
    return out, True


# --- Fixed-width MOD-IV record layout (NJ Treasury `modivlayout.pdf`) --------
#
# Records are 700 chars, CRLF-terminated. Positions below are 1-based,
# inclusive, matching the PDF's START/END columns. `kind` controls decoding:
#   str  — text; both-side stripped
#   int  — unsigned integer (`9(9)`/`X` numeric), whole dollars; left-justified
#          + right-space-padded in practice. blank → None
#   tax  — `S9(7)V99` signed money. Two encodings appear in the wild: zoned
#          (right-justified, overpunch sign on the last byte, e.g. `00000000{`)
#          and plain left-justified ASCII (e.g. `9300450  ` with trailing
#          spaces). `_decode_tax` handles both, returns dollars (÷100).
#   acre — `9(5)V9(4)` 9 digits, 4 implied decimals → acres (÷10000)
MODIV_FIELDS: list[tuple[str, int, int, str]] = [
    ("county_district",      1,   4,   "str"),
    ("block",                5,   13,  "str"),
    ("lot",                  14,  22,  "str"),
    ("qualifier",            23,  33,  "str"),
    ("record_id",            34,  35,  "str"),
    ("property_class",       56,  58,  "str"),
    ("property_location",    59,  83,  "str"),
    ("building_description", 84,  98,  "str"),
    ("land_description",     99,  118, "str"),
    ("calculated_acreage",   119, 127, "acre"),
    ("addition_lots1",       128, 147, "str"),
    ("addition_lots2",       148, 167, "str"),
    ("street_address",       211, 235, "str"),
    ("city_state",           236, 260, "str"),
    ("zip_code",             261, 269, "str"),
    ("year_constructed",     416, 419, "str"),
    ("land_value",           421, 429, "int"),
    ("improvement_value",    430, 438, "int"),
    ("net_value",            439, 447, "int"),
    ("old_property_id",      522, 550, "str"),
    ("census_tract",         551, 555, "str"),
    ("census_block",         556, 559, "str"),
    ("property_use_code",    560, 562, "str"),
    ("last_year_tax",        601, 609, "tax"),
    ("current_year_tax",     610, 618, "tax"),
]

# Zoned-decimal overpunch: last byte's zone nibble carries the sign.
_OVERPUNCH = {
    "{": ("0", False), "A": ("1", False), "B": ("2", False), "C": ("3", False),
    "D": ("4", False), "E": ("5", False), "F": ("6", False), "G": ("7", False),
    "H": ("8", False), "I": ("9", False),
    "}": ("0", True), "J": ("1", True), "K": ("2", True), "L": ("3", True),
    "M": ("4", True), "N": ("5", True), "O": ("6", True), "P": ("7", True),
    "Q": ("8", True), "R": ("9", True),
}


def _decode_tax(raw: str) -> float | None:
    """Decode an `S9(7)V99` money field to dollars. Handles zoned (overpunch
    sign on last byte) and plain left-justified ASCII. blank → None."""
    raw = raw.strip()
    if not raw:
        return None
    last = raw[-1]
    neg = False
    if last in _OVERPUNCH:
        digit, neg = _OVERPUNCH[last]
        digits = raw[:-1] + digit
    else:
        digits = raw
    if not digits.isdigit():
        return None
    val = int(digits) / 100.0
    return -val if neg else val


def _decode_int(raw: str) -> int | None:
    raw = raw.strip()
    if not raw:
        return None
    return int(raw) if raw.isdigit() else None


def _decode_acre(raw: str) -> float | None:
    raw = raw.strip()
    if not raw:
        return None
    return int(raw) / 10000.0 if raw.isdigit() else None


def norm_blq(block: str, lot: str, qualifier: str) -> str:
    """Normalize a Block-Lot-Qualifier key for joining MOD-IV (zero-padded,
    e.g. `02404`/`00022`) against HLS (unpadded, e.g. `2404`/`22`). Strips
    surrounding whitespace and leading zeros on block/lot."""
    b = str(block).strip().lstrip("0") or "0"
    l = str(lot).strip().lstrip("0") or "0"
    q = str(qualifier).strip()
    return f"{b}-{l}-{q}"


def parse_record(line: str) -> dict:
    """Slice one 700-char MOD-IV record into a field dict."""
    line = line.rstrip("\r\n").ljust(700)
    rec: dict = {}
    for name, start, end, kind in MODIV_FIELDS:
        raw = line[start - 1:end]
        if kind == "str":
            rec[name] = raw.strip()
        elif kind == "int":
            rec[name] = _decode_int(raw)
        elif kind == "tax":
            rec[name] = _decode_tax(raw)
        elif kind == "acre":
            rec[name] = _decode_acre(raw)
    rec["blq"] = f"{rec['block'].strip()}-{rec['lot'].strip()}-{rec['qualifier'].strip()}"
    return rec


@click.group()
def modiv():
    """Rutgers MOD-IV (modiv.rutgers.edu) bulk-pull commands."""
    pass


def _stream_download(url: str, out: Path, *, force: bool = False, timeout: float = 600.0) -> Path:
    """Stream a large file to disk with periodic progress lines."""
    if out.exists() and not force:
        err(f"[modiv] {out.name} cached ({out.stat().st_size / 1e6:.1f}MB), skipping")
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".partial")
    err(f"[modiv] GET {url}")
    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        n = 0
        next_log = 25_000_000  # every ~25MB
        with tmp.open("wb") as f:
            for chunk in resp.iter_bytes(chunk_size=1 << 20):
                f.write(chunk)
                n += len(chunk)
                if n >= next_log:
                    pct = f" ({n * 100 / total:.0f}%)" if total else ""
                    err(f"[modiv]   {n / 1e6:.0f}MB{pct}")
                    next_log += 25_000_000
    tmp.rename(out)
    err(f"[modiv] saved {out} ({out.stat().st_size / 1e6:.1f}MB)")
    return out


@modiv.command("pull-treasury")
@click.option("-y", "--year", "years", multiple=True, type=int,
              help="Year(s) to download. Repeatable. Defaults to 2021-2025 if omitted.")
@click.option("-f", "--force", is_flag=True, help="Re-download even if cached")
@click.option("-L", "--layout/--no-layout", default=True, show_default=True,
              help="Also fetch the modivlayout.pdf field reference")
@click.option("-x", "--extract", default="hudson*re.txt",
              help="Comma-separated case-insensitive globs matched against each "
                   "zip member's basename. Default catches Hudson county across "
                   "all the naming conventions used in 2021-2025 (`HudsonRE.txt`, "
                   "`Hudson23re.txt`, `Hudson 24re.txt`, …). "
                   'Pass "" to skip extraction, "*" for everything.')
def cmd_pull_treasury(years: tuple[int, ...], force: bool, layout: bool, extract: str):
    """Download annual NJ Treasury MOD-IV releases (modiv-YYYY.zip).

    Pulls one zip per year into `data/modiv/treasury/` and optionally
    extracts a subset of members (default: just `HudsonRE.txt`, the slice
    we actually use). Each zip is ~270MB statewide.
    """
    import fnmatch, subprocess, zipfile
    if not years:
        years = (2021, 2022, 2023, 2024, 2025)
    TREASURY_ROOT.mkdir(parents=True, exist_ok=True)
    if layout:
        _stream_download(TREASURY_LAYOUT_URL, TREASURY_ROOT / "modivlayout.pdf", force=force)
    patterns = [p for p in extract.split(",") if p] if extract else []
    for y in years:
        url = f"{TREASURY_BASE}/modiv-{y}.zip"
        zip_path = TREASURY_ROOT / f"modiv-{y}.zip"
        _stream_download(url, zip_path, force=force)
        if not patterns:
            continue
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
        lo_patterns = [p.lower() for p in patterns]
        members = [n for n in names if not n.endswith("/") and any(
            fnmatch.fnmatch(Path(n).name.lower(), p) for p in lo_patterns
        )]
        if not members:
            err(f"[modiv]   no zip members matched {patterns} (have: {names[:5]}...)")
            continue
        year_dir = TREASURY_ROOT / str(y)
        year_dir.mkdir(parents=True, exist_ok=True)
        # Shell out to `unzip` — Python's stdlib zipfile chokes on the
        # DEFLATE64-like compression Treasury uses for some years (2024).
        # `-j` flattens directory structure, `-o` overwrites if `--force`.
        for m in members:
            target = year_dir / Path(m).name
            if target.exists() and not force:
                continue
            args = ["unzip", "-j", "-o" if force else "-n", str(zip_path), m, "-d", str(year_dir)]
            subprocess.run(args, check=True, capture_output=True)
            err(f"[modiv]   extracted {m} → {target.relative_to(DATA.parent)} ({target.stat().st_size / 1e6:.1f}MB)")


@modiv.command("parse")
@click.option("-m", "--mun", default="all", show_default=True,
              help='County-district (MUN) code(s) to keep: "all" for every '
                   'district in the file (all of Hudson county), a single code '
                   'like "0906" (Jersey City), or a comma-separated list.')
@click.option("-o", "--out-dir", default=None,
              help="Output dir for {year}.parquet (default: data/modiv/treasury/)")
def cmd_parse(mun: str, out_dir: str):
    """Parse extracted MOD-IV `Hudson*re.txt` fixed-width files → parquet.

    Walks `data/modiv/treasury/*/Hudson*re.txt`, decodes each record per the
    `modivlayout.pdf` field offsets, filters to `--mun`, and writes one
    `{year}.parquet` per source year. The source year is the parent dir name.
    The `county_district` column is retained so downstream consumers can filter
    by municipality (e.g. JC = "0906").
    """
    import pandas as pd
    out_root = Path(out_dir) if out_dir else TREASURY_ROOT
    out_root.mkdir(parents=True, exist_ok=True)
    keep = None if mun.strip().lower() in ("", "all") else set(mun.split(","))
    txts = sorted(
        p for p in TREASURY_ROOT.glob("*/*")
        if p.is_file() and p.name.lower().startswith("hudson")
        and p.name.lower().endswith("re.txt")
    )
    if not txts:
        err(f"[modiv] no Hudson*re.txt under {TREASURY_ROOT}/*/ — run pull-treasury first")
        sys.exit(1)
    for txt in txts:
        year = txt.parent.name
        records = []
        kept = 0
        total = 0
        with txt.open(encoding="latin-1") as fh:
            for line in fh:
                if not line.rstrip("\r\n"):
                    continue
                total += 1
                if keep is not None and line[:4] not in keep:
                    continue
                rec = parse_record(line)
                rec["year"] = int(year)
                records.append(rec)
                kept += 1
        df = pd.DataFrame(records)
        out = out_root / f"{year}.parquet"
        df.to_parquet(out, index=False)
        err(f"[modiv] {txt.name}: {kept:,}/{total:,} records (MUN={mun}) "
            f"→ {out.relative_to(DATA.parent)} ({out.stat().st_size / 1e6:.1f}MB)")


# NJ property-class code → coarse group for homepage charts. Class 15* (all
# subclasses) is tax-exempt; everything unmapped (e.g. 5A/5B railroad, 6A/6B
# telecom) falls to "other".
_CLASS_GROUPS = {
    "1": "vacant",
    "2": "residential",
    "3A": "farm", "3B": "farm",
    "4A": "commercial",
    "4B": "industrial",
    "4C": "apartment",
}
_MUNI_SUFFIXES = {"CITY", "TOWN", "TWP", "TOWNSHIP", "BORO", "BOROUGH", "VILLAGE"}


def class_group(pc: str | None) -> str:
    """Map a raw `property_class` (e.g. "2", "4A", "15F") to a chart group."""
    if not pc:
        return "other"
    pc = pc.strip().upper()
    if pc.startswith("15"):
        return "exempt"
    return _CLASS_GROUPS.get(pc, "other")


def _muni_display(mun_name: str) -> str:
    """"JERSEY CITY CITY" → "Jersey City"; drop the trailing type suffix."""
    toks = mun_name.split()
    if len(toks) > 1 and toks[-1] in _MUNI_SUFFIXES:
        toks = toks[:-1]
    return " ".join(t.capitalize() for t in toks)


def _write_json(path: Path, df) -> None:
    """Write a DataFrame as pretty, diff-friendly records JSON (native types)."""
    recs = json.loads(df.to_json(orient="records"))
    path.write_text(json.dumps(recs, indent=2) + "\n")


@modiv.command("aggregate")
@click.option("-o", "--out-dir", default=None,
              help="Output dir for the JSON rollups (default: www/public/data/)")
@click.option("-t", "--treasury-dir", default=None,
              help="Dir of {year}.parquet (default: data/modiv/treasury/)")
def cmd_aggregate(out_dir: str, treasury_dir: str):
    """Emit small per-(year, muni) JSON rollups for the homepage charts.

    Reads the all-Hudson `{year}.parquet` files and writes three tiny JSON
    files the frontend loads directly (committed, not DVC-tracked):

    \b
    - `modiv_tax_base.json`          net/land/improvement value + parcels
    - `modiv_class_composition.json` parcels + net value by class group
    - `modiv_exempt_share.json`      exempt vs total net value + share
    """
    import pandas as pd
    troot = Path(treasury_dir) if treasury_dir else TREASURY_ROOT
    out = Path(out_dir) if out_dir else DATA.parent / "www" / "public" / "data"
    out.mkdir(parents=True, exist_ok=True)
    code_to_name = {m.mun_code: _muni_display(m.mun_name) for m in MUNIS.values()}
    frames = [pd.read_parquet(p) for p in sorted(troot.glob("[0-9][0-9][0-9][0-9].parquet"))]
    if not frames:
        err(f"[aggregate] no {{year}}.parquet under {troot} — run parse first")
        sys.exit(1)
    df = pd.concat(frames, ignore_index=True)
    df["mun"] = df.county_district
    df["name"] = df.mun.map(code_to_name)
    df["group"] = df.property_class.map(class_group)

    tb = (df.groupby(["year", "mun", "name"], as_index=False)
            .agg(parcels=("blq", "size"),
                 net_value=("net_value", "sum"),
                 land_value=("land_value", "sum"),
                 improvement_value=("improvement_value", "sum")))
    _write_json(out / "modiv_tax_base.json", tb)

    cc = (df.groupby(["year", "mun", "name", "group"], as_index=False)
            .agg(parcels=("blq", "size"), net_value=("net_value", "sum")))
    _write_json(out / "modiv_class_composition.json", cc)

    tot = tb[["year", "mun", "name", "net_value"]].rename(columns={"net_value": "total_value"})
    exm = (cc[cc.group == "exempt"].groupby(["year", "mun"], as_index=False)
             .agg(exempt_value=("net_value", "sum")))
    es = tot.merge(exm, on=["year", "mun"], how="left").fillna({"exempt_value": 0})
    es["exempt_value"] = es.exempt_value.astype(int)
    es["exempt_share"] = (es.exempt_value / es.total_value).round(4)
    _write_json(out / "modiv_exempt_share.json", es)

    err(f"[aggregate] {len(df):,} records → {out.relative_to(DATA.parent)}/modiv_*.json "
        f"({len(tb)} tax-base, {len(cc)} class, {len(es)} exempt rows)")


@modiv.command("crossval")
@click.option("-H", "--hls", "hls_path", default=None,
              help="HLS payments parquet (default: data/payments.parquet)")
@click.option("-m", "--mun", default="0906", show_default=True,
              help='County-district to compare (HLS payments are JC-only); '
                   '"all" to skip the filter.')
@click.option("-o", "--out-dir", default="tmp", show_default=True,
              help="Dir for per-year modiv-vs-hls-{tax_year}.parquet")
@click.option("-t", "--treasury-dir", default=None,
              help="Dir of {year}.parquet (default: data/modiv/treasury/)")
def cmd_crossval(hls_path: str, mun: str, out_dir: str, treasury_dir: str):
    """Cross-validate Treasury tax vs HLS Billed/Paid, per (BLQ, tax-year).

    The Treasury assessment file published in year Y carries the *prior*
    year's finalized tax in `last_year_tax` (current_year_tax is still 0/TBD
    when the file ships), so file-year Y maps to tax-year Y-1. Verified
    empirically: file-year Y `last_year_tax` matches HLS `Billed[Y-1]` ~80-85%
    exact, and HLS `Billed[Y]` ~0%.
    """
    import pandas as pd
    troot = Path(treasury_dir) if treasury_dir else TREASURY_ROOT
    hls_p = Path(hls_path) if hls_path else DATA / "payments.parquet"
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    hls = pd.read_parquet(hls_p)
    hls["key"] = [norm_blq(b, l, q) for b, l, q in zip(hls.Block, hls.Lot, hls.Qualifier)]
    err(f"[crossval] HLS: {len(hls):,} rows, years {hls.Year.min()}-{hls.Year.max()}")
    err(f"{'tax_yr':>6} {'common':>7} {'exact':>7} {'<$1':>6} {'<$10':>6} "
        f">{'$10':>5} {'t_only':>7} {'h_only':>7}")
    for tpath in sorted(troot.glob("[0-9][0-9][0-9][0-9].parquet")):
        fy = int(tpath.stem)
        tax_year = fy - 1
        t = pd.read_parquet(tpath)
        if mun.lower() != "all":
            t = t[t.county_district == mun]
        t = t[t.last_year_tax.notna()].copy()
        t["key"] = [norm_blq(b, l, q) for b, l, q in zip(t.block, t.lot, t.qualifier)]
        t = t.drop_duplicates("key")[["key", "blq", "last_year_tax"]]
        h = hls[hls.Year == tax_year].drop_duplicates("key")[["key", "Billed", "Paid"]]
        m = t.merge(h, on="key", how="outer", indicator=True)
        m["tax_year"] = tax_year
        m = m.rename(columns={"last_year_tax": "treasury_tax", "Billed": "hls_billed", "Paid": "hls_paid"})
        both = m["_merge"] == "both"
        diff = (m["treasury_tax"] - m["hls_billed"]).abs()
        m["diff_billed"] = diff
        # Categorize
        m["status"] = "missing"
        m.loc[m["_merge"] == "left_only", "status"] = "treasury_only"
        m.loc[m["_merge"] == "right_only", "status"] = "hls_only"
        m.loc[both & (diff < 0.005), "status"] = "exact"
        m.loc[both & (diff >= 0.005) & (diff < 1), "status"] = "under_1"
        m.loc[both & (diff >= 1) & (diff < 10), "status"] = "under_10"
        m.loc[both & (diff >= 10), "status"] = "over_10"
        m = m.drop(columns="_merge")
        dest = out / f"modiv-vs-hls-{tax_year}.parquet"
        m.to_parquet(dest, index=False)
        nb = both.sum()
        c = m["status"].value_counts()
        pct = lambda k: f"{100 * c.get(k, 0) / nb:.1f}%" if nb else "n/a"
        err(f"{tax_year:>6} {nb:>7,} {pct('exact'):>7} {pct('under_1'):>6} "
            f"{pct('under_10'):>6} {pct('over_10'):>6} "
            f"{c.get('treasury_only', 0):>7,} {c.get('hls_only', 0):>7,}")
    err(f"[crossval] wrote per-year comparisons → {out}/modiv-vs-hls-*.parquet")


def split_old_property_id(raw: str) -> tuple[str, str, str]:
    """`OLD-PROPERTY-ID` X(29) mirrors the PROPERTY-ID group: BLOCK X(9) +
    LOT X(9) + QUALIFIER X(11). Returns (block, lot, qualifier), each stripped."""
    raw = raw.ljust(29)
    return raw[0:9].strip(), raw[9:18].strip(), raw[18:29].strip()


@modiv.command("blq-history")
@click.option("-m", "--mun", default="0906", show_default=True,
              help='County-district to map; "all" for every district in the file.')
@click.option("-n", "--sample", default=20, show_default=True, help="Sample N (current, old) pairs to stderr")
@click.option("-o", "--out", default=None, help="Output parquet (default: data/modiv/blq_history.parquet)")
@click.option("-t", "--treasury-dir", default=None, help="Dir of {year}.parquet (default: data/modiv/treasury/)")
def cmd_blq_history(mun: str, sample: int, out: str, treasury_dir: str):
    """Build a cross-year BLQ-renumbering map from `old_property_id`.

    For each Treasury year, decodes `old_property_id` (the prior BLQ for
    renumbered lots) and writes the union of (year, current_blq, old_blq)
    tuples — the canonical answer to "what was this lot called before?".
    """
    import pandas as pd
    troot = Path(treasury_dir) if treasury_dir else TREASURY_ROOT
    dest = Path(out) if out else MODIV_ROOT / "blq_history.parquet"
    rows = []
    err(f"{'year':>4} {'records':>8} {'old_id_nonempty':>15} {'rate':>6} {'renumbered':>10}")
    for tpath in sorted(troot.glob("[0-9][0-9][0-9][0-9].parquet")):
        year = int(tpath.stem)
        t = pd.read_parquet(tpath)
        if mun.lower() != "all":
            t = t[t.county_district == mun]
        opid = t.old_property_id.fillna("").str.strip()
        nonempty = opid.str.len() > 0
        n_renum = 0
        for _, r in t[nonempty].iterrows():
            ob, ol, oq = split_old_property_id(r.old_property_id)
            old_blq = norm_blq(ob, ol, oq)
            cur_blq = norm_blq(r.block, r.lot, r.qualifier)
            renumbered = old_blq != cur_blq
            if renumbered:
                n_renum += 1
            rows.append({
                "year": year, "current_blq": cur_blq, "old_blq": old_blq,
                "renumbered": renumbered, "old_property_id": r.old_property_id.strip(),
            })
        rate = 100 * nonempty.mean()
        err(f"{year:>4} {len(t):>8,} {int(nonempty.sum()):>15,} {rate:>5.1f}% {n_renum:>10,}")
    df = pd.DataFrame(rows)
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(dest, index=False)
    err(f"[blq-history] {len(df):,} (year,current,old) tuples → {dest.relative_to(DATA.parent)}")
    renum = df[df.renumbered].drop_duplicates(["current_blq", "old_blq"])
    err(f"[blq-history] {len(renum):,} distinct renumbering pairs (current != old)")
    if sample:
        err(f"[blq-history] sample of {sample} renumbered (current_blq <- old_blq):")
        for _, r in renum.head(sample).iterrows():
            err(f"    {r.current_blq:24} <- {r.old_blq}")


@modiv.command("pull-polygons")
@click.option("-c", "--county", default="hudson", show_default=True,
              type=click.Choice(sorted(set(COUNTY_FILES.values()))),
              help="County name slug")
@click.option("-f", "--force", is_flag=True, help="Re-download even if cached")
def cmd_pull_polygons(county: str, force: bool):
    """Download a county's block-polygon GeoJSON."""
    fetch_county_polygons(county, force=force)


def _parse_rate(spec: str) -> tuple[float, float]:
    """Parse "MIN-MAX" or single "N" → (min, max) jitter window in seconds."""
    if "-" in spec:
        a, b = spec.split("-", 1)
        return float(a), float(b)
    v = float(spec)
    return v, v


@modiv.command("pull-blocks")
@click.option("-m", "--muni", type=click.Choice(sorted(MUNIS)), default="JerseyCity",
              show_default=True, help="Municipality")
@click.option("-r", "--rate", default="0.8-1.5", show_default=True,
              help='Jitter window between live requests, "MIN-MAX" seconds. '
                   "Polite default ≈ 1 req/sec; cached blocks incur no delay. "
                   'Pass "0" to disable (testing only — please be a good neighbor).')
@click.option("-l", "--limit", default=0, show_default=True, type=int,
              help="Stop after N live fetches (0 = no limit). Cached blocks don't count.")
@click.option("-f", "--force", is_flag=True, help="Re-fetch even cached blocks")
@click.option("-s", "--start-block", default="", help="Resume from this block id (e.g. 26001)")
def cmd_pull_blocks(muni: str, rate: str, limit: int, force: bool, start_block: str):
    """Bulk-pull every block's MOD-IV detail for a muni.

    Idempotent — already-cached blocks are skipped. Polite jittered delay
    between live requests; cache hits incur no delay.
    """
    m = get_muni(muni)
    min_delay, max_delay = _parse_rate(rate)
    db_ids = iter_muni_block_ids(muni)
    err(f"[modiv] {muni}: {len(db_ids)} blocks in county polygons file")
    if start_block:
        skip_to = f"{m.mun_code}_{start_block}"
        before = len(db_ids)
        db_ids = [d for d in db_ids if d >= skip_to]
        err(f"[modiv] resuming from {skip_to} ({before - len(db_ids)} skipped)")
    uncached = [d for d in db_ids if not block_cache_path(muni, d).exists()] if not force else db_ids
    avg = (min_delay + max_delay) / 2
    eta_min = len(uncached) * avg / 60
    err(f"[modiv] {len(uncached)} blocks need fetching @ {min_delay:.2f}-{max_delay:.2f}s "
        f"jitter → ~{eta_min:.1f} min wall-clock")
    fetched = 0
    cached = 0
    failed: list[tuple[str, str]] = []
    with httpx.Client(timeout=30.0) as client:
        for i, db_id in enumerate(db_ids, 1):
            try:
                _, was_fetched = fetch_block(db_id, muni, client=client, force=force)
            except httpx.HTTPError as e:
                failed.append((db_id, str(e)))
                err(f"[modiv]   {db_id} FAILED: {e}")
                continue
            if was_fetched:
                fetched += 1
                if max_delay > 0:
                    time.sleep(random.uniform(min_delay, max_delay))
            else:
                cached += 1
            if i % 50 == 0 or i == len(db_ids):
                err(f"[modiv]   {i}/{len(db_ids)} ({fetched} fetched, {cached} cached, {len(failed)} failed)")
            if limit and fetched >= limit:
                err(f"[modiv] hit --limit {limit}, stopping")
                break
    err(f"[modiv] done: {fetched} fetched, {cached} cached, {len(failed)} failed")
    if failed:
        for db, e in failed[:5]:
            err(f"[modiv]   first failure: {db} → {e}")
        sys.exit(1)
