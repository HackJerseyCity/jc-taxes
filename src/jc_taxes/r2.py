"""Publish a friendly-named data tree to R2, for browsing.

The DVC cache stores objects content-addressed (`.dvc/cache/files/md5/xx/rest`),
which is unbrowsable. `jct r2 publish` publishes a human-readable tree under the
`data/` prefix so the same bytes are reachable at e.g.
`https://data.jct.rbw.sh/data/records/taxrecords_enriched.parquet` and browsable
via the file-tree UI at `jct-files.rbw.sh`.

Two source kinds:
- **DVC-tracked** artifacts (geojsons, MOD-IV parquets) are already in the R2
  cache → published by a server-side copy (no egress, no download).
- **Local** artifacts (the HLS-derived tax-record parquets, census files) are
  gitignored / not in R2 → published by uploading from disk (free ingress).
  These only publish on a machine that has them built.

All published data is NJ public record (owner names, assessments, payment
history) — the same fields the map already surfaces.
"""
import re
from dataclasses import dataclass
from pathlib import Path

import boto3
import click
from botocore.exceptions import ClientError
from utz import err

from .paths import ROOT

# Mirrors `.dvc/config` [remote "r2"].
R2_ENDPOINT = "https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com"
R2_BUCKET = "jc-taxes"
R2_PROFILE = "cf"
CACHE_PREFIX = ".dvc/cache/files/md5"
PUBLISH_PREFIX = "data"
PUBLIC_BASE = "https://data.jct.rbw.sh"

CONTENT_TYPES = {
    ".geojson": "application/geo+json",
    ".parquet": "application/vnd.apache.parquet",
    ".json": "application/json",
    ".zip": "application/zip",
}


@dataclass(frozen=True)
class Artifact:
    """A file and the friendly key it publishes to (under `PUBLISH_PREFIX`).

    Exactly one of `dvc` (a `.dvc` sidecar → server-side copy from the R2 cache)
    or `local` (a local file → upload) is set.
    """
    dest: str                    # friendly path, relative to `PUBLISH_PREFIX`
    dvc: Path | None = None      # `.dvc` sidecar (DVC-tracked source)
    local: Path | None = None    # local file (upload source)

    @property
    def size(self) -> int:
        if self.local is not None:
            return self.local.stat().st_size
        m = re.search(r"size:\s*(\d+)", self.dvc.read_text())
        if not m:
            raise ValueError(f"No size in {self.dvc}")
        return int(m.group(1))

    @property
    def src_key(self) -> str:
        """R2 cache key for a DVC-tracked artifact."""
        m = re.search(r"md5:\s*([0-9a-f]+)", self.dvc.read_text())
        if not m:
            raise ValueError(f"No md5 in {self.dvc}")
        md5 = m.group(1)
        return f"{CACHE_PREFIX}/{md5[:2]}/{md5[2:]}"

    @property
    def dest_key(self) -> str:
        return f"{PUBLISH_PREFIX}/{self.dest}"

    @property
    def content_type(self) -> str:
        return CONTENT_TYPES.get(Path(self.dest).suffix, "application/octet-stream")


# Local tax-record + census files, as (relative-path, friendly-dest) pairs. Only
# published on a machine where the file exists (they're derived / gitignored).
LOCAL_SOURCES = [
    ("data/payments.parquet", "records/payments.parquet"),
    ("data/taxes.parquet", "records/taxes.parquet"),
    ("data/taxrecords_enriched.parquet", "records/taxrecords_enriched.parquet"),
    ("census/hudson-blocks-geo.geojson", "census/hudson-blocks-geo.geojson"),
    ("census/hudson-blocks-pop.json", "census/hudson-blocks-pop.json"),
    ("census/jc-wards.geojson", "census/jc-wards.geojson"),
]


def artifacts() -> list[Artifact]:
    """Enumerate the artifacts to publish (DVC-tracked + present local files)."""
    arts: list[Artifact] = []
    # DVC-tracked: yearly geojsons → data/geojson/<year>/<name>
    for dvc in sorted((ROOT / "www" / "public").glob("taxes-*.geojson.dvc")):
        name = dvc.name.removesuffix(".dvc")           # taxes-2025-blocks.geojson
        year = re.match(r"taxes-(\d{4})-", name).group(1)
        arts.append(Artifact(f"geojson/{year}/{name}", dvc=dvc))
    # DVC-tracked: MOD-IV treasury parquets → data/modiv/<year>.parquet
    for dvc in sorted((ROOT / "data" / "modiv" / "treasury").glob("[0-9][0-9][0-9][0-9].parquet.dvc")):
        arts.append(Artifact(f"modiv/{dvc.name.removesuffix('.dvc')}", dvc=dvc))
    # Local: tax-record parquets + census (only if present on this machine)
    for rel, dest in LOCAL_SOURCES:
        path = ROOT / rel
        if path.exists():
            arts.append(Artifact(dest, local=path))
        else:
            err(f"note       skipping (local file absent): {rel}")
    return arts


def _client():
    return boto3.Session(profile_name=R2_PROFILE).client(
        "s3", endpoint_url=R2_ENDPOINT, region_name="auto",
    )


def _remote_size(s3, key: str) -> int | None:
    """Object's size in R2, or None if it doesn't exist."""
    try:
        return s3.head_object(Bucket=R2_BUCKET, Key=key)["ContentLength"]
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return None
        raise


@click.group()
def r2():
    """Publish/manage the friendly `data/` tree in R2 (for browsing)."""
    pass


@r2.command()
@click.option("-f", "--force", is_flag=True, help="Re-publish even if the destination exists with matching size.")
@click.option("-n", "--dry-run", is_flag=True, help="Print planned publishes without executing them.")
def publish(force: bool, dry_run: bool):
    """Publish DVC-tracked + local artifacts to a friendly `data/` tree in R2."""
    arts = artifacts()
    s3 = _client()
    copied = uploaded = skipped = 0
    for a in arts:
        if not force and _remote_size(s3, a.dest_key) == a.size:
            err(f"skip       {a.dest_key} ({a.size} B)")
            skipped += 1
            continue
        if a.local is not None:
            err(f"{'would upload' if dry_run else 'upload'}  {a.local} -> {a.dest_key} ({a.content_type}, {a.size} B)")
            if not dry_run:
                s3.upload_file(str(a.local), R2_BUCKET, a.dest_key, ExtraArgs={"ContentType": a.content_type})
                uploaded += 1
        else:
            err(f"{'would copy' if dry_run else 'copy'}  {a.src_key} -> {a.dest_key} ({a.content_type}, {a.size} B)")
            if not dry_run:
                s3.copy_object(
                    Bucket=R2_BUCKET,
                    Key=a.dest_key,
                    CopySource={"Bucket": R2_BUCKET, "Key": a.src_key},
                    ContentType=a.content_type,
                    MetadataDirective="REPLACE",
                )
                copied += 1
    err(f"\n{'DRY RUN — ' if dry_run else ''}{copied} copied, {uploaded} uploaded, {skipped} skipped, {len(arts)} total")
    print(f"{PUBLIC_BASE}/{PUBLISH_PREFIX}/")
