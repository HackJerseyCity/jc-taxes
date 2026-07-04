import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../ThemeContext'
import { chartColors, baseLayout, plotConfig } from './plotly'
import taxBaseRaw from '../../public/data/modiv_tax_base.json'

type Row = {
  year: number
  mun: string
  name: string
  parcels: number
  net_value: number
  land_value: number
  improvement_value: number
}
const ALL = taxBaseRaw as Row[]
const bil = (v: number) => v / 1e9

export function TaxBaseChart({ mun = '0906' }: { mun?: string }) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const rows = ALL.filter(r => r.mun === mun).sort((a, b) => a.year - b.year)
    const years = rows.map(r => String(r.year))
    const data: Data[] = [
      {
        type: 'bar', name: 'Improvements', x: years, y: rows.map(r => bil(r.improvement_value)),
        marker: { color: c.improvement }, hovertemplate: 'Improvements: $%{y:.1f}B<extra></extra>',
      },
      {
        type: 'bar', name: 'Land', x: years, y: rows.map(r => bil(r.land_value)),
        marker: { color: c.land }, hovertemplate: 'Land: $%{y:.1f}B<extra></extra>',
      },
      {
        type: 'scatter', mode: 'markers', name: 'Total', x: years,
        y: rows.map(r => bil(r.land_value + r.improvement_value)),
        marker: { opacity: 0, size: 0.1 }, showlegend: false,
        hovertemplate: '<b>Total: $%{y:.1f}B</b><extra></extra>',
      },
    ]
    const layout: Partial<Layout> = {
      ...baseLayout(isDark),
      barmode: 'stack',
      hovermode: 'x unified',
      xaxis: { type: 'category' },
      yaxis: { title: { text: 'Assessed value' }, tickprefix: '$', ticksuffix: 'B', tickformat: '.0f' },
    }
    return { data, layout }
  }, [mun, isDark])
  return <Plot data={data} layout={layout} config={plotConfig} style={{ width: '100%', height: 360 }} />
}
