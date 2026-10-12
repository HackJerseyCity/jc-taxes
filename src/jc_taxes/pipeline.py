"""The data pipeline as DVX stages: each output's `.dvc` records its `cmd`, the
data it was built from (`deps`, md5s) and the code (`git_deps`, blob / tree
SHAs), so `dvx status` says what's stale and `dvx run <target>` rebuilds it.

    HLS cache ─ packed records ─ payments ─┬─ combined parcels ─┐
    county parcels ────────────────────────┘   legacy parcels ──┤
    packed records, tax records, TIGER water, census ───────────┴─ taxes-{year}-{view}.geojson (×60)
        ├─ bundle: geom-* / values-* / ward-shapes-* (app data) + data/d1/parcels.sql
        └─ data/d1/aggregates.sql (+ portfolios.json)
    portfolios.json ─ data/d1/portfolios.sql
    side effects: R2 `br/<md5>` copies (deploy/r2-br), D1 loads (deploy/{dev,prod}/d1)

External inputs (the HLS cache, county parcel layer, tax-record snapshots, TIGER
water) are plain DVX-tracked leaves; their refresh commands are in
`specs/dvx-pipeline.md`.

`jct pipeline write` (re)writes every stage's `.dvc` provenance. Outputs'
recorded hashes are kept; only `meta.computation` changes.
"""
from os import chdir
from os.path import relpath
from pathlib import Path

import click
from utz import err

from .aggregates import YEARS
from .assessed import LATEST
from .bundle import ASSESSED_VIEWS, SMALL_VIEWS, VIEWS
from .paths import ROOT

PKG = "src/jc_taxes"

# External / manually-refreshed inputs (tracked, no computation).
CACHE = "data/cache"
COUNTY = "data/parcels/Hudson_County_Parcels_April_2026.geojson"
LEGACY = "data/parcels/legacy_combined.parquet"
ENRICHED = "data/taxrecords_enriched.parquet"
TIGER = "data/tiger/tl_2023_34017_areawater.zip"
PORTFOLIOS = "www/public/portfolios.json"
# Latest Treasury MOD-IV (`jct modiv pull-treasury -y Y` + `jct modiv parse`):
# lot / unit assessed values in the bundle.
MODIV = f"data/modiv/treasury/{LATEST}.parquet"
LEAVES = (CACHE, COUNTY, LEGACY, ENRICHED, TIGER, PORTFOLIOS, MODIV)

HLS = "data/hls/JerseyCity.parquet"
PAYMENTS = "data/payments.parquet"
COMBINED = "data/jc_parcels_combined.parquet"
D1_PARCELS = "data/d1/parcels.sql"
D1_AGGREGATES = "data/d1/aggregates.sql"
D1_PORTFOLIOS = "data/d1/portfolios.sql"


def stages():
    """Every computed Artifact (outputs + side effects), upstream first."""
    from dvx.run.artifact import Artifact, Computation

    def leaf(path: str) -> Artifact:
        return Artifact(path=path)

    def code(*mods: str) -> list[str]:
        return [f"{PKG}/{m}.py" for m in mods]

    cache, county, legacy, enriched, tiger, portfolios, modiv = map(leaf, LEAVES)
    # One object instead of ~70k per-account files, in a fixed order.
    hls = Artifact(HLS, Computation(
        cmd="python -m jc_taxes.cli hls pack",
        deps=[cache],
        git_deps=code("hls", "paths"),
    ))
    payments = Artifact(PAYMENTS, Computation(
        cmd="python -m jc_taxes.payments",
        deps=[hls],
        git_deps=code("payments", "hls", "paths"),
    ))
    combined = Artifact(COMBINED, Computation(
        # `dvx run` runs each cmd in its `.dvc`'s directory: paths are relative to it.
        cmd=f"python -m jc_taxes.cli parcels combine -c {relpath(COUNTY, Path(COMBINED).parent)}",
        deps=[county, legacy, payments],
        git_deps=code("parcels", "paths"),
    ))
    geojson = {
        (year, view): Artifact(f"www/public/taxes-{year}-{suffix}.geojson", Computation(
            cmd=f"python -m jc_taxes.geojson_yearly -y {year} -a {view}",
            deps=[combined, payments, enriched, hls, tiger],
            git_deps=[*code("geojson_yearly", "hls", "census", "coastline", "building_desc", "paths"), "census"],
        ))
        for view, suffix in VIEWS.items()
        for year in YEARS
    }
    by_view = {view: [geojson[(y, view)] for y in YEARS] for view in VIEWS}
    all_geojson = list(geojson.values())

    # `jct bundle` writes every view's files in one run: co-outputs share the
    # cmd; each depends only on its own view's GeoJSONs.
    bundle_cmd = "python -m jc_taxes.cli bundle -n"
    bundle_code = code("bundle", "stats", "paths", "assessed")

    def bundled(path: str, deps: list) -> Artifact:
        return Artifact(path, Computation(cmd=bundle_cmd, deps=deps, git_deps=bundle_code))

    bundle = []
    for view, suffix in VIEWS.items():
        deps = by_view[view]
        geom_deps = [*deps, modiv] if view in ASSESSED_VIEWS else deps
        bundle.append(bundled(f"www/public/geom-{suffix}.geojson", geom_deps))
        if view in SMALL_VIEWS:
            bundle += [bundled(f"www/public/values-{suffix}-{y}.json", deps) for y in YEARS]
            if view == "ward":
                bundle += [bundled(f"www/public/ward-shapes-{y}.json", deps) for y in YEARS]
        else:
            bundle += [bundled(f"www/public/values-{suffix}-{y}.bin", deps) for y in YEARS]
    d1_parcels = bundled(D1_PARCELS, by_view["lot"] + by_view["unit"])

    d1_aggregates = Artifact(D1_AGGREGATES, Computation(
        cmd="python -m jc_taxes.cli aggregates -n",
        deps=[*all_geojson, portfolios],
        git_deps=code("aggregates", "stats", "paths"),
    ))
    d1_portfolios = Artifact(D1_PORTFOLIOS, Computation(
        cmd="python -m jc_taxes.cli d1 portfolios",
        deps=[portfolios],
        git_deps=code("d1"),
    ))
    d1_sql = [d1_parcels, d1_aggregates, d1_portfolios]

    # Side effects (no outs): the `.dvc` records what was last pushed.
    r2_br = Artifact("deploy/r2-br", Computation(
        cmd="python -m jc_taxes.cli r2 precompress",
        deps=bundle,
        git_deps=code("r2"),
    ))
    d1_loads = [
        Artifact(f"deploy/{env}/d1", Computation(
            cmd=f"python -m jc_taxes.cli d1 load -d {db}",
            deps=d1_sql,
            git_deps=[*code("d1"), "edge/d1/migrations"],
        ))
        for env, db in (("dev", "jct-dev"), ("prod", "jct"))
    ]
    return [hls, payments, combined, *all_geojson, *bundle, *d1_sql, r2_br, *d1_loads]


@click.group()
def pipeline():
    """DVX pipeline provenance."""


@pipeline.command()
@click.option("-n", "--dry-run", is_flag=True, help="List the `.dvc` files that would be written.")
def write(dry_run: bool):
    """(Re)write every stage's `.dvc` (`meta.computation`: cmd, deps, git_deps)."""
    chdir(ROOT)  # stage paths are repo-relative
    arts = stages()
    for a in arts:
        if dry_run:
            print(f"{a.path}.dvc")
        else:
            a.write_dvc()
    err(f"{'would write' if dry_run else 'wrote'} {len(arts)} .dvc files")
