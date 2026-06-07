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
