import { Link } from 'react-router-dom'
import { TaxBaseChart } from './charts/TaxBaseChart'
import { ClassCompositionChart } from './charts/ClassCompositionChart'
import { ExemptShareChart } from './charts/ExemptShareChart'
import { MuniCompareChart } from './charts/MuniCompareChart'

function Stat({ label, value, sub }: { label: string, value: string, sub?: string }) {
  return (
    <div className="home-stat">
      <div className="home-stat-value">{value}</div>
      <div className="home-stat-label">{label}</div>
      {sub && <div className="home-stat-sub">{sub}</div>}
    </div>
  )
}

function Section({ id, title, blurb, children }: { id?: string, title: string, blurb: string, children: React.ReactNode }) {
  return (
    <section id={id} className="home-section">
      <h2 className="home-section-h">{title}</h2>
      <p className="home-section-p">{blurb}</p>
      <div className="home-section-chart">{children}</div>
    </section>
  )
}

export default function Home() {
  return (
    <main className="home">
      <header className="home-hero">
        <h1 className="home-h1">Jersey City Property Taxes</h1>
        <p className="home-tag">
          Where Jersey City's $64 billion of assessed value actually sits, how it's
          grown, and how the city stacks up against its 11 Hudson County neighbors.
        </p>
        <Link to="/map" className="home-cta">Explore the 3D map →</Link>
        <div className="home-stats">
          <Stat label="JC assessed value, 2025" value="$64.1B" sub="up 11.3% since 2021" />
          <Stat label="Tax-exempt share" value="26.6%" sub="$17.0B off the rolls" />
          <Stat label="Share of Hudson County" value="~42%" sub="64,885 of 154k parcels" />
        </div>
      </header>

      <Section
        id="tax-base"
        title="The tax base is growing — almost entirely in improvements"
        blurb="Net assessed value (land + improvements) climbed from $57.6B in 2021 to $64.1B in 2025. Land value barely moved; the gain is all new buildings and value-add (~1,500 net new parcels)."
      >
        <TaxBaseChart />
      </Section>

      <Section
        id="composition"
        title="What's actually on the assessment roll"
        blurb="Residential lots are 65% of parcels but only ~32% of value. Apartments + commercial + the tax-exempt institutions together dominate the dollar totals."
      >
        <ClassCompositionChart />
      </Section>

      <Section
        id="exempt"
        title="The exempt quarter"
        blurb="Jersey City carries an unusually high tax-exempt share by Hudson County standards — institutional landowners (universities, hospitals, housing authorities, religious orgs) account for roughly a quarter of all assessed value."
      >
        <ExemptShareChart />
      </Section>

      <Section
        id="muni-compare"
        title="JC vs the other 11 Hudson munis"
        blurb="By raw assessed value, Jersey City is in a league of its own within Hudson — about 42% of the county total. Hoboken is second."
      >
        <MuniCompareChart />
      </Section>

      <footer className="home-foot">
        <p>
          Data from <a href="https://www.nj.gov/treasury/taxation/lpt/statdata.shtml" target="_blank" rel="noopener noreferrer">NJ Treasury MOD-IV</a> (2021–2025) and per-parcel HLS scrapes.
          {' '}
          <Link to="/map">Open the interactive map →</Link>
        </p>
        <p className="home-foot-caveat">
          <em>Caveats:</em> <code>net_value</code> is assessed (not market) value;
          assessment practices differ per muni, so cross-muni level comparisons deserve
          a grain of salt — trends and composition are safer. The map itself shows
          taxes <em>paid</em>, which is a different lens than assessed value.
        </p>
      </footer>
    </main>
  )
}
