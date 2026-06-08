import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette } from './PlotChart'
import taxBaseRaw from '../../public/data/modiv_tax_base.json'

type Row = { year: number, mun: string, name: string, parcels: number, net_value: number, land_value: number, improvement_value: number }
const ALL = taxBaseRaw as Row[]

const billions = (v: number) => `$${(v / 1e9).toFixed(1)}B`

export function MuniCompareChart({ year = 2025, highlight = '0906' }: { year?: number, highlight?: string }) {
  const build = useCallback((theme: 'light' | 'dark', width: number) => {
    const p = palette(theme)
    const rows = ALL
      .filter(r => r.year === year)
      .map(r => ({ ...r, _highlight: r.mun === highlight }))
      .sort((a, b) => b.net_value - a.net_value)
    return {
      width,
      marginLeft: 110,
      marginRight: 60,
      marginBottom: 36,
      x: { label: 'Assessed value', tickFormat: billions, grid: true },
      y: { label: null, domain: rows.map(r => r.name) },
      color: { domain: [true, false], range: [p.jc, p.other], legend: false },
      style: { background: 'transparent', color: p.text, fontSize: '12px' },
      marks: [
        Plot.barX(rows, { x: 'net_value', y: 'name', fill: '_highlight', tip: true }),
        Plot.text(rows, { x: 'net_value', y: 'name', text: (d: typeof rows[number]) => billions(d.net_value), textAnchor: 'start', dx: 6, fill: p.text }),
        Plot.ruleX([0], { stroke: p.muted }),
      ],
    } as Plot.PlotOptions
  }, [year, highlight])
  return <PlotChart build={build} height={420} ariaLabel={`Net assessed value by Hudson County municipality, ${year}`} />
}
