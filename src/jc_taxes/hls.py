"""Packed HLS account records: `data/hls/{muni}.parquet`.

`jct fetch` caches one `data/cache/{muni}/{account}.json.gz` per account (~70k
for Jersey City). Downstream stages read the packed file instead: one DVX object
rather than 70k (a Batch job pulling the cache dir spent most of an hour on
per-object fetches), and a fixed, sorted iteration order (a directory glob's
order is filesystem-dependent, and "first record wins" lookups depended on it).
"""
import gzip
import json
from collections.abc import Iterator
from pathlib import Path

import click
import pyarrow as pa
import pyarrow.parquet as pq
from utz import err

from .paths import DATA, MUNIS, cache_dir

PACKED = DATA / "hls"
# Rows per row group, and per write: bounds memory to one batch of records.
BATCH = 5_000
SCHEMA = pa.schema([("account", pa.string()), ("json", pa.string())])


def packed_path(muni: str = "JerseyCity") -> Path:
    return PACKED / f"{muni}.parquet"


def pack(src: Path, out: Path) -> int:
    """Stream `src/*.json.gz` (sorted by account) into `out` (`account`, `json` columns)."""
    paths = sorted(src.glob("*.json.gz"))
    out.parent.mkdir(parents=True, exist_ok=True)
    with pq.ParquetWriter(out, SCHEMA, compression="zstd") as w:
        for i in range(0, len(paths), BATCH):
            accounts, texts = [], []
            for path in paths[i:i + BATCH]:
                with gzip.open(path, "rt") as f:
                    # Re-serialize compactly: stable bytes regardless of the cached file's formatting.
                    texts.append(json.dumps(json.load(f), separators=(",", ":"), ensure_ascii=False))
                accounts.append(path.name.removesuffix(".json.gz"))
            w.write_table(pa.table({"account": accounts, "json": texts}, schema=SCHEMA))
            err(f"  {min(i + BATCH, len(paths))}/{len(paths)}")
    return len(paths)


def iter_records(path: Path | None = None) -> Iterator[dict]:
    """Yield each packed account's parsed JSON, in account order (one row group in memory at a time)."""
    pf = pq.ParquetFile(path or packed_path())
    for batch in pf.iter_batches(columns=["json"], batch_size=BATCH):
        for text in batch.column(0).to_pylist():
            yield json.loads(text)


@click.group()
def hls():
    """HLS account records."""


@hls.command("pack")
@click.option("-m", "--muni", type=click.Choice(sorted(MUNIS)), default="JerseyCity", show_default=True)
def pack_cmd(muni: str):
    """Pack `data/cache/{muni}/*.json.gz` → `data/hls/{muni}.parquet`."""
    out = packed_path(muni)
    n = pack(cache_dir(muni), out)
    err(f"wrote {out}: {n} accounts ({out.stat().st_size / 1e6:.1f} MB)")
