import { Link } from 'react-router-dom'

// A personal, show-off walkthrough of the map's most surprising views — the
// "here's what I found building this" narrative, complementary to the civic
// explainer at /about. Deep-links jump straight into the live map (jct.rbw.sh)
// with the exact camera + settings for each view.
//
// All dollar figures are 2025 "paid" totals, verified against
// data/payments.parquet (per-account billing) and the ward GeoJSON.

const MAP = 'https://jct.rbw.sh/'

// Verified 2025 ward "paid" totals ($M), from taxes-2025-wards.geojson.
const WARDS: { ward: string, paid: number, cp: string }[] = [
  { ward: 'E', paid: 400.7, cp: 'downtown / waterfront' },
  { ward: 'F', paid: 193.8, cp: 'Bergen-Lafayette / Greenville' },
  { ward: 'D', paid: 186.8, cp: 'the Heights' },
  { ward: 'C', paid: 170.4, cp: 'Journal Square / McGinley' },
  { ward: 'A', paid: 124.4, cp: 'Greenville' },
  { ward: 'B', paid: 111.3, cp: 'West Side' },
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
        <h1 className="story-h1">I mapped where my property taxes go</h1>
        <p className="story-tag">
          I live in Jersey City and got curious about who actually pays the
          city's property taxes — so I scraped every account, joined it to the
          parcel map, and built a 3D view of it. A few things genuinely surprised
          me. Here are my favorite views.
        </p>
        <div className="story-hero-ctas">
          <a className="story-cta" href={MAP} target="_blank" rel="noopener noreferrer">
            Open the interactive map →
          </a>
          <Link to="/about" className="story-cta story-cta-ghost">
            Or: where the money actually goes →
          </Link>
        </div>
      </header>

      <View
        title="99 Hudson: one tower, $17M"
        stat="$16.6M"
        statLabel="paid by a single downtown condo tower in 2025"
        img="/og.gif"
        imgAlt="3D map of downtown Jersey City lots and blocks, extruded by tax density"
        href={`${MAP}?v=40.7309-74.0630+12.3+52-28&agg=lot&sel=14507-1`}
      >
        <p>
          The first thing I clicked was 99 Hudson — New Jersey's tallest building,
          a single supertall condo tower on the waterfront. It's one tax "lot"
          made of 786 individual condos, and together they paid{' '}
          <strong>$16.6M</strong> in 2025. One building, more property tax than
          most whole neighborhoods.
        </p>
      </View>

      <View
        title="Newport is way bigger than I guessed"
        stat="$114.7M"
        statLabel="paid by LeFrak's Newport development in 2025"
        img="/og-west.gif"
        imgAlt="Orbiting view of the Jersey City waterfront towers from the west"
        href={`${MAP}?pf=newport`}
        flip
      >
        <p>
          Newport is LeFrak's master-planned waterfront neighborhood — the mall,
          the office towers, and roughly 4,900 condos. When I first showed this
          off I said it paid "$70–80M." I was wrong: highlighting every Newport
          parcel adds up to <strong>$114.7M</strong> in 2025 — downtown
          development moves the city's tax base more than I'd realized.
        </p>
      </View>

      <View
        title="Harborside: the office waterfront"
        stat="$80.8M"
        statLabel="paid around Harborside / Exchange Place in 2025"
        img="/og-unit.png"
        imgAlt="Individual units in downtown Jersey City extruded by tax paid"
        href={`${MAP}?v=40.7188-74.0563+13.6+66-34&agg=unit&mh=1100&pct=99&sp=br`}
      >
        <p>
          Just south of Newport, the Harborside complex (the old Mack-Cali /
          Veris office waterfront at Exchange Place, now mixed with residential
          towers) paid about <strong>$80.8M</strong> in 2025 — right in line with
          the "$70–80M" I'd guessed. Switch to the <em>units</em> view and each
          apartment becomes its own column, so a single tower fans out into
          hundreds of tiny bills.
        </p>
      </View>

      <section className="story-view story-view-flip">
        <a
          className="story-view-media"
          href={`${MAP}?v=40.7085-74.0300+11.8+54+100&agg=ward&sel=ward-E&wg=blocks`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/og-ward.png" alt="Jersey City wards colored by tax paid, Ward E highlighted" loading="lazy" />
        </a>
        <div className="story-view-body">
          <h2 className="story-view-h">Ward E out-pays the next two wards combined</h2>
          <div className="story-view-stat">
            <span className="story-view-stat-value">$400.7M</span>
            <span className="story-view-stat-label">paid by Ward E in 2025 — 34% of the whole city</span>
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
              Ward E is the downtown/waterfront ward, and it pays more property
              tax than <strong>any other two wards combined</strong> — its
              $400.7M beats Ward F ($193.8M) plus Ward D ($186.8M). All that
              waterfront development shows up as a single glowing corner of the
              city.
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
        title="Height = dollars, not density"
        stat="mt=total"
        statLabel="the view that made it all click"
        img="/total-block.png"
        imgAlt="Jersey City blocks extruded by total dollars paid — downtown towers tower over a flat periphery"
        href={`${MAP}?mt=total`}
      >
        <p>
          By default the map colors by tax <em>density</em> ($/sqft). But flip the
          metric to <strong>total dollars</strong> and every parcel becomes a
          uniform footprint whose <em>height</em> is its actual tax bill. Suddenly
          a handful of downtown towers stand up over a nearly flat rest-of-the-city
          — you can see at a glance where the money comes from.{' '}
          <a href={`${MAP}?mt=total&agg=lot`} target="_blank" rel="noopener noreferrer">
            Try it by lot too →
          </a>
        </p>
      </View>

      <section className="story-portfolios">
        <h2 className="story-view-h">Follow a single developer</h2>
        <div className="story-view-p">
          <p>
            The <code>pf</code> views highlight one owner's parcels across the whole
            city and total up what they paid — handy for seeing how concentrated
            ownership really is. Two to start with:
          </p>
        </div>
        <div className="story-portfolio-links">
          <a href={`${MAP}?pf=newport`} target="_blank" rel="noopener noreferrer">
            LeFrak / Newport →
          </a>
          <a href={`${MAP}?pf=silverman`} target="_blank" rel="noopener noreferrer">
            Silverman Building →
          </a>
        </div>
      </section>

      <footer className="story-foot">
        <p>
          Payments are scraped per-account from Jersey City's tax portal and
          joined to the parcel map; figures here are 2025 "paid" totals. Want the
          civic side — who gets the money (schools, city, county) and what a
          "PILOT" tax break is? <Link to="/about">Read the explainer →</Link>
        </p>
        <p>
          <a href={MAP} target="_blank" rel="noopener noreferrer">Open the interactive map →</a>
        </p>
      </footer>
    </main>
  )
}
