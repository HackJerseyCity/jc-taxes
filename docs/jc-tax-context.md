# Jersey City property-tax context & methodology

Research notes reconciling this project's numbers with Jersey City's actual
municipal finance, and background on the surrounding politics. Written 2026-07;
figures are the latest available at that time. Sources are linked inline.

## 1. What our data actually measures

- The map's per-parcel `paid` / `billed` come **directly from the HLS
  tax-billing portal** (`payments.py` sums the `Details[].Billed` / `Details[].Paid`
  line-items per year). They are **actual billed / collected amounts, never
  imputed** from assessed value × rate. So we never credit a parcel with taxes
  it wasn't billed or didn't pay; a delinquent parcel shows `paid < billed`
  (2025: 1,954 parcels partial/short), and the status-bar tooltip's
  "collected %" reflects this.
- **2025 citywide total (block view): ~$1.227B billed / paid.** Block view has
  the fullest coverage; lot view reads ~$1.187B and unit view ~$1.097B because
  those GeoJSONs drop parcels lacking clean geometry. **Use block view for the
  authoritative citywide total.**
- The total is the **entire property-tax levy across all taxing districts**, not
  the city's slice. The municipality bills & collects the whole thing, then
  remits the school and county portions.

## 2. The 3× gap vs. officials' "$385M" / "36%"

A councilman's slide listed "$385M – Property Tax" as city revenue; another
official post gives the split **City 36% / BOE 43% / County 17%** (≈96%; the
rest is library/open-space). Our ~$1.23B ÷ ~3 ≈ the city's ~36% slice — the two
numbers measure different things:

- **Ours (~$1.23B):** total levy billed to all districts (city + schools + county).
- **Theirs ($385M):** the *municipal-purpose* levy the city keeps for its budget.

The city's own operating budget is ~$668M (the slide's lines sum to that:
$385M tax + $82M PILOTs + $65M state aid + $55M fees + $33M MUA + $21M library +
$13M levy increase + $14M other).

### 2a. Authoritative levy split (NJ DLGS Abstract of Ratables)

The social-media "City 36% / BOE 43% / County 17%" split is directionally right
but not the primary source. The authoritative one is the **NJ Division of Local
Government Services "Abstract of Ratables"** — a per-county xlsx published yearly
with every municipality's levy broken into school / municipal / county (Section
12 of the abstract). We parse Hudson County's and emit `www/public/data/
jc_levy_split.json` via a reproducible CLI: **`jct dlgs levy`** (`src/jc_taxes/
dlgs.py`; validates that school+municipal+county == the abstract's total-levy
checksum for every row). DLGS hosts xlsx abstracts for **2021–2025 only** (older
years are statewide `.xls`).

Jersey City (muni code 0906), $M, from the abstracts:

| Year | Schools | City | County | **Total** | Muni budget¹ |
|------|--------:|-----:|-------:|----------:|-------------:|
| 2021 |   236.2 | 223.1 |  176.3 |     635.6 |        207.4 |
| 2022 |   353.8 | 335.7 |  177.5 |     867.0 |        319.6 |
| 2023 |   432.3 | 367.5 |  187.6 |     987.4 |        349.9 |
| 2024 |   440.9 | 386.4 |  186.1 |   1,013.4 |        368.3 |
| 2025 |   490.8 | 405.2 |  201.5 |   1,097.5 |        385.0 |

Shares 2021→2025: **schools 37%→45%**, city ~35%→37%, county 28%→18%.
¹ "Municipal Budget" (Section 12Cii-A) alone — the **$385.0M** that exactly
matches Griffin's "$385M" figure; the full city *share* ($405.2M) adds municipal
open-space + library. 2021 is ARP-depressed (federal relief let JC cut the 2021
tax bill), so the 2021→2025 growth overstates the underlying trend somewhat.

**Reconciliation with our scrape:** DLGS total levy ($1,097.5M for 2025) is the
*conventional* tax levy. Our block-view scrape ($1,227M) exceeds it by ~$130M/yr
(stable across years) because the scrape additionally sweeps in billed PILOT
service charges, added assessments, and some water/sewer — i.e.
scrape ≈ levy + PILOTs + extras. Both are internally consistent; they measure
different universes.

## 3. Abatements / PILOTs — how they show up here

- **PILOTs are NOT missing from our totals — they're partly included.** Class-15F
  ("other exempt") parcels — legally "Urban Renewal LLC" entities (Journal Square
  Associates, Mack-Cali/25 Columbus, EQR at 77 Hudson, 70 Columbus, …) — **do
  carry billing** in the portal: **~$93.9M in 2025 (7.6% of our total).** That
  lands almost exactly on the independently-reported **$96M JC paid in PILOTs in
  2020** ([Civic Parent][cp-abate]). Their effective rate (billed ÷ assessed
  ≈ 0.5–1.2%) sits below the conventional ~1.6–2% — the PILOT signature.
- **So our ~$1.23B is really conventional tax (~$1.13B) + billed PILOT service
  charges (~$94M).** Calling the whole thing "property tax" slightly overstates
  conventional tax. No phantom money — real payments — but ~7.6% is PILOT.
- **Genuinely invisible ($0 billed):** truly-exempt public/institutional owners,
  correctly zero — Port Authority (PATH Plaza, $531M assessed), NJ DEP (Liberty
  State Park land), Hudson County parks, NJCU. **Exception:** a few big
  **residential PILOTs (Newport / NC Housing Associates, $203M + $163M assessed)
  bill $0 here** — those PILOTs route entirely outside the tax portal, so we do
  miss them.
- **"Service charge"** is the statutory term (N.J.S.A. 40A:20-12) for a PILOT
  payment — the payment under the financial agreement in lieu of taxes.

### PILOT economics & distribution (the important part)

- **Distribution: ~95% city / 5% county / 0% schools** ([N.J.S.A. 40A:20-12][statute],
  [DCA handbook][dca-handbook]). The municipality remits just 5% of the service
  charge to the county; **the BOE gets nothing.** Contrast a normal bill's
  ~36/43/17.
- **A PILOT can be a *better* deal for the city treasury even though the property
  pays less.** 2020: ~$96M PILOT vs ~$204M if fully taxed (owners pay ~47% of
  full freight). But city keeps 95% of $96M ≈ **$91M** vs 36% of $204M ≈ **$73M**.
  The city comes out ahead precisely by cutting schools out.
- **This is a transfer, not free money.** The ~$40M+ in school taxes PILOT'd
  buildings don't pay doesn't vanish — the BOE raises its levy, so **other
  (non-abated) homeowners cover it.** PILOTs don't reduce BOE spending; they
  shrink the pool that funds it.

### Where to find PILOT records

- **Best current per-property record = our own class-15F billing** (2025, ~$96M,
  matches the known figure).
- **JC Open Data** (`data.jerseycitynj.gov`): `tax-abatements-map` and
  `approved-tax-abatement-dashboard-2014-2016` are **empty (0 records)**;
  `approved-pilots-2014-2018` has 94 approval records (block/lot/term/est. service
  charge, but stale, approvals-only).
- **NJ DCA** runs a statewide PILOT database/viewer ([Tax Abatement Toolkit][dca-toolkit]).
- Authoritative annual actuals: JC's **ACFR / budget PILOT schedule** (PDF/OPRA).
- Mayor Solomon signed a **Jan 2026 EO auditing all active long-term exemptions**
  ([Genova Burns][genova]) — cleaner data may be coming.

## 4. The school-tax explosion is a STATE-AID story, not corruption

The biggest single driver of rising JC tax bills 2018→present is the **2018 S2
law**, which clawed back JC's historically-outsized state education aid
(**~$155M–$276M** in cuts phased in) ([Civic Parent][cp-s2], [NJ Monitor][njm]).
The local school levy had to backfill it:

| BOE school levy | | City levy |
|---|---|---|
| FY2018-19 | $124.4M | 2020: $279M |
| FY2019-20 | $136.5M | 2021: $213M (−$66M) |
| FY2020-21 | $189.2M | |
| FY2021-22 | **$278.0M** | |

By 2021 schools became the **majority of the JC tax bill for the first time since
1998** — because Trenton stopped paying (JC previously funded only ~31% of its
"local fair share"; 87% by 2024), not because the BOE got more wasteful. The BOE
has real governance controversies (special-ed audit, board dysfunction), but
attributing the *tax hikes* to BOE malfeasance is misinfo.

## 5. Fulop's abatement record

"I didn't issue abatements" is **true for a later window, misleading as a career
statement** ([Real Estate NJ][re-nj], [Civic Parent][cp-abate]):

- PILOTs were heavily used by prior Schundler/Cunningham/Healy administrations.
- Fulop revamped the program in 2013 (tiered by census tract to push development
  to Journal Square / Bergen-Lafayette / West Side) and **granted ~70 PILOTs in
  his first two terms** (concentrated 2013-2016).
- **New PILOT approvals then fell to ~zero for several years** — the basis of the
  "no abatements" line.
- JC still carried **160–178 active PILOTs** as of 2020-21 (a mix of his and
  inherited); their 20-30yr terms still suppress the tax base today.

## 6. The $250M deficit & the "flat tax" question

**Fact:** Solomon released a report **Feb 4, 2026** alleging a **~$250M deficit
(~28% of the operating budget)** blamed on one-time-revenue dependence
([JC official][jc-deficit], [Hudson Reporter][hr-deficit]): ~1,000 city properties
sold for ≥$100M ($33M used in 2025 alone), ~$100M ARP funds used substantially for
a 2021 election-year tax cut, depleted reserves, late-payment penalties.

**Contested:** Fulop responded "We obviously disagree" / "James playing politics."

**Assessment (inference):** the *mechanisms* (masking a structural gap with
non-recurring money) are documented and consistent with the flat-rate pattern.
Whether it's "fraud/shady accounting" or "aggressive-but-legal budgeting that ran
out of props" is unresolved — don't assert fraud.

**"Flat municipal tax for a decade → 15-20% catch-up is just inflation?"** —
partly right, two corrections:

1. **"Flat rate" ≠ "flat revenue."** Fulop kept the municipal *rate* flat in 7 of
   11 budgets (2 more ≤2%) ([Hudson County View][hcv]), but JC's ratable base
   exploded with development, so flat-rate × growing-base still grew nominal city
   revenue. The 2018 revaluation (first since 1988) also reset assessments.
2. **The city's *share* fell (48%→35%) mainly because the *school* share rose**
   (S2), not because the city was uniquely frugal.

**On the increase:** proposed **15%** (revised down from 20%, [CBS][cbs]) **on the
municipal portion only** — ~35% of the total bill. So the effect on a *total* bill
is ~15% × 35% ≈ **~5%**. Cumulative inflation 2014→2026 is ~35-40%, so a ~5%-of-bill
municipal catch-up after a decade of flat nominal rates is within "inflation
normalization" territory — the instinct holds. Solomon's counter isn't that it's
*above* inflation, but that the flatness was only sustainable because one-time
revenues papered over real cost growth. Both can be true.

## Sources

[statute]: https://law.justia.com/codes/new-jersey/title-40a/section-40a-20-12/
[dca-handbook]: https://www.nj.gov/dca/dlgs/misc_docs/Municipal%20Tax%20Abatement%20Handbook%20-%20For%20municipal%20use%20-%20(FINAL%2011.13.2020).pdf
[dca-toolkit]: https://www.nj.gov/dca/dlgs/taxabatementkit.shtml
[cp-abate]: https://civicparent.org/tax-abatements-2/
[cp-levy]: https://civicparent.org/2021/06/30/in-one-chart-jersey-citys-seismic-change-in-tax-levies-fully-funds-the-schools-and-reallocates-property-tax/
[cp-s2]: https://civicparent.org/2023/03/02/jersey-city-set-to-lose-51-million-in-nj-education-aid-how-this-connects-to-rising-school-tax/
[njm]: https://newjerseymonitor.com/2024/02/16/senate-panel-backs-larger-tax-hikes-in-towns-facing-school-aid-cuts/
[re-nj]: https://re-nj.com/fulop-outgoing-jersey-city-mayor-reflects-on-policies-behind-historic-development-boom-affordability-push/
[jc-deficit]: https://www.jerseycitynj.gov/news/report_revealing__250_million_budget_deficit
[hr-deficit]: https://hudsonreporter.com/news/jersey-city/jersey-city-250m-deficit-mayor-solomon-1-dollar-salary-2026/
[cbs]: https://www.cbsnews.com/newyork/news/jersey-city-new-jersey-property-tax-increase-james-solomon/
[hcv]: https://hudsoncountyview.com/fulop-lauds-744-57m-prelim-jersey-city-budget-with-0-municipal-tax-hike/
[genova]: https://www.genovaburns.com/news/commercial-real-estate/2026-02-02-jersey-city-issues-executive-order-on-pilot-audits-what-developers-and-owners-need-to-know
