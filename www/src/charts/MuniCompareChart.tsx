import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../ThemeContext'
import { chartColors, baseLayout, plotConfig } from './plotly'
import taxBaseRaw from '../../public/data/modiv_tax_base.json'

type Row = { year: number, mun: string, name: string, parcels: number, net_value: number, land_value: number, improvement_value: number }
const ALL = taxBaseRaw as Row[]
const bilStr = (v: number) => `$${(v / 1e9).toFixed(1)}B`

export function MuniCompareChart({ year = 2025, highlight = '0906' }: { year?: number, highlight?: string }) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const rows = ALL.filter(r => r.year === year).sort((a, b) => a.net_value - b.net_value)
    const names = rows.map(r => r.name)
    const data: Data[] = [{
      type: 'bar', orientation: 'h', x: rows.map(r => r.net_value / 1e9), y: names,
      marker: { color: rows.map(r => (r.mun === highlight ? c.jc : c.other)) },
      text: rows.map(r => bilStr(r.net_value)), textposition: 'outside',
      cliponaxis: false, hovertemplate: '%{y}: $%{x:.1f}B<extra></extra>',
    }]
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      margin: { l: 110, r: 60, t: 8, b: 32 },
      showlegend: false,
      hovermode: 'closest',
      xaxis: { title: { text: 'Assessed value' }, tickprefix: '$', ticksuffix: 'B', tickformat: '.0f' },
      yaxis: { categoryorder: 'array', categoryarray: names },
    }
    return { data, layout }
  }, [year, highlight, isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 420 }} />
}
