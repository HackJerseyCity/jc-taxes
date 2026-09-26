import { Link } from 'react-router-dom'

// Findings: a terse walkthrough of notable views, each deep-linked into the
// live map (jct.rbw.sh) with its camera + settings. Complements the levy /
// PILOT explainer at /about.
//
// Figures are taxes paid (HLS billing ledger), computed from the published
// per-year GeoJSONs; shares are of the citywide total for the same year.

const MAP = 'https://jct.rbw.sh/'

// 2025 "paid" totals by ward ($M), from taxes-2025-wards.geojson.
const WARDS: { ward: string, paid: number }[] = [
  { ward: 'E', paid: 417.5 },
  { ward: 'D', paid: 199.1 },
  { ward: 'F', paid: 196.7 },
  { ward: 'C', paid: 176.8 },
  { ward: 'A', paid: 128.4 },
  { ward: 'B', paid: 112.7 },
]
const WARD_MAX = Math.max(...WARDS.map(w => w.paid))

function View(
  { title, stat, statLabel, img, imgAlt, href, children, flip }: {
    title: string
    stat: string
    statLabel: string
    img: string
    imgAlt: string
    href: string
    children: React.ReactNode
    flip?: boolean
  },
) {
  return (
    <section className={`story-view${flip ? ' story-view-flip' : ''}`}>
      <a className="story-view-media" href={href} target="_blank" rel="noopener noreferrer">
        <img src={img} alt={imgAlt} loading="lazy" />
      </a>
      <div className="story-view-body">
        <h2 className="story-view-h">{title}</h2>
        <div className="story-view-stat">
          <span className="story-view-stat-value">{stat}</span>
          <span className="story-view-stat-label">{statLabel}</span>
        </div>
        <div className="story-view-p">{children}</div>
        <a className="story-view-link" href={href} target="_blank" rel="noopener noreferrer">
          Open in the map →
        </a>
      </div>
    </section>
  )
}

export default function Story() {
  return (
    <main className="story">
      <header className="story-hero">
        <h1 className="story-h1">Jersey City property taxes: findings</h1>
        <p className="story-tag">
          Per-account billing and payment history for ~70k accounts (2015–2025),
          scraped from the city's HLS tax portal and joined to NJGIN parcel
          geometry. Figures are taxes paid; citywide 2025 total: <strong>$1.231B</strong>,
          up from $589.7M in 2015 (×2.09).
        </p>
        <div className="story-hero-ctas">
          <a className="story-cta" href={MAP} target="_blank" rel="noopener noreferrer">
            Map →
          </a>
          <Link to="/about" className="story-cta story-cta-ghost">
            Levy split, PILOTs →
          </Link>
        </div>
      </header>

      <View
        title="99 Hudson St: 1.35% of the city's taxes on one lot"
        stat="$16.59M"
        statLabel="2025 · 787 units · 76.5k sqft lot · $217/sqft"
        img="/story/99hudson.png"
        imgAlt="99 Hudson St selected in the lot view, extruded by tax paid per sqft"
        href={`${MAP}?v=40.7309-74.0630+12.3+52-28&agg=lot&sel=14507-1`}
      >
        <p>
          Block 14507, lot 1. $1.2M (2018, pre-completion) → $8.7M (2020) →
          $11.4M (2021) → $15.3M (2022) → $16.6M (2025), as units were assessed.
        </p>
      </View>

      <View
        title="Newport: 9.3% of citywide taxes"
        stat="$115.1M"
        statLabel="2025 · 6 waterfront tax blocks · mall, offices, ~4,900 condos"
        img="/story/newport.png"
        imgAlt="Newport's six tax blocks highlighted; rest of the city dimmed"
        href={`${MAP}?v=40.7271-74.0350+14.2+37-30&pf=newport`}
        flip
      >
        <p>
          $57.0M (2015) → $66.5M (2018) → $115.1M (2025). Share of the city total
          held at 9–10% throughout. The 2021–23 step (+$35M) coincides with PILOT
          expirations and reassessment; parcel count is flat (~1,385). Totals
          include PILOT service charges billed through HLS.
        </p>
      </View>

      <View
        title="Harborside (block 11603): 6.7%"
        stat="$82.5M"
        statLabel="2025 · Second St / Marin Blvd / Hudson St · 3.4M sqft"
        img="/story/harborside.png"
        imgAlt="Block 11603 (Harborside) selected in the block view"
        href={`${MAP}?v=40.7165-74.0370+13.9+45-25&agg=block&sel=11603`}
      >
        <p>
          $40.9M (2015) → $55.9M (2018) → $82.5M (2025). $23.53/sqft over the
          whole superblock.
        </p>
      </View>

      <section className="story-view story-view-flip">
        <a
          className="story-view-media"
          href={`${MAP}?v=40.7085-74.0300+11.8+54+100&agg=ward&sel=ward-E&wg=blocks`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/story/ward-e.png" alt="Jersey City wards colored by tax paid, Ward E highlighted" loading="lazy" />
        </a>
        <div className="story-view-body">
          <h2 className="story-view-h">Ward E &gt; any two other wards combined</h2>
          <div className="story-view-stat">
            <span className="story-view-stat-value">$417.5M</span>
            <span className="story-view-stat-label">2025 · 33.9% of citywide</span>
          </div>
          <div className="story-view-wards">
            {WARDS.map(w => (
              <div key={w.ward} className={`story-ward${w.ward === 'E' ? ' story-ward-hi' : ''}`}>
                <span className="story-ward-name">Ward {w.ward}</span>
                <span className="story-ward-bar" style={{ width: `${(w.paid / WARD_MAX) * 100}%` }} />
                <span className="story-ward-val">${w.paid.toFixed(0)}M</span>
              </div>
            ))}
          </div>
          <div className="story-view-p">
            <p>
              2025: E $417.5M vs. D + F $395.8M. Also true in 2015, narrowly:
              E $179.8M vs. A + F $178.7M.
            </p>
          </div>
          <a
            className="story-view-link"
            href={`${MAP}?v=40.7085-74.0300+11.8+54+100&agg=ward&sel=ward-E&wg=blocks`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in the map →
          </a>
        </div>
      </section>

      <View
        title="Total $ view (mt=total)"
        stat="height ∝ $"
        statLabel="uniform column footprint; height = total paid"
        img="/story/total-block.png"
        imgAlt="Jersey City blocks extruded by total dollars paid"
        href={`${MAP}?mt=total`}
      >
        <p>
          The default metric is $/sqft, which favors dense small lots. Total $
          shows where the money comes from in absolute terms.{' '}
          <a href={`${MAP}?mt=total&agg=lot`} target="_blank" rel="noopener noreferrer">
            By lot →
          </a>
        </p>
      </View>

      <section className="story-portfolios">
        <h2 className="story-view-h">Owner portfolios (pf=)</h2>
        <div className="story-view-p">
          <p>
            <code>?pf=&lt;key&gt;</code> highlights a curated set of parcels and
            reports its parcel count and total paid for the selected year.
          </p>
        </div>
        <div className="story-portfolio-links">
          <a href={`${MAP}?pf=newport`} target="_blank" rel="noopener noreferrer">
            pf=newport →
          </a>
          <a href={`${MAP}?pf=silverman`} target="_blank" rel="noopener noreferrer">
            pf=silverman →
          </a>
        </div>
      </section>

      <footer className="story-foot">
        <p>
          Method: "paid" is the HLS per-account ledger (includes PILOT service
          charges). Payments for sub-lots missing from the parcel geometry are
          folded into their parent/sibling lot. Parcels are clipped to the
          shoreline (TIGER AREAWATER), so $/sqft uses land area only. Levy split
          and PILOT context: <Link to="/about">/about</Link>.
        </p>
      </footer>
    </main>
  )
}
