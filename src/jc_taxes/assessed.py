"""Assessed values (latest MOD-IV year) on lot / unit features.

`jct bundle` calls `annotate` on the lot and unit geometry, adding fixed
properties from the latest Treasury MOD-IV file (`data/modiv/treasury/{year}.parquet`):

- `av`: taxable net assessed value (whole dollars; omitted when 0).
- `av_x`: net assessed value of exempt / PILOT records (class 15*; omitted when 0).
  Kept apart from `av` so a sum of `av` compares to the ratable base in budget
  figures.
- `yr_built`, only where the feature has none: MOD-IV `year_constructed` (it
  agrees with the tax-record "Yr. Built" ~97% where both exist).

A lot's values sum its MOD-IV records (all qualifiers: condo units, `HM`, …).

File-year Y holds tax-year Y assessments: parcels whose `net_value` changed
between files Y-1 and Y are billed (HLS) at Y's rate × file Y's value in tax
year Y, not Y-1 (checked for Y = 2025, 2026). (`last_year_tax` in the same file
is tax year Y-1; see `modiv crossval`.)
"""
from pathlib import Path

import click
from utz import err

from .paths import DATA

JC = "0906"
TREASURY = DATA / "modiv" / "treasury"
LATEST = 2026
LATEST_PATH = TREASURY / f"{LATEST}.parquet"
MIN_YEAR = 1700


def norm_part(s: str) -> str:
    """MOD-IV block / lot (`00001  01`, `07301  01`, `00012`) → HLS form
    (`1.01`, `7301.01`, `12`): unpad the base, keep the suffix after the space."""
    parts = str(s).split()
    if not parts:
        return "0"
    base = parts[0].lstrip("0") or "0"
    return f"{base}.{parts[1]}" if len(parts) > 1 else base


def unit_key(block: str, lot: str, qual: str) -> str:
    """`block-lot-qual`, as `featureIdOf` builds it for unit features."""
    return f"{norm_part(block)}-{norm_part(lot)}-{str(qual).strip()}"


def is_taxable(property_class: str | None) -> bool:
    """Class 15* (15A–15F: schools, public, charitable, PILOT / other) is exempt."""
    return not str(property_class or "").strip().upper().startswith("15")


def load(path: Path = LATEST_PATH, mun: str = JC):
    """JC records: `key`, `lot_key`, `net_value`, `improvement_value`,
    `land_value`, `property_class`, `taxable`, `year_constructed` (int or NA)."""
    import pandas as pd

    t = pd.read_parquet(path, columns=[
        "county_district", "block", "lot", "qualifier", "property_class",
        "net_value", "improvement_value", "land_value", "year_constructed",
    ])
    t = t[t.county_district == mun].copy()
    t["key"] = [unit_key(b, l, q) for b, l, q in zip(t.block, t.lot, t.qualifier)]
    t["lot_key"] = [k.rsplit("-", 1)[0] for k in t.key]
    t["qual"] = t.qualifier.str.strip()
    for c in ("net_value", "improvement_value", "land_value"):
        t[c] = t[c].fillna(0).astype("int64")
    t["taxable"] = t.property_class.map(is_taxable)
    yc = pd.to_numeric(t.year_constructed, errors="coerce")
    t["year_constructed"] = yc.where(yc >= MIN_YEAR).astype("Int64")
    return t.drop(columns=["county_district", "block", "lot", "qualifier"]).reset_index(drop=True)


def _values(rows) -> dict:
    """{av, av_x} for a group of records (zeros omitted)."""
    tax = int(rows.net_value[rows.taxable].sum())
    exempt = int(rows.net_value[~rows.taxable].sum())
    return {k: v for k, v in (("av", tax), ("av_x", exempt)) if v}


def _lot_year(rows) -> int | None:
    """A lot's fallback year: its base record's (no qualifier), else the earliest."""
    base = rows.year_constructed[rows.qual == ""].dropna()
    if len(base):
        return int(base.iloc[0])
    ys = rows.year_constructed.dropna()
    return int(ys.min()) if len(ys) else None


def tables(records) -> tuple[dict[str, dict], dict[str, dict]]:
    """(by unit key, by lot key) → `{av?, av_x?, year?}`."""
    import pandas as pd

    units = {}
    for k, tax, nv, y in zip(records.key, records.taxable, records.net_value, records.year_constructed):
        e = {("av" if tax else "av_x"): int(nv)} if nv else {}
        if not pd.isna(y):
            e["year"] = int(y)
        units[k] = e
    lots = {}
    for k, rows in records.groupby("lot_key", sort=False):
        e = _values(rows)
        y = _lot_year(rows)
        if y:
            e["year"] = y
        lots[k] = e
    return units, lots


def annotate(view: str, features: list[dict], records) -> dict:
    """Add `av` / `av_x` (and missing `yr_built`) to lot / unit features, in
    place. Returns match counts."""
    units, lots = tables(records)
    table = units if view == "unit" else lots
    stats = {"features": len(features), "matched": 0, "yr_filled": 0}
    for f in features:
        pr = f["properties"]
        k = f"{pr['block']}-{pr['lot']}"
        e = table.get(f"{k}-{pr.get('qual') or ''}" if view == "unit" else k)
        if e is None:
            continue
        stats["matched"] += 1
        pr.update({c: e[c] for c in ("av", "av_x") if c in e})
        if not pr.get("yr_built"):
            y = e.get("year") or (lots.get(k, {}).get("year") if view == "unit" else None)
            if y:
                pr["yr_built"] = y
                stats["yr_filled"] += 1
    return stats


@click.group()
def assessed():
    """MOD-IV assessed values on the map's lots / units."""


@assessed.command()
@click.option("-g", "--geom", "geom_path", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              help="Annotated geometry (default: www/public/geom-units.geojson).")
@click.option("-y", "--since", default=2021, show_default=True, help="Built-since year.")
def validate(geom_path: Path | None, since: int):
    """Markdown table: count / taxable net / improvement value for parcels built
    since `--since`, with unknown year built, and all (unit view, latest MOD-IV)."""
    import json

    from .stats import WWW_PUBLIC

    geom_path = geom_path or WWW_PUBLIC / "geom-units.geojson"
    feats = json.loads(geom_path.read_text())["features"]
    recs = load().set_index("key")
    rows = {"new": [], "unknown": [], "all": []}
    for f in feats:
        pr = f["properties"]
        k = f"{pr['block']}-{pr['lot']}-{pr.get('qual') or ''}"
        y = pr.get("yr_built")
        rows["all"].append(k)
        if y and y >= since:
            rows["new"].append(k)
        elif not y:
            rows["unknown"].append(k)
    fmt = lambda v: f"${v / 1e9:,.2f}B" if v >= 1e8 else f"${v / 1e6:,.1f}M"
    print("| | Count | Taxable net value | Improvement value (taxable) | Exempt / PILOT net value |")
    print("|---|---|---|---|---|")
    labels = {"new": f"Parcels with `yr_built >= {since}`", "unknown": "Parcels with unknown `yr_built`", "all": "All parcels"}
    for name in ("new", "unknown", "all"):
        r = recs.reindex(rows[name]).dropna(subset=["net_value"])
        tax = r[r.taxable.astype(bool)]
        print(f"| {labels[name]} | {len(rows[name]):,} | {fmt(tax.net_value.sum())} | {fmt(tax.improvement_value.sum())} | {fmt(r.net_value[~r.taxable.astype(bool)].sum())} |")
    err(f"{len(feats) - len(recs.index.intersection(rows['all'])):,} of {len(feats):,} unit features have no MOD-IV record")
