import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../theme'
import { chartColors, baseLayout, plotConfig } from './plotly'
import levyRaw from '../../public/data/jc_levy_split.json'

type Row = {
  year: number
  school: number
  municipal: number
  municipal_budget: number
  county: number
  total_levy: number
}
const ROWS = (levyRaw as Row[]).slice().sort((a, b) => a.year - b.year)
const mil = (v: number) => v / 1e6
const milStr = (v: number) => `$${Math.round(v / 1e6).toLocaleString()}M`

// The three-way split of JC's total property-tax levy, stacked per year.
// School on the bottom (it's the story — it more than doubled since 2021),
// then municipal, then county. A transparent "Total" trace carries the
// year total into the x-unified hover box; text annotations label each bar top.
export function LevyChart() {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const years = ROWS.map(r => String(r.year))
    const seg = (name: string, key: keyof Row, color: string): Data => ({
      type: 'bar', name, x: years, y: ROWS.map(r => mil(r[key])),
      marker: { color }, hovertemplate: `${name}: $%{y:,.0f}M<extra></extra>`,
    })
    const data: Data[] = [
      seg('Schools', 'school', c.school),
      seg('City', 'municipal', c.municipal),
      seg('County', 'county', c.county),
      {
        type: 'scatter', mode: 'text', name: 'Total', x: years,
        y: ROWS.map(r => mil(r.total_levy)),
        text: ROWS.map(r => milStr(r.total_levy)),
        textposition: 'top center', textfont: { size: 12, color: c.total },
        cliponaxis: false, showlegend: false, hoverinfo: 'skip',
      },
    ]
    const maxTotal = Math.max(...ROWS.map(r => mil(r.total_levy)))
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      margin: { l: 64, r: 20, t: 24, b: 32 },
      barmode: 'stack',
      hovermode: 'x unified',
      xaxis: { type: 'category' },
      yaxis: { title: { text: 'Tax levy' }, tickprefix: '$', ticksuffix: 'M', tickformat: ',.0f', range: [0, maxTotal * 1.12] },
    }
    return { data, layout }
  }, [isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 380 }} />
}
