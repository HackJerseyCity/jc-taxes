"""Per-view geometry + all-years values bundles for the map (block / lot / unit).

Each year's `taxes-{year}-{view}.geojson` repeats the same geometry and fixed
properties; only the amounts change (and, for lots / units, the owner). The app
instead loads, once per view:

- `geom-{view}.geojson`: geometry + fixed properties (latest year's values),
  minus the per-year amounts and owner.
- `values-{view}.json`: `{years, count, paid, billed_minus_paid}`, integer cents
  per `[year][feature]` aligned to the geometry's feature order. Billed is stored
  as its difference from paid (mostly 0, so it compresses ~40% better). Derived metrics
  (`paid_per_sqft`, …) are recomputed client-side, as the pipeline does.

so switching years or playing every year downloads nothing more. Owners go to
the D1 `owners` table (run-length by year), fetched per parcel on hover /
select via `/api/parcel`. Wards and census blocks keep per-year GeoJSON: their
geometry is trimmed to each year's tax-paying lots, and they're small.

Outputs are DVC data (`dvx add` + `dvc push`, then served by the Worker's `/d`);
the owners SQL goes to `tmp/` (not committed).
"""
import json
import subprocess
from pathlib import Path

import click
from utz import err

from .aggregates import YEARS
from .paths import ROOT
from .stats import WWW_PUBLIC, _load_geojson

VIEWS = {"block": "blocks", "lot": "lots", "unit": "units"}
DYNAMIC = {"paid", "billed", "paid_per_sqft", "billed_per_sqft", "paid_per_capita", "billed_per_capita", "year"}
PER_YEAR_DETAILS = {"owner"}
EDGE = ROOT / "edge"
DEFAULT_SQL = ROOT / "tmp" / "owners.sql"


def feature_id(pr: dict) -> str:
    """`featureIdOf` in MapView.tsx (block / lot / unit views)."""
    return "-".join(str(pr.get(k) or "") for k in ("block", "lot", "qual")).rstrip("-")


def keyed(features: list[dict]) -> list[tuple[str, int]]:
    """(id, occurrence) per feature: ids are unique but for a stray duplicate,
    which pairs up across years by order of appearance."""
    seen: dict[str, int] = {}
    out = []
    for f in features:
        i = feature_id(f["properties"])
        n = seen.get(i, 0)
        seen[i] = n + 1
        out.append((i, n))
    return out


def run_length(by_year: dict[int, str | None]) -> list[list]:
    out: list[list] = []
    for y in sorted(by_year):
        v = by_year[y]
        if not out or out[-1][1] != v:
            out.append([y, v])
    return [e for e in out if e[1] is not None] if any(e[1] is not None for e in out) else []


def build(view: str, per_year: dict[int, list[dict]]) -> tuple[dict, dict, dict[str, list]]:
    """(geom FeatureCollection, values, owners by id) for one view."""
    latest = per_year[max(per_year)]
    order = keyed(latest)
    index = {k: i for i, k in enumerate(order)}
    n = len(order)
    geom = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": f["geometry"],
                "properties": {k: v for k, v in f["properties"].items() if k not in DYNAMIC and k not in PER_YEAR_DETAILS},
            }
            for f in latest
        ],
    }
    years = sorted(per_year)
    paid, billed = [], []
    owners: dict[str, dict[int, str | None]] = {}
    for y in years:
        feats = per_year[y]
        ks = keyed(feats)
        if set(ks) != set(order):
            raise ValueError(f"{view} {y}: feature ids differ from {max(per_year)}")
        p, b = [0] * n, [0] * n
        for k, f in zip(ks, feats):
            pr = f["properties"]
            i = index[k]
            p[i] = round((pr.get("paid") or 0) * 100)
            b[i] = round((pr.get("billed") or 0) * 100)
            if "owner" in pr and k[1] == 0:
                owners.setdefault(k[0], {})[y] = pr.get("owner")
        paid.append(p)
        billed.append([bi - pi for pi, bi in zip(p, b)])
    values = {"years": years, "count": n, "paid": paid, "billed_minus_paid": billed}
    return geom, values, {i: run_length(by) for i, by in owners.items()}


def _sql(v) -> str:
    return "'" + str(v).replace("'", "''") + "'"


@click.command()
@click.option("-c", "--cache-dir", type=click.Path(file_okay=False, path_type=Path), help="Cache GeoJSON not checked out locally (see `jct stats`).")
@click.option("-d", "--db", default="jct", show_default=True, help="D1 database name.")
@click.option("-l", "--local", is_flag=True, help="Apply owners to the local (wrangler dev) D1 instead of remote.")
@click.option("-n", "--dry-run", is_flag=True, help="Write files + SQL, but don't load D1.")
@click.option("-o", "--out-dir", type=click.Path(file_okay=False, path_type=Path), default=WWW_PUBLIC, show_default=True, help="Where to write geom-*/values-* (DVC-tracked).")
@click.option("-v", "--view", "views", multiple=True, type=click.Choice(list(VIEWS)), help="Only these views (default: all).")
def bundle(cache_dir: Path | None, db: str, local: bool, dry_run: bool, out_dir: Path, views: tuple[str, ...]):
    """Write per-view geometry + all-years values; load owner history into D1."""
    stmts = []
    for view in views or tuple(VIEWS):
        suffix = VIEWS[view]
        per_year = {y: _load_geojson(view, y, cache_dir, force=False)["features"] for y in YEARS}
        geom, values, owners = build(view, per_year)
        for name, obj in ((f"geom-{suffix}.geojson", geom), (f"values-{suffix}.json", values)):
            path = out_dir / name
            path.write_text(json.dumps(obj, separators=(",", ":")) + "\n")
            err(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")
        if owners:
            stmts.append(f"DELETE FROM owners WHERE view = {_sql(view)};")
            stmts += [
                f"INSERT INTO owners (view, id, owners) VALUES ({_sql(view)}, {_sql(i)}, {_sql(json.dumps(o, separators=(',', ':')))});"
                for i, o in owners.items() if o
            ]
    if not stmts:
        return
    DEFAULT_SQL.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_SQL.write_text("\n".join(stmts) + "\n")
    err(f"wrote {DEFAULT_SQL} ({len(stmts)} statements)")
    if dry_run:
        return
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", db, "--local" if local else "--remote", "--file", str(DEFAULT_SQL), "-y"],
        cwd=EDGE, check=True,
    )


if __name__ == "__main__":
    bundle()
