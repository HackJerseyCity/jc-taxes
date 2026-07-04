import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette, unifiedTip } from './PlotChart'
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

const billions = (v: number) => `$${(v / 1e9).toFixed(1)}B`

export function TaxBaseChart({ mun = '0906' }: { mun?: string }) {
  const build = useCallback((theme: 'light' | 'dark', width: number) => {
    const p = palette(theme)
    // Reshape: one row per (year, layer) for the stacked area.
    const muniRows = ALL.filter(r => r.mun === mun)
    const rows = muniRows.flatMap(r => [
      { year: r.year, layer: 'Land',         value: r.land_value },
      { year: r.year, layer: 'Improvements', value: r.improvement_value },
    ])
    const wide = muniRows
      .slice()
      .sort((a, b) => a.year - b.year)
      .map(r => ({
        year: r.year,
        Improvements: r.improvement_value,
        Land: r.land_value,
        total: r.improvement_value + r.land_value,
      }))
    return {
      width,
      marginLeft: 56,
      marginBottom: 36,
      x: { label: null, tickFormat: (d: number) => String(d) },
      y: { label: 'Assessed value', tickFormat: billions, grid: true, nice: true },
      color: {
        domain: ['Improvements', 'Land'],
        range:  [p.improvement, p.land],
        legend: true,
      },
      style: { background: 'transparent', color: p.text, fontSize: '12px' },
      marks: [
        Plot.barY(rows, { x: 'year', y: 'value', fill: 'layer', order: ['Improvements', 'Land'] }),
        Plot.ruleY([0], { stroke: p.muted }),
        unifiedTip(wide, {
          x: 'year',
          y: 'total',
          // Top-to-bottom of the visual stack: Land sits above Improvements.
          series: ['Land', 'Improvements'],
          format: billions,
          header: d => String(d.year),
          total: 'total',
        }),
      ],
    } as Plot.PlotOptions
  }, [mun])
  return <PlotChart build={build} ariaLabel={`Tax base by year for ${ALL.find(r => r.mun === mun)?.name ?? mun}`} />
}
