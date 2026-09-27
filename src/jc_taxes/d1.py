"""D1 loads: the pipeline's generated SQL (`data/d1/*.sql`) → a D1 database.

The SQL files are DVX-tracked pipeline outputs (they embed portfolio membership
and owner history, so they stay out of git):
- `parcels.sql`: `jct bundle` (per-parcel details + owner history, FTS rebuild)
- `aggregates.sql`: `jct aggregates` (view × focus × year totals / maxima)
- `portfolios.sql`: `jct d1 portfolios` (from `www/public/portfolios.json`)

`jct d1 load -d jct-dev` loads dev; the same files into `jct` promote to prod,
so prod gets byte-identical data to what was checked on dev.
"""
import json
import subprocess
from pathlib import Path

import click
from utz import err

from .paths import D1_SQL, ROOT

EDGE = ROOT / "edge"
PORTFOLIOS_JSON = ROOT / "www" / "public" / "portfolios.json"
SQL_FILES = ("parcels.sql", "aggregates.sql", "portfolios.sql")
# wrangler env whose config binds each database (`env.dev` in `edge/wrangler.jsonc`).
DB_ENVS = {"jct": None, "jct-dev": "dev"}


def _q(v) -> str:
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def _list(v) -> str:
    return _q(json.dumps(v, separators=(",", ":"))) if isinstance(v, list) and v else "NULL"


def portfolios_sql(portfolios: list[dict]) -> str:
    """Full-replace upsert of the `portfolios` table (rows absent from the JSON are deleted)."""
    stmts = []
    for ord_, p in enumerate(portfolios):
        if not p.get("key") or not p.get("label"):
            raise ValueError(f"portfolio missing key/label: {json.dumps(p)[:80]}")
        stmts.append(
            "INSERT INTO portfolios (key, label, note, blocks, parcels, keywords, ord, updated_at) VALUES "
            f"({_q(p['key'])}, {_q(p['label'])}, {_q(p.get('note'))}, {_list(p.get('blocks'))}, {_list(p.get('parcels'))}, "
            f"{_list(p.get('keywords'))}, {ord_}, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET label=excluded.label, note=excluded.note, blocks=excluded.blocks, "
            "parcels=excluded.parcels, keywords=excluded.keywords, ord=excluded.ord, updated_at=excluded.updated_at;"
        )
    keys = ", ".join(_q(p["key"]) for p in portfolios) or "''"
    stmts.append(f"DELETE FROM portfolios WHERE key NOT IN ({keys});")
    return "\n".join(stmts) + "\n"


def wrangler(*args: str, db: str, local: bool):
    env = DB_ENVS.get(db)
    cmd = ["npx", "wrangler", "d1", *args, "--local" if local else "--remote", *(["--env", env] if env else [])]
    err(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=EDGE, check=True)


@click.group()
def d1():
    """Generate / load the app's D1 data."""


@d1.command()
@click.option("-i", "--input", "input_path", type=click.Path(dir_okay=False, path_type=Path), default=PORTFOLIOS_JSON, show_default=True, help="portfolios.json (curated list).")
@click.option("-o", "--out", type=click.Path(dir_okay=False, path_type=Path), default=D1_SQL / "portfolios.sql", show_default=True, help="Generated SQL.")
def portfolios(input_path: Path, out: Path):
    """Write the `portfolios` table upsert SQL."""
    data = json.loads(input_path.read_text())
    if not isinstance(data, list):
        raise click.UsageError(f"{input_path}: expected a JSON array")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(portfolios_sql(data))
    err(f"wrote {out}: {len(data)} portfolios")


@d1.command()
@click.option("-d", "--db", type=click.Choice(list(DB_ENVS)), required=True, help="D1 database: `jct-dev` (dev), `jct` (prod promote).")
@click.option("-l", "--local", is_flag=True, help="Load the local (wrangler dev) D1 instead of remote.")
@click.option("-s", "--sql-dir", type=click.Path(file_okay=False, path_type=Path), default=D1_SQL, show_default=True, help="Dir with the generated SQL.")
def load(db: str, local: bool, sql_dir: Path):
    """Apply migrations, then execute the generated SQL files into DB."""
    missing = [n for n in SQL_FILES if not (sql_dir / n).exists()]
    if missing:
        raise click.UsageError(f"missing in {sql_dir}: {', '.join(missing)} (`dvx pull` or `dvx run` them)")
    wrangler("migrations", "apply", db, db=db, local=local)
    for name in SQL_FILES:
        wrangler("execute", db, "--file", str((sql_dir / name).resolve()), "-y", db=db, local=local)
