#!/usr/bin/env python3
"""Extract yearly payment data from the packed HLS account records."""
from pathlib import Path

import click
import pandas as pd
from utz import err

from .hls import iter_records, packed_path
from .paths import DATA, MUNIS


def extract_payments(
    packed: Path,
    output: Path,
) -> pd.DataFrame:
    """
    Extract yearly payment totals from the packed HLS records (`jct hls pack`).

    Returns DataFrame with columns:
        AccountNumber, Block, Lot, Qualifier, Year, Billed, Paid
    """
    err(f"Processing {packed}...")

    records = []
    for i, data in enumerate(iter_records(packed)):
        if (i + 1) % 10000 == 0:
            err(f"  {i + 1}")

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

    # Small row groups: the parquet browsers (hyparquet/@rdub/file-tree) fetch a
    # whole row group to render any page, so ~1M-row groups mean an ~11MB fetch
    # per view. 50k rows keeps each group ~0.5MB for snappy browsing.
    df.to_parquet(output, index=False, row_group_size=50_000)
    err(f"Wrote {output}")

    return df


@click.command()
@click.option("-m", "--muni", type=click.Choice(sorted(MUNIS)), default="JerseyCity", show_default=True)
@click.option("-i", "--input", "input_path", default=None, help="Packed HLS records (default: data/hls/{muni}.parquet)")
@click.option("-o", "--output", default=None, help="Output parquet (default: data/payments.{muni}.parquet)")
def main(muni: str, input_path: str, output: str):
    packed = Path(input_path) if input_path else packed_path(muni)
    if output:
        out = Path(output)
    else:
        # JC keeps the legacy unsuffixed path; other munis get muni-suffixed
        out = DATA / "payments.parquet" if muni == "JerseyCity" else DATA / f"payments.{muni}.parquet"
    extract_payments(packed, out)


if __name__ == "__main__":
    main()
