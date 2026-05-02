#!/usr/bin/env python3
"""Jersey City property tax CLI."""
import gzip
import json
import sys
from pathlib import Path

import click
import pandas as pd
from utz import err

from .api import HLSClient
from .paths import ACCOUNTS_INDEX, CACHE, PARCELS, TAXES


@click.group()
def main():
    """Jersey City property tax data tools."""
    pass


@main.command()
@click.argument("account")
@click.option("-c/-C", "--cache/--no-cache", default=True, help="Use local cache")
@click.option("-j", "--json-output", is_flag=True, help="Output raw JSON")
@click.option("-t", "--ttl", default=None, help="Cache TTL (e.g. '1d', '12h'). None=forever")
def get(account: str, cache: bool, json_output: bool, ttl: str):
    """Fetch details for a single account (number or B-L-Q)."""
    with HLSClient(rate_limit=False) as client:
        resp = client.get_account_details(account, use_cache=cache, ttl=ttl)
        if resp is None:
            err(f"Account not found: {account}")
            sys.exit(1)

        if json_output:
            print(resp.model_dump_json(indent=2))
        else:
            a = resp.account
            print(f"Account:  {a.AccountNumber}")
            print(f"B/L/Q:    {a.blq}")
            print(f"Owner:    {a.OwnerName}")
            print(f"Address:  {a.Address}")
            print(f"Location: {a.PropertyLocation}")
            print(f"Assessed: Land=${a.Land:,.0f} Imp=${a.Improvement:,.0f} Net=${a.NetTaxable:,.0f}")
            print(f"Balance:  Principal=${a.Principal:,.2f} Interest=${a.Interest:,.2f} Total=${a.TotalDue:,.2f}")
            print(f"Txns:     {len(a.Details)} details, {len(a.YearlySummaries)} yearly summaries")


@main.command()
@click.argument("block")
@click.option("-d", "--delay", default=0.3, help="Min delay between requests (sec)")
@click.option("-D", "--max-delay", default=0.8, help="Max delay between requests (sec)")
@click.option("-l", "--limit", default=0, help="Limit results (0=all)")
def search(block: str, delay: float, max_delay: float, limit: int):
    """Search accounts by block number."""
    with HLSClient(min_delay=delay, max_delay=max_delay) as client:
        count = 0
        for acct in client.search_by_block(block):
            print(f"{acct['AccountNumber']:>8} | {acct['Block']}-{acct['Lot']}-{acct.get('Qualifier', ''):<10} | {acct['PropertyLocation']}")
            count += 1
            if limit and count >= limit:
                break
        err(f"\n{count} accounts found")


@main.command()
@click.option("-d", "--delay", default=0.3, help="Min delay between requests (sec)")
@click.option("-D", "--max-delay", default=0.8, help="Max delay between requests (sec)")
@click.option("-l", "--limit-blocks", default=0, help="Limit blocks to process (0=all)")
@click.option("-o", "--output", default=str(ACCOUNTS_INDEX), help="Output file")
@click.option("-s", "--start-block", default="", help="Start from this block")
def enumerate_accounts(delay: float, max_delay: float, limit_blocks: int, output: str, start_block: str):
    """Enumerate all accounts by iterating blocks from parcels data."""
    if not PARCELS.exists():
        err(f"Parcels file not found: {PARCELS}")
        err("Download from: https://data.jerseycitynj.gov/explore/dataset/jersey-city-parcels/export/")
        sys.exit(1)

    parcels = pd.read_parquet(PARCELS)
    blocks = sorted(parcels['block'].dropna().unique().tolist())
    err(f"Found {len(blocks)} unique blocks in parcels data")

    if start_block:
        if start_block in blocks:
            idx = blocks.index(start_block)
            blocks = blocks[idx:]
            err(f"Starting from block {start_block} ({len(blocks)} remaining)")
        else:
            err(f"Block {start_block} not found")
            sys.exit(1)

    if limit_blocks:
        blocks = blocks[:limit_blocks]
        err(f"Limited to {limit_blocks} blocks")

    output_path = Path(output)

    # Load existing progress if resuming
    existing_blocks = set()
    all_accounts = []
    if output_path.exists():
        existing = pd.read_parquet(output_path)
        all_accounts = existing.to_dict('records')
        existing_blocks = set(existing['Block'].unique())
        err(f"Resuming: loaded {len(all_accounts)} existing accounts from {len(existing_blocks)} blocks")
        blocks = [b for b in blocks if b not in existing_blocks]
        err(f"  {len(blocks)} blocks remaining")

    def save_progress(msg: str = ""):
        if all_accounts:
            df = pd.DataFrame(all_accounts)
            df.to_parquet(output_path)
            err(f"{msg}Saved {len(all_accounts)} accounts to {output}")

    try:
        with HLSClient(min_delay=delay, max_delay=max_delay) as client:
            for i, block in enumerate(blocks):
                accounts = list(client.search_by_block(block))
                all_accounts.extend(accounts)

                # Checkpoint every 50 blocks
                if (i + 1) % 50 == 0:
                    save_progress(f"Checkpoint ({i + 1}/{len(blocks)} blocks): ")
    except KeyboardInterrupt:
        err("\nInterrupted.")
        save_progress("Saving progress: ")
        sys.exit(130)
    except Exception as e:
        err(f"\nError: {e}")
        save_progress("Saving progress before exit: ")
        raise
    else:
        save_progress("\nDone: ")


@main.command()
@click.argument("input_file", default=str(ACCOUNTS_INDEX))
@click.option("-d", "--delay", default=0.5, help="Min delay between requests (sec)")
@click.option("-D", "--max-delay", default=1.0, help="Max delay between requests (sec)")
@click.option("-l", "--limit", default=0, help="Limit accounts to fetch (0=all)")
@click.option("-o", "--output-dir", default=str(CACHE), help="Cache directory for JSON")
@click.option("-s", "--start", default=0, help="Start from this account index")
@click.option("-t", "--ttl", default=None, help="Cache TTL (e.g. '1d', '12h', '3600'). None=forever")
def fetch(input_file: str, delay: float, max_delay: float, limit: int, output_dir: str, start: int, ttl: str):
    """Fetch full details for accounts in index file."""
    df = pd.read_parquet(input_file)
    err(f"Loaded {len(df)} accounts from {input_file}")

    if start:
        df = df.iloc[start:]
        err(f"Starting from index {start}")

    if limit:
        df = df.head(limit)
        err(f"Limited to {limit} accounts")

    cache_dir = Path(output_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    from .api import parse_ttl
    from datetime import datetime

    ttl_delta = parse_ttl(ttl)

    with HLSClient(cache_dir=cache_dir, min_delay=delay, max_delay=max_delay) as client:
        fetched = 0
        cached = 0
        expired = 0
        errors = 0

        for i, row in df.iterrows():
            acct = row['AccountNumber']
            gz_path = cache_dir / f"{acct}.json.gz"
            json_path = cache_dir / f"{acct}.json"
            cache_path = gz_path if gz_path.exists() else json_path

            # Check if cache exists and is fresh
            if cache_path.exists():
                if ttl_delta is None:
                    cached += 1
                    continue
                mtime = datetime.fromtimestamp(cache_path.stat().st_mtime)
                if datetime.now() - mtime <= ttl_delta:
                    cached += 1
                    continue
                expired += 1  # Will re-fetch

            resp = client.get_account_details(acct, use_cache=True, ttl=ttl)
            if resp:
                fetched += 1
            else:
                errors += 1
                err(f"  Error fetching {acct}")

            total = fetched + cached + expired + errors
            if total % 100 == 0:
                err(f"  Progress: {fetched} fetched, {cached} cached, {expired} expired/refetched, {errors} errors")

    err(f"\nDone: {fetched} fetched, {cached} cached, {expired} expired/refetched, {errors} errors")


@main.command()
@click.option("-i", "--input-dir", default=str(CACHE), help="Cache directory with JSON files")
@click.option("-o", "--output", default=str(TAXES), help="Output parquet file")
def export(input_dir: str, output: str):
    """Export cached JSON files to parquet."""
    from .models import AccountResponse

    cache_dir = Path(input_dir)
    json_files = sorted(cache_dir.glob("*.json")) + sorted(cache_dir.glob("*.json.gz"))
    err(f"Found {len(json_files)} cached files")

    records = []
    for path in json_files:
        if path.suffixes == ['.json', '.gz']:
            with gzip.open(path, 'rt') as f:
                data = json.load(f)
        else:
            with open(path) as f:
                data = json.load(f)
        try:
            resp = AccountResponse.model_validate(data)
            a = resp.account
            records.append({
                'AccountNumber': a.AccountNumber,
                'Block': a.Block,
                'Lot': a.Lot,
                'Qualifier': a.Qualifier,
                'BLQ': a.blq,
                'OwnerName': a.OwnerName,
                'Address': a.Address,
                'PropertyLocation': a.PropertyLocation,
                'CityState': a.CityState,
                'PostalCode': a.PostalCode,
                'Land': a.Land,
                'Improvement': a.Improvement,
                'NetTaxable': a.NetTaxable,
                'Class': a.Class,
                'Principal': a.Principal,
                'Interest': a.Interest,
                'TotalDue': a.TotalDue,
                'Deduction': a.Deduction,
                'DelinquentStatus': a.DelinquentStatus,
                'SalePrice': a.SalePrice,
                'DeedBook': a.DeedBook,
                'DeedPage': a.DeedPage,
                'DetailsCount': len(a.Details),
                'LienCount': a.LienCount,
            })
        except Exception as e:
            err(f"  Error parsing {path.name}: {e}")

    df = pd.DataFrame(records)
    df.to_parquet(output)
    err(f"\nWrote {len(df)} accounts to {output}")


@main.command()
@click.option("-o", "--output", default="www/public/parcels.geojson", help="Output GeoJSON file")
@click.option("-l", "--limit", default=0, help="Limit features (0=all)")
def geojson(output: str, limit: int):
    """Generate GeoJSON for web visualization."""
    from .geojson import generate_geojson
    generate_geojson(Path(output), limit)


if __name__ == "__main__":
    main()
