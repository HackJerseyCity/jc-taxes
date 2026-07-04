import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import type { Data, Layout } from 'plotly.js'
import { useTheme } from '../ThemeContext'
import { chartColors, baseLayout, plotConfig } from './plotly'
import classRaw from '../../public/data/modiv_class_composition.json'

type Row = { year: number, mun: string, name: string, group: string, parcels: number, net_value: number }
const ALL = classRaw as Row[]
const GROUP_ORDER = ['residential', 'commercial', 'apartment', 'industrial', 'exempt', 'vacant', 'other']
const bil = (v: number) => v / 1e9

export function ClassCompositionChart({ mun = '0906' }: { mun?: string }) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const { data, layout } = useMemo(() => {
    const c = chartColors(isDark)
    const rows = ALL.filter(r => r.mun === mun)
    const years = Array.from(new Set(rows.map(r => r.year))).sort((a, b) => a - b)
    const yearStrs = years.map(String)
    const valOf = (g: string, y: number) => rows.find(r => r.group === g && r.year === y)?.net_value ?? 0
    const data: Data[] = GROUP_ORDER.map(g => ({
      type: 'bar', name: g, x: yearStrs, y: years.map(y => bil(valOf(g, y))),
      marker: { color: c.classes[g] }, hovertemplate: `${g}: $%{y:.1f}B<extra></extra>`,
    }))
    data.push({
      type: 'scatter', mode: 'markers', name: 'Total', x: yearStrs,
      y: years.map(y => bil(GROUP_ORDER.reduce((s, g) => s + valOf(g, y), 0))),
      marker: { opacity: 0, size: 0.1 }, showlegend: false,
      hovertemplate: '<b>Total: $%{y:.1f}B</b><extra></extra>',
    })
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
