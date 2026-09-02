import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../theme'
import { chartColors, baseLayout, plotConfig } from './plotly'
import pilotRaw from '../../public/data/jc_pilots.json'

type Row = { year: number, billed: number, paid: number, n_accounts: number }
const ROWS = (pilotRaw as Row[]).slice().sort((a, b) => a.year - b.year)
const mil = (v: number) => v / 1e6

// PILOT / abatement activity over time. Bars: annual service charges collected
// (identifiable "Ab-*"/"Pilot" bills in the city portal — a lower bound on true
// PILOT revenue). Line (right axis): number of accounts carrying an abatement,
// which rose through ~2016 and now falls as older 20-30yr deals expire and
// revert to conventional tax.
export function PilotChart() {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const years = ROWS.map(r => String(r.year))
    const data: Data[] = [
      {
        type: 'bar', name: 'Payments collected', x: years, y: ROWS.map(r => mil(r.paid)),
        marker: { color: c.pilot },
        hovertemplate: 'Collected: $%{y:.0f}M<extra></extra>',
      },
      {
        type: 'scatter', mode: 'lines+markers', name: 'Abated accounts', x: years,
        y: ROWS.map(r => r.n_accounts), yaxis: 'y2',
        line: { color: c.county, width: 2.5 }, marker: { size: 5 },
        hovertemplate: '%{y:,} accounts<extra></extra>',
      },
    ]
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      margin: { l: 56, r: 56, t: 24, b: 32 },
      hovermode: 'x unified',
      xaxis: { type: 'category' },
      yaxis: { title: { text: 'Payments collected' }, tickprefix: '$', ticksuffix: 'M', tickformat: '.0f', rangemode: 'tozero' },
      yaxis2: {
        title: { text: 'Abated accounts' }, overlaying: 'y', side: 'right',
        rangemode: 'tozero', showgrid: false,
      },
    }
    return { data, layout }
  }, [isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 380 }} />
}
