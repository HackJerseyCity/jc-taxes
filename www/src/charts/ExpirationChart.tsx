import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../ThemeContext'
import { baseLayout, plotConfig, projectColor } from './plotly'
import expRaw from '../../public/data/jc_pilot_expirations.json'

type Row = { year: number, project: string, n_accounts: number }
const ROWS = expRaw as Row[]

// Historical abatement-expiration wave: each year, how many accounts hit their
// last PILOT bill (term ended -> reverted to conventional tax), stacked by the
// development they belonged to. The condo-unit cohorts convert en masse — Port
// Liberté in 2016, James Monroe's 442 units in 2018, TCR Pier House in 2022.
export function ExpirationChart() {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const years = Array.from(new Set(ROWS.map(r => r.year))).sort((a, b) => a - b)
    const yearStrs = years.map(String)
    // Projects ranked by total expiring accounts, "Other" forced last (top of stack).
    const totals = new Map<string, number>()
    for (const r of ROWS) totals.set(r.project, (totals.get(r.project) ?? 0) + r.n_accounts)
    const projects = [...totals.keys()]
      .filter(p => p !== 'Other')
      .sort((a, b) => (totals.get(b)! - totals.get(a)!))
    projects.push('Other')

    const valOf = (p: string, y: number) => ROWS.find(r => r.project === p && r.year === y)?.n_accounts ?? 0
    const data: Data[] = projects.map((p, i) => ({
      type: 'bar', name: p, x: yearStrs, y: years.map(y => valOf(p, y)),
      marker: { color: projectColor(p, i, isDark) },
      hovertemplate: `${p}: %{y} accounts<extra></extra>`,
    }))
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      margin: { l: 48, r: 20, t: 8, b: 32 },
      barmode: 'stack',
      hovermode: 'x unified',
      legend: { orientation: 'h', y: 1.14, x: 0, font: { size: 11 } },
      xaxis: { type: 'category' },
      yaxis: { title: { text: 'Abatements expired' }, rangemode: 'tozero' },
    }
    return { data, layout }
  }, [isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 380 }} />
}
