import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../ThemeContext'
import { chartColors, baseLayout, plotConfig } from './plotly'
import exemptRaw from '../../public/data/modiv_exempt_share.json'

type Row = { year: number, mun: string, name: string, total_value: number, exempt_value: number, exempt_share: number }
const ALL = exemptRaw as Row[]

// JC's exempt share vs the totals-weighted Hudson-County aggregate (so
// East Newark's 421 parcels don't pull the average like JC's 64k).
export function ExemptShareChart({ mun = '0906' }: { mun?: string }) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const years = Array.from(new Set(ALL.map(r => r.year))).sort((a, b) => a - b)
    const muniRows = ALL.filter(r => r.mun === mun)
    const muniName = muniRows[0]?.name ?? 'Jersey City'
    const muniY = years.map(y => (muniRows.find(r => r.year === y)?.exempt_share ?? 0) * 100)
    const hudsonY = years.map(y => {
      const yr = ALL.filter(r => r.year === y)
      const tot = yr.reduce((s, r) => s + r.total_value, 0)
      const ex = yr.reduce((s, r) => s + r.exempt_value, 0)
      return tot ? (ex / tot) * 100 : 0
    })
    const yearStrs = years.map(String)
    const line = (name: string, y: number[], color: string): Data => ({
      type: 'scatter', mode: 'lines+markers', name, x: yearStrs, y,
      line: { color, width: 2.5 }, marker: { size: 6 },
      hovertemplate: `${name}: %{y:.1f}%<extra></extra>`,
    })
    const data: Data[] = [line(muniName, muniY, c.jc), line('Hudson County', hudsonY, c.other)]
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      hovermode: 'x unified',
      xaxis: { type: 'category' },
      yaxis: { title: { text: 'Exempt share of assessed value' }, ticksuffix: '%', range: [0, 35] },
    }
    return { data, layout }
  }, [mun, isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 360 }} />
}
