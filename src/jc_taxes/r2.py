"""Publish a friendly-named data tree to R2, for browsing.

The DVC cache stores objects content-addressed (`.dvc/cache/files/md5/xx/rest`),
which is unbrowsable. `jct r2 publish` server-side-copies (no egress) each tracked
artifact to a human-readable key under the `data/` prefix, so the same bytes are
reachable at e.g. `https://data.jct.rbw.sh/data/geojson/2025/taxes-2025-blocks.geojson`
and browsable via the file-tree UI at `files.jct.rbw.sh`.
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
}


@dataclass(frozen=True)
class Artifact:
    """A DVC-tracked file and the friendly key it publishes to (under `PUBLISH_PREFIX`)."""
    dvc: Path   # the `.dvc` sidecar
    dest: str   # friendly path, relative to `PUBLISH_PREFIX`

    @property
    def _sidecar(self) -> str:
        return self.dvc.read_text()

    @property
    def md5(self) -> str:
        m = re.search(r"md5:\s*([0-9a-f]+)", self._sidecar)
        if not m:
            raise ValueError(f"No md5 in {self.dvc}")
        return m.group(1)

    @property
    def size(self) -> int:
        m = re.search(r"size:\s*(\d+)", self._sidecar)
        if not m:
            raise ValueError(f"No size in {self.dvc}")
        return int(m.group(1))

    @property
    def src_key(self) -> str:
        md5 = self.md5
        return f"{CACHE_PREFIX}/{md5[:2]}/{md5[2:]}"

    @property
    def dest_key(self) -> str:
        return f"{PUBLISH_PREFIX}/{self.dest}"

    @property
    def content_type(self) -> str:
        return CONTENT_TYPES.get(Path(self.dest).suffix, "application/octet-stream")


def artifacts() -> list[Artifact]:
    """Enumerate the artifacts to publish, as `(sidecar, friendly-dest)` pairs."""
    arts: list[Artifact] = []
    # Yearly geojsons → data/geojson/<year>/<name>
    for dvc in sorted((ROOT / "www" / "public").glob("taxes-*.geojson.dvc")):
        name = dvc.name.removesuffix(".dvc")           # taxes-2025-blocks.geojson
        year = re.match(r"taxes-(\d{4})-", name).group(1)
        arts.append(Artifact(dvc, f"geojson/{year}/{name}"))
    # MOD-IV treasury parquets → data/modiv/<year>.parquet
    for dvc in sorted((ROOT / "data" / "modiv" / "treasury").glob("[0-9][0-9][0-9][0-9].parquet.dvc")):
        arts.append(Artifact(dvc, f"modiv/{dvc.name.removesuffix('.dvc')}"))
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
@click.option("-f", "--force", is_flag=True, help="Re-copy even if the destination exists with matching size.")
@click.option("-n", "--dry-run", is_flag=True, help="Print planned copies without executing them.")
def publish(force: bool, dry_run: bool):
    """Server-side-copy DVC-tracked artifacts to a friendly `data/` tree in R2 (no egress)."""
    arts = artifacts()
    s3 = _client()
    copied = skipped = 0
    for a in arts:
        if not force and _remote_size(s3, a.dest_key) == a.size:
            err(f"skip       {a.dest_key} ({a.size} B)")
            skipped += 1
            continue
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
    err(f"\n{'DRY RUN — ' if dry_run else ''}{copied} copied, {skipped} skipped, {len(arts)} total")
    print(f"{PUBLIC_BASE}/{PUBLISH_PREFIX}/")
