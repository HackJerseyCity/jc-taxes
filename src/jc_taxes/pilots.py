"""PILOT / tax-abatement activity over time, from the HLS portal scrape.

Jersey City's Urban Renewal / Long Term Tax Exemption properties bill their
annual service charge ("PILOT") through the same portal as conventional taxes,
under descriptions like `Ab-<project>  Bill` / `Pilot abatement  Bill`. We scan
the cached account details for those rows and derive two datasets:

`jc_pilots.json` — per year: `billed` / `paid` / `n_accounts`.
  - `n_accounts` (presence check) is ROBUST and tells the "abatements
    proliferated, then expired" story directly.
  - `billed` / `paid` are a LOWER BOUND on true PILOT revenue (some charges bill
    under generic descriptions; the city's budget PILOT line runs higher).
    Present as "identifiable abatement bills", never as the authoritative total.

`jc_pilot_expirations.json` — per (expiration year, development): count of
  accounts whose LAST identifiable PILOT bill fell in that year, i.e. whose
  abatement term ended and reverted to conventional tax. This is the *historical*
  rolloff wave — each year a named development's condo units convert at once
  (James Monroe's 442 units in 2018, Port Liberté in 2016, TCR Pier House in
  2022, …). Note: this only sees abatements that HAVE ALREADY ended; the scrape
  carries no term/end-date, so it cannot project FUTURE expirations of the
  accounts still active today (that needs JC's per-agreement PILOT schedule).

Pre-2005 portal history is partial, so series start at `--start-year` (2005).
"""
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import click
from utz import err

from .hls import iter_records, packed_path
from .paths import DATA

DATA_DIR = DATA.parent / "www" / "public" / "data"
DEFAULT_OUT = DATA_DIR / "jc_pilots.json"
DEFAULT_EXP_OUT = DATA_DIR / "jc_pilot_expirations.json"

# Bill/payment rows for an abatement: `Ab-<project>` or `Pilot abatement`.
# Exclude administrative fee rows (`Pilot-adm fee`, `Pilot Fee`, `Pilot Adm Fee`)
# — those are small surcharges, not the service charge itself.
PILOT_RE = re.compile(r"^ab-|pilot", re.I)
ADM_RE = re.compile(r"adm fee|pilot fee", re.I)
# Strip the trailing " Bill"/" Payment"/... and the leading "Ab-" to get a project key.
SUFFIX_RE = re.compile(r"\s+(bill|payment|interest.*|adjustment.*)$", re.I)

# Readable labels for the portal's truncated project slugs (top expiring cohorts).
PROJECT_LABELS = {
    "james monroe": "James Monroe",
    "p. liberte c": "Port Liberté",
    "p.liberte ii": "Port Liberté II",
    "tcr pier hou": "TCR Pier House",
    "new liberty": "New Liberty",
    "vector u.r.": "Vector UR",
    "sugar house": "Sugar House",
    "majestic": "Majestic",
    "liberty pt": "Liberty Point",
    "pilot abatement": "Other",
}
OTHER = "Other"


def is_pilot_row(desc: str) -> bool:
    return bool(PILOT_RE.search(desc)) and not ADM_RE.search(desc)


def project_key(desc: str) -> str:
    """Normalize a PILOT bill description into a project slug ('ab-' stripped)."""
    s = SUFFIX_RE.sub("", desc.strip())
    s = re.sub(r"^ab-\s*", "", s, flags=re.I).strip().lower()
    return s or "pilot abatement"


def project_label(slug: str) -> str:
    return PROJECT_LABELS.get(slug, slug.title())


def yearly(packed: Path, start_year: int) -> list[dict]:
    err(f"Scanning {packed}...")
    by_year: dict[int, dict] = defaultdict(lambda: {"billed": 0.0, "paid": 0.0, "accts": set()})
    acct_years: dict[str, dict[int, float]] = defaultdict(dict)
    acct_project: dict[str, Counter] = defaultdict(Counter)
    for i, data in enumerate(iter_records(packed)):
        if (i + 1) % 20000 == 0:
            err(f"  {i + 1}")
        acct = data.get("accountInquiryVM", {})
        an = acct.get("AccountNumber")
        for det in acct.get("Details", []):
            desc = str(det.get("Description") or "")
            if not is_pilot_row(desc):
                continue
            year = det.get("TaxYear")
            if not year:
                continue
            billed = det.get("Billed", 0) or 0
            by_year[year]["billed"] += billed
            by_year[year]["paid"] += abs(det.get("Paid", 0) or 0)
            if billed > 0:
                by_year[year]["accts"].add(an)
                acct_years[an][year] = acct_years[an].get(year, 0.0) + billed
                acct_project[an][project_key(desc)] += 1

    rows = [
        {"year": y, "billed": round(v["billed"]), "paid": round(v["paid"]), "n_accounts": len(v["accts"])}
        for y, v in sorted(by_year.items()) if y >= start_year
    ]
    return rows, acct_years, acct_project


def expirations(acct_years, acct_project, first_year: int, last_full_year: int, top_n: int) -> list[dict]:
    """Per (expiration year, development) count of accounts whose last PILOT bill
    fell that year (term ended, reverted to conventional tax). Only years in
    [first_year, last_full_year] are 'expired'; accounts still billing in the
    latest year(s) are treated as active and excluded."""
    exp: dict[tuple[int, str], int] = defaultdict(int)
    totals: Counter = Counter()
    for an, years in acct_years.items():
        last = max(years)
        if last < first_year or last > last_full_year:
            continue  # too-early (partial history) or still active
        slug = acct_project[an].most_common(1)[0][0] if acct_project[an] else "pilot abatement"
        label = project_label(slug)
        exp[(last, label)] += 1
        totals[label] += 1

    # Named developments ranked by total expiring accounts; `OTHER` never counts
    # as a named project (it's the catch-all for unnamed + below-cutoff cohorts).
    ranked = [lbl for lbl, _ in totals.most_common() if lbl != OTHER]
    top = set(ranked[:top_n])
    merged: dict[tuple[int, str], int] = defaultdict(int)
    for (year, label), n in exp.items():
        merged[(year, label if label in top else OTHER)] += n
    return [
        {"year": y, "project": lbl, "n_accounts": n}
        for (y, lbl), n in sorted(merged.items())
    ]


@click.command()
@click.option("-e", "--exp-output", default=str(DEFAULT_EXP_OUT), show_default=True, help="Expirations JSON path")
@click.option("-n", "--top-projects", default=8, show_default=True, help="Named developments to break out in expirations (rest -> Other)")
@click.option("-o", "--output", default=str(DEFAULT_OUT), show_default=True, help="Yearly-aggregate JSON path")
@click.option("-s", "--start-year", default=2005, show_default=True, help="First year to emit (earlier portal history is partial)")
@click.option("-Y", "--end-year", default=2025, show_default=True, help="Last full year (current year is mid-billing)")
def pilots(exp_output: str, top_projects: int, output: str, start_year: int, end_year: int):
    """Aggregate PILOT/abatement bills per year + historical expiration wave -> JSON."""
    rows, acct_years, acct_project = yearly(packed_path("JerseyCity"), start_year)
    rows = [r for r in rows if r["year"] <= end_year]
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(json.dumps(rows, indent=2) + "\n")
    err(f"Wrote {len(rows)} years ({rows[0]['year']}-{rows[-1]['year']}) to {output}")

    # Expirations: first year with plausibly-complete history .. year before the
    # latest full year (so still-active accounts aren't miscounted as expired).
    exp_rows = expirations(acct_years, acct_project, first_year=2013, last_full_year=end_year - 1, top_n=top_projects)
    Path(exp_output).write_text(json.dumps(exp_rows, indent=2) + "\n")
    n_exp = sum(r["n_accounts"] for r in exp_rows)
    err(f"Wrote {len(exp_rows)} (year, project) expiration rows ({n_exp} accounts) to {exp_output}")


if __name__ == "__main__":
    pilots()
