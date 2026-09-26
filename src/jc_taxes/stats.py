"""Precompute compact per-view stats for the edge OG-card renderer.

The map's on-screen summary sums `paid` (and counts features) over the GeoJSON
loaded for the current view — a different set per aggregation×year, since
coverage varies (block view is fullest; lot/unit drop parcels lacking
geometry). Reproducing that at the edge would mean the Worker parsing 20-40 MB
of GeoJSON per crawl, so instead this build step aggregates all views ahead of
time into a compact `stats.json` the edge OG Worker reads.

Source GeoJSON is the DVC-tracked `www/public/taxes-{year}-{agg}.geojson`. If a
file isn't checked out locally it's fetched from the public R2 cache using the
md5 in its `.dvc` sidecar (free egress; same bytes the deployed app fetches).

Per-portfolio totals (for `?pf=` cards) are computed at parcel (lot)
granularity against the curated portfolio list in `portfolios.json` (the
DVC-tracked data file, NOT the app's `portfolios.ts`, which is mechanism-only).
Because portfolio labels/membership are deliberately kept out of git, the
generated `stats.json` — which embeds portfolio labels + totals — is likewise
NOT committed: `--upload` pushes it to the `jct-og` R2 bucket, where the Worker
reads it via its R2 binding.
"""
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import click
from utz import err

# Cloudflare's public R2 domain 403s the default `Python-urllib` UA; present a
# browser-like one (same bytes `curl`/the browser fetch).
_UA = "Mozilla/5.0 (jct-stats build step)"


def _fetch(url: str, tries: int = 4) -> bytes:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 503) and i < tries - 1:
                time.sleep(2 ** i)
                continue
            raise

from .paths import ROOT

PUBLIC_BASE = "https://data.jct.rbw.sh"
CACHE_PREFIX = ".dvc/cache/files/md5"
R2_ENDPOINT = "https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com"
R2_PROFILE = "cf"
OG_BUCKET = "jct-og"
STATS_KEY = "stats.json"

WWW_PUBLIC = ROOT / "www" / "public"
DEFAULT_PORTFOLIOS = WWW_PUBLIC / "portfolios.json"
DEFAULT_OUT = ROOT / "tmp" / "stats.json"

YEARS = list(range(2015, 2026))
# Map view aggregation → GeoJSON filename suffix (mirrors `SUFFIX_MAP` in
# `MapView.tsx`). Keys are the `?agg=` values the Worker normalizes to.
AGG_SUFFIX = {
    "block": "blocks",
    "lot": "lots",
    "unit": "units",
    "ward": "wards",
    "census-block": "census-blocks",
}


def _md5_from_dvc(dvc_path: Path) -> str:
    for line in dvc_path.read_text().splitlines():
        line = line.strip().lstrip("- ")
        if line.startswith("md5:"):
            return line.split(":", 1)[1].strip()
    raise ValueError(f"No md5 in {dvc_path}")


def _load_geojson(agg: str, year: int, cache_dir: Path | None, force: bool) -> dict:
    """Return the parsed GeoJSON for (agg, year), preferring a local checkout,
    else a cached download (when `cache_dir` is set), else a fresh fetch from
    the public R2 cache (parsed in memory, never written — the full set is
    ~700 MB, so caching is opt-in)."""
    suffix = AGG_SUFFIX[agg]
    name = f"taxes-{year}-{suffix}.geojson"
    local = WWW_PUBLIC / name
    if local.exists():
        return json.loads(local.read_text())

    if cache_dir is not None:
        cached = cache_dir / name
        if cached.exists() and not force:
            return json.loads(cached.read_text())

    md5 = _md5_from_dvc(WWW_PUBLIC / f"{name}.dvc")
    url = f"{PUBLIC_BASE}/{CACHE_PREFIX}/{md5[:2]}/{md5[2:]}"
    err(f"  fetch {name} ({md5[:8]}…)")
    data = _fetch(url)
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / name).write_bytes(data)
    return json.loads(data)


def _load_portfolios(path: Path) -> list[dict]:
    """Read the curated portfolio list from `path` (the DVC-tracked
    `portfolios.json` data file). If it isn't checked out locally, fetch it from
    the public R2 cache via its `.dvc` sidecar. Returns [] if neither exists
    (agg stats are still emitted; `?pf=` cards just fall back to defaults)."""
    if path.exists():
        return json.loads(path.read_text())
    dvc = path.with_suffix(path.suffix + ".dvc")
    if dvc.exists():
        md5 = _md5_from_dvc(dvc)
        url = f"{PUBLIC_BASE}/{CACHE_PREFIX}/{md5[:2]}/{md5[2:]}"
        err(f"  fetch {path.name} ({md5[:8]}…)")
        return json.loads(_fetch(url))
    err(f"  no portfolios source at {path} (or {dvc.name}); skipping portfolio stats")
    return []


def _portfolio_matcher(p: dict):
    """Parcel-granular membership predicate for a portfolio (mirrors
    `portfolioPredicate(p, blockGranular=false)` in `portfolios.ts`). `parcels`
    entries are `block-lot` (whole lot) or `block-lot-qual` (one unit of a lot
    shared with other owners)."""
    blocks = set(p.get("blocks") or [])
    parcels = set(p.get("parcels") or [])
    return lambda block, lot, qual: (
        block in blocks or f"{block}-{lot}" in parcels or (bool(qual) and f"{block}-{lot}-{qual}" in parcels)
    )


@click.command()
@click.option("-c", "--cache-dir", type=click.Path(file_okay=False, path_type=Path), help="Cache downloaded GeoJSON here (opt-in; the full set is ~700 MB). Without it, files are parsed in memory and discarded.")
@click.option("-f", "--force", is_flag=True, help="Re-download cached GeoJSON (only with --cache-dir).")
@click.option("-o", "--out", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_OUT, show_default=True, help="Output stats.json path (kept out of git; use --upload for the Worker).")
@click.option("-p", "--portfolios", "portfolios_path", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_PORTFOLIOS, show_default=True, help="portfolios.json (curated list) for per-portfolio totals.")
@click.option("-u", "--upload", is_flag=True, help=f"Upload result to the {OG_BUCKET} R2 bucket as {STATS_KEY} (via the `{R2_PROFILE}` AWS profile), where the edge Worker reads it.")
def stats(cache_dir: Path | None, force: bool, out: Path, portfolios_path: Path, upload: bool):
    """Aggregate per-view paid/count (+ per-portfolio) into a compact stats.json.

    Emits agg×year totals plus per-portfolio totals. Portfolio labels/membership
    are kept out of git, so the output is uploaded to R2 (`--upload`) rather than
    committed; the edge Worker reads it from the R2 binding.
    """
    portfolios = _load_portfolios(portfolios_path)
    matchers = {p["key"]: _portfolio_matcher(p) for p in portfolios}
    pf_totals = {
        p["key"]: {"label": p["label"], "years": {str(y): {"count": 0, "paid": 0.0} for y in YEARS}}
        for p in portfolios
    }

    aggs: dict[str, dict] = {agg: {} for agg in AGG_SUFFIX}
    for agg in AGG_SUFFIX:
        err(f"agg {agg}")
        for year in YEARS:
            gj = _load_geojson(agg, year, cache_dir, force)
            feats = gj["features"]
            count = len(feats)
            paid = 0.0
            billed = 0.0
            for f in feats:
                pr = f["properties"]
                paid += pr.get("paid") or 0
                billed += pr.get("billed") or 0
            aggs[agg][str(year)] = {
                "count": count,
                "paid": round(paid, 2),
                "billed": round(billed, 2),
            }
            # Portfolios are parcel (or unit) sets → compute against unit-level
            # features; `count` is distinct block-lots matched.
            if agg == "unit":
                ys = str(year)
                seen: dict[str, set] = {key: set() for key in matchers}
                for f in feats:
                    pr = f["properties"]
                    block = str(pr.get("block") or "")
                    lot = str(pr.get("lot") or "")
                    qual = str(pr.get("qual") or "")
                    for key, match in matchers.items():
                        if match(block, lot, qual):
                            tgt = pf_totals[key]["years"][ys]
                            seen[key].add(f"{block}-{lot}")
                            tgt["paid"] += pr.get("paid") or 0
                for key, lots in seen.items():
                    pf_totals[key]["years"][ys]["count"] = len(lots)

    for pf in pf_totals.values():
        for yv in pf["years"].values():
            yv["paid"] = round(yv["paid"], 2)

    result = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "years": YEARS,
        "latestYear": YEARS[-1],
        "aggs": aggs,
        "portfolios": pf_totals,
    }
    payload = json.dumps(result, indent=2) + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(payload)
    err(f"wrote {out} ({out.stat().st_size} bytes)")

    if upload:
        import boto3
        s3 = boto3.Session(profile_name=R2_PROFILE).client("s3", endpoint_url=R2_ENDPOINT)
        s3.put_object(
            Bucket=OG_BUCKET, Key=STATS_KEY,
            Body=payload.encode(), ContentType="application/json",
        )
        err(f"uploaded s3://{OG_BUCKET}/{STATS_KEY} ({len(payload)} bytes)")


if __name__ == "__main__":
    stats()
