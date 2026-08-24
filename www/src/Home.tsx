import { Link } from 'react-router-dom'
import { PlotlyProvider } from 'pltly/react'
import { loadPlotly } from './charts/plotly'
import { LevyChart } from './charts/LevyChart'
import { PilotChart } from './charts/PilotChart'
import { ExpirationChart } from './charts/ExpirationChart'
import levyRaw from '../public/data/jc_levy_split.json'

type Levy = { year: number, school: number, municipal: number, municipal_budget: number, county: number, total_levy: number }
const LEVY = levyRaw as Levy[]
const at = (y: number) => LEVY.find(r => r.year === y)!
const L25 = at(2025)
const L21 = at(2021)
const pct = (part: number, whole: number) => Math.round((part / whole) * 100)
const bil = (v: number) => `$${(v / 1e9).toFixed(2)}B`
const mil = (v: number) => `$${Math.round(v / 1e6)}M`

function Stat({ label, value, sub }: { label: string, value: string, sub?: string }) {
  return (
    <div className="home-stat">
      <div className="home-stat-value">{value}</div>
      <div className="home-stat-label">{label}</div>
      {sub && <div className="home-stat-sub">{sub}</div>}
    </div>
  )
}

function Section({ id, title, children, chart }: { id?: string, title: string, children: React.ReactNode, chart?: React.ReactNode }) {
  return (
    <section id={id} className="home-section">
      <h2 className="home-section-h">{title}</h2>
      <div className="home-section-p">{children}</div>
      {chart && <div className="home-section-chart">{chart}</div>}
    </section>
  )
}

export default function Home() {
  return (
    <PlotlyProvider loader={loadPlotly}>
    <main className="home">
      <header className="home-hero">
        <h1 className="home-h1">Where Your Property Taxes Go</h1>
        <p className="home-tag">
          A plain-language guide to Jersey City's property taxes: how much the city
          collects, who actually gets it (schools, city, county), and why tax
          breaks called "PILOTs" make the picture more complicated than it looks.
        </p>
        <Link to="/" className="home-cta">Explore the 3D map →</Link>
        <div className="home-stats">
          <Stat label="Total tax levy, 2025" value={bil(L25.total_levy)} sub="all districts combined" />
          <Stat label="Schools' share" value={`${pct(L25.school, L25.total_levy)}%`} sub={`up from ${pct(L21.school, L21.total_levy)}% in 2021`} />
          <Stat label="City operating budget" value={mil(L25.municipal_budget)} sub="a slice of the city's share" />
        </div>
      </header>

      <Section id="split" title="Your tax bill is really three bills" chart={<LevyChart />}>
        <p>
          The property tax you pay isn't one thing — it's collected by the city but
          split three ways: the <strong>public schools</strong>, the{' '}
          <strong>city</strong> government, and <strong>Hudson County</strong>. In
          2025 Jersey City's total levy was {bil(L25.total_levy)}: schools got{' '}
          {mil(L25.school)} ({pct(L25.school, L25.total_levy)}%), the city{' '}
          {mil(L25.municipal)} ({pct(L25.municipal, L25.total_levy)}%), and the county{' '}
          {mil(L25.county)} ({pct(L25.county, L25.total_levy)}%).
        </p>
        <p>
          You may have seen the figure that "Jersey City brings in {mil(L25.municipal_budget)}."
          That's the city's own <em>operating budget</em> — a piece of the city's{' '}
          {mil(L25.municipal)} share, not the whole property-tax pie. It's why the
          number officials quote can look ~3× smaller than the total on a full tax bill.
        </p>
      </Section>

      <Section id="schools" title="Why the schools' slice jumped the most">
        <p>
          The biggest recent shift is the schools' share climbing from{' '}
          {pct(L21.school, L21.total_levy)}% to {pct(L25.school, L25.total_levy)}% in
          four years — the local school levy more than doubled, from {mil(L21.school)}{' '}
          (2021) to {mil(L25.school)} (2025).
        </p>
        <p>
          The cause is a 2018 state law (nicknamed "S2") that phased out decades of
          extra state aid Jersey City had received. As that aid was clawed back, the
          gap had to be filled locally — so the school portion of everyone's property
          tax rose sharply. Most of the increase in JC tax bills since 2021 traces
          back to this, not to the city budget.
        </p>
      </Section>

      <Section id="pilots" title="What's a PILOT (tax abatement)?">
        <p>
          A <strong>PILOT</strong> — "Payment In Lieu Of Taxes" — is a tax break for
          new development. Under New Jersey's Long Term Tax Exemption Law, a developer
          can be exempted from normal property tax for 5–30 years and instead pay the
          city a negotiated <em>annual service charge</em>, usually a percentage of the
          building's revenue and typically less than full taxes would be.
        </p>
        <p>
          Here's the catch, and why PILOTs are controversial:{' '}
          <strong>a PILOT is split differently than a normal tax bill.</strong> Roughly
          95% goes to the city and about 5% to the county — and the{' '}
          <strong>schools get nothing</strong>. Normal property tax funds all three.
          So every abated building shifts the load: the city keeps almost all the
          money, while the schools and county are left out. Supporters argue the deals
          spur construction that wouldn't happen otherwise; critics argue they starve
          the school district exactly as enrollment and costs rise.
        </p>
      </Section>

      <Section id="abatements" title="Abatements over time" chart={<PilotChart />}>
        <p>
          Jersey City leaned on abatements heavily through the 2000s and 2010s. The
          number of abated accounts climbed from roughly 1,600 in 2005 to a peak
          around 4,000 by 2016, and the annual service charges collected grew into the
          nine figures at their peak.
        </p>
        <p>
          Since then the count has been <em>falling</em> — older 20-to-30-year deals
          are reaching the end of their terms and reverting to conventional taxation.
          As they convert, that value finally starts contributing to the schools and
          county again.
        </p>
      </Section>

      <Section id="expirations" title="Which abatements have rolled off, and when" chart={<ExpirationChart />}>
        <p>
          Abatements don't expire one unit at a time — a whole development converts at
          once when its term ends. You can see the waves in the tax portal: the{' '}
          <strong>Port Liberté</strong> condos in 2016, <strong>James Monroe</strong>'s
          442 waterfront units in 2018, <strong>Port Liberté II</strong> in 2020, and{' '}
          <strong>TCR Pier House</strong> in 2022. Each bar counts the accounts whose
          last abatement bill fell that year, grouped by development.
        </p>
        <p>
          This is the <em>history</em> of expirations. Projecting the <em>future</em>
          — when today's ~2,700 still-active abatements will roll off — needs each
          deal's negotiated term and end date, which aren't in the public tax-portal
          data. That would take Jersey City's per-agreement PILOT schedule (from the
          abatement ordinances or the city's financial-report disclosures).
        </p>
      </Section>

      <footer className="home-foot">
        <p>
          Levy split from the{' '}
          <a href="https://www.nj.gov/treasury/taxation/lpt/absractratables.shtml" target="_blank" rel="noopener noreferrer">NJ DLGS Abstract of Ratables</a>{' '}
          (Hudson County, 2021–2025). Abatement activity aggregated from the city's{' '}
          per-parcel tax portal.
          {' '}
          <Link to="/">Open the interactive map →</Link>
        </p>
        <p className="home-foot-caveat">
          <em>Caveats:</em> the PILOT dollars shown are identifiable abatement bills in
          the tax portal — a lower bound on the city's full PILOT revenue, meant to show
          the trajectory rather than an exact total. The 95/5/0 PILOT split and the
          state-aid history are structural facts of NJ law and JC's budget, not derived
          from this dataset.
        </p>
      </footer>
    </main>
    </PlotlyProvider>
  )
}
