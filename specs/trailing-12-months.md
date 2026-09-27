# Trailing-12-months (T12M) view, and quarter-granularity playback

## Goal

A "last 12 months" time basis alongside calendar tax years: what each parcel paid (or was billed) over the 4 most recent quarters. It answers "what does this building pay now" without waiting for a tax year to close, and without 2026's billed-basis caveat. Quarter granularity also gives playback 4× the frames, which makes the year-to-year animation smoother (fewer, smaller jumps).

## Data: quarters are in the HLS cache

Every `data/cache/JerseyCity/*.json.gz` record's `accountInquiryVM.Details[]` has one row per bill / payment / adjustment with `TaxYear`, `Quarter` (1–4, due Feb / May / Aug / Nov 1), `TransactionDate`, `Billed`, `Paid`. `jct payments` currently sums these per `TaxYear`.

## Plan

1. **`payments_quarterly.parquet`** (new DVX stage, beside `payments.parquet`): `AccountNumber, Block, Lot, Qualifier, Year, Quarter, Billed, Paid`, keyed by the bill's tax year + quarter (not the payment's transaction date: late payments count toward the quarter they settle, matching the yearly totals). Check: summing quarters reproduces `payments.parquet` exactly.
2. **Per-quarter values**: the bundle's `values-{view}-{year}.bin` gains a quarterly sibling (`values-{view}-q{YYYYQ}.bin`, same format, `[feature][quarter]`), reusing the year-aware geometry (a quarter uses its tax year's parcel set).
3. **T12M** = sum of the latest 4 quarters with bills (for 2026 Q4: 2026 Q1–Q4; mid-year: e.g. 2025 Q4 + 2026 Q1–Q3). Computed client-side from the quarterly values (4 small arrays), or served precomputed as one more "year" in the D1 aggregates (`year = 'T12M'` row per focus) for the chip / sparkline / OG cards.
4. **UI**: year selector gains "Last 12 mo" (URL `y=t12`); `j`/`k` step by quarter while a quarterly mode is on; the rolling year display gains a quarter digit ("2026 Q3"). Playback interpolates between quarters instead of years.
5. **Paid vs billed**: T12M "paid" still lags (the most recent quarter is partly unpaid until its grace period ends); label it with the as-of date of the cache pull.

## Open questions

- Quarter keys: bill quarter (proposed) vs payment `TransactionDate` quarter (a cash-flow view: "money received in the last 12 months").
- Size: 4× the values files. Lots at ~120 KB/year brotli → ~0.5 MB per year of quarters; fetch only the quarters a view needs.
