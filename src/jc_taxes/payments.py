#!/usr/bin/env python3
"""Extract yearly payment data from cached account details."""
import gzip
import json
import sys
from pathlib import Path

import click
import pandas as pd
from utz import err

from .paths import DATA, MUNIS, cache_dir as muni_cache_dir


def extract_payments(
    cache_dir: Path,
    output: Path,
) -> pd.DataFrame:
    """
    Extract yearly payment totals from cached JSON files.

    Returns DataFrame with columns:
        AccountNumber, Block, Lot, Qualifier, Year, Billed, Paid
    """
    json_files = sorted(cache_dir.glob("*.json")) + sorted(cache_dir.glob("*.json.gz"))
    err(f"Processing {len(json_files)} cached files from {cache_dir}...")

    records = []
    for i, path in enumerate(json_files):
        if (i + 1) % 10000 == 0:
            err(f"  {i + 1}/{len(json_files)}")

        if path.suffixes == ['.json', '.gz']:
            with gzip.open(path, 'rt') as f:
                data = json.load(f)
        else:
            with open(path) as f:
                data = json.load(f)

        acct = data.get("accountInquiryVM", {})
        account_number = acct.get("AccountNumber")
        block = str(acct.get("Block", "")).strip()
        lot = str(acct.get("Lot", "")).strip()
        qualifier = str(acct.get("Qualifier", "")).strip()

        details = acct.get("Details", [])
        if not details:
            continue

        # Aggregate by year
        by_year: dict[int, dict] = {}
        for d in details:
            year = d.get("TaxYear")
            if not year:
                continue
            if year not in by_year:
                by_year[year] = {"billed": 0.0, "paid": 0.0}
            by_year[year]["billed"] += d.get("Billed", 0) or 0
            by_year[year]["paid"] += d.get("Paid", 0) or 0

        for year, totals in by_year.items():
            records.append({
                "AccountNumber": account_number,
                "Block": block,
                "Lot": lot,
                "Qualifier": qualifier,
                "Year": year,
                "Billed": totals["billed"],
                "Paid": abs(totals["paid"]),  # Paid is negative in source
            })

    df = pd.DataFrame(records)
    err(f"Extracted {len(df):,} year-account records")

    df.to_parquet(output, index=False)
    err(f"Wrote {output}")

    return df


@click.command()
@click.option("-m", "--muni", type=click.Choice(sorted(MUNIS)), default="JerseyCity", show_default=True)
@click.option("-i", "--input-dir", default=None, help="Cache dir (default: data/cache/{muni})")
@click.option("-o", "--output", default=None, help="Output parquet (default: data/payments.{muni}.parquet)")
def main(muni: str, input_dir: str, output: str):
    cache = Path(input_dir) if input_dir else muni_cache_dir(muni)
    if output:
        out = Path(output)
    else:
        # JC keeps the legacy unsuffixed path; other munis get muni-suffixed
        out = DATA / "payments.parquet" if muni == "JerseyCity" else DATA / f"payments.{muni}.parquet"
    extract_payments(cache, out)


if __name__ == "__main__":
    main()
