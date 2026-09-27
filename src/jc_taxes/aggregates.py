"""Per (view × focus × year) totals and height-scale maxima → D1 `aggregates`.

The app's totals chip, sparkline, and cross-year height scale previously
required the client to load every year's GeoJSON and sum / scan it. This
computes them once, from the same GeoJSON the app renders, with the app's
semantics (mirrored here; see the comments naming each TS counterpart), and
loads them into the `jct` D1 database, which the `jct-edge` Worker serves at
`/api/summary`.

Portfolio membership comes from the DVC-tracked `portfolios.json` (never
committed), so the generated SQL goes to `tmp/` and is applied with
`wrangler d1 execute`, not committed either.
"""
import json
import subprocess
from pathlib import Path

import click
from utz import err

from .paths import ROOT
from .stats import AGG_SUFFIX, DEFAULT_PORTFOLIOS, _load_geojson, _load_portfolios

YEARS = list(range(2015, 2027))
# Years shown by amount billed (payments still coming in): `BILLED_YEARS` in MapView.tsx.
BILLED_YEARS = {2026}
# `MIN_SCALE_AREA_SQFT` in MapView.tsx.
MIN_SCALE_AREA_SQFT = 500
BLOCK_GRANULAR = {"block", "ward", "census-block"}
WARDS = list("ABCDEF")
EDGE = ROOT / "edge"
DEFAULT_SQL = ROOT / "tmp" / "aggregates.sql"


def portfolio_predicate(p: dict, block_granular: bool):
    """`portfolioPredicate` in portfolios.ts."""
    blocks = set(p.get("blocks") or [])
    parcels = set(p.get("parcels") or [])
    parcel_blocks = {pid.split("-")[0] for pid in parcels}
    if block_granular:
        return lambda pr: _s(pr, "block") in blocks or _s(pr, "block") in parcel_blocks

    def test(pr):
        block, lot, qual = _s(pr, "block"), _s(pr, "lot"), _s(pr, "qual")
        return block in blocks or f"{block}-{lot}" in parcels or (bool(qual) and f"{block}-{lot}-{qual}" in parcels)
    return test


def prop_equals(k: str, v: str):
    """`regionTest` in regions.ts."""
    return lambda pr: pr.get(k) == v


def _s(pr: dict, k: str) -> str:
    v = pr.get(k)
    return "" if v is None else str(v)


def _metric(pr: dict, field: str, billed: bool) -> float:
    """`metricValue` in MapView.tsx (billed field for billed-basis years)."""
    if billed:
        field = {"paid_per_sqft": "billed_per_sqft", "paid_per_capita": "billed_per_capita", "paid": "billed"}[field]
    return pr.get(field) or 0


def view_rows(view: str, year: int, features: list[dict], focuses: dict) -> list[tuple]:
    billed = year in BILLED_YEARS
    has_capita = view in ("ward", "census-block")
    rows = []
    for focus, test in focuses.items():
        count = 0
        paid = bil = 0.0
        mx_sqft = mx_total = mx_capita = 0.0
        for f in features:
            pr = f["properties"]
            if test is not None and not test(pr):
                continue
            count += 1
            paid += pr.get("paid") or 0
            bil += pr.get("billed") or 0
            # `scalesHeight` in MapView.tsx: per-sqft ignores slivers.
            if (pr.get("area_sqft") or 0) >= MIN_SCALE_AREA_SQFT:
                mx_sqft = max(mx_sqft, _metric(pr, "paid_per_sqft", billed))
            mx_total = max(mx_total, _metric(pr, "paid", billed))
            if has_capita:
                mx_capita = max(mx_capita, _metric(pr, "paid_per_capita", billed))
        if count == 0:
            continue
        rows.append((
            view, focus, year, count, round(bil if billed else paid, 2), round(paid, 2), round(bil, 2),
            round(mx_sqft, 4) or None, round(mx_total, 2) or None, (round(mx_capita, 4) or None) if has_capita else None,
        ))
    return rows


def _sql_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return repr(v)


@click.command()
@click.option("-c", "--cache-dir", type=click.Path(file_okay=False, path_type=Path), help="Cache GeoJSON not checked out locally (see `jct stats`).")
@click.option("-d", "--db", default="jct", show_default=True, help="D1 database name.")
@click.option("-l", "--local", is_flag=True, help="Apply to the local (wrangler dev) D1 instead of remote.")
@click.option("-n", "--dry-run", is_flag=True, help="Write the SQL but don't apply it.")
@click.option("-o", "--out", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_SQL, show_default=True, help="Generated SQL (kept out of git: embeds portfolio totals).")
@click.option("-p", "--portfolios", "portfolios_path", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_PORTFOLIOS, show_default=True, help="portfolios.json (curated list).")
@click.option("-v", "--view", "views", multiple=True, type=click.Choice(list(AGG_SUFFIX)), help="Only these views (default: all). Other views' rows are kept.")
def aggregates(cache_dir: Path | None, db: str, local: bool, dry_run: bool, out: Path, portfolios_path: Path, views: tuple[str, ...]):
    """Compute view × focus × year totals / maxima and load them into D1."""
    portfolios = _load_portfolios(portfolios_path)
    views = views or tuple(AGG_SUFFIX)
    stmts = []
    total = 0
    for view in views:
        bg = view in BLOCK_GRANULAR
        fixed = {"": None}
        fixed.update({f"pf:{p['key']}": portfolio_predicate(p, bg) for p in portfolios})
        fixed.update({f"ward:{w}": prop_equals("ward", w) for w in WARDS})
        stmts.append(f"DELETE FROM aggregates WHERE view = {_sql_value(view)};")
        for year in YEARS:
            feats = _load_geojson(view, year, cache_dir, force=False)["features"]
            hoods = sorted({f["properties"].get("hood") for f in feats} - {None, ""})
            focuses = {**fixed, **{f"hood:{h}": prop_equals("hood", h) for h in hoods}}
            rows = view_rows(view, year, feats, focuses)
            total += len(rows)
            err(f"{view} {year}: {len(feats)} features, {len(rows)} rows")
            for r in rows:
                stmts.append(
                    "INSERT INTO aggregates (view, focus, year, count, amount, paid, billed, max_per_sqft, max_total, max_per_capita) "
                    f"VALUES ({', '.join(_sql_value(v) for v in r)});"
                )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(stmts) + "\n")
    err(f"wrote {out}: {total} rows")
    if dry_run:
        return
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", db, "--local" if local else "--remote", "--file", str(out), "-y"],
        cwd=EDGE, check=True,
    )


if __name__ == "__main__":
    aggregates()
