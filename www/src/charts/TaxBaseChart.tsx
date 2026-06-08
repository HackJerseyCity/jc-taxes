import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette } from './PlotChart'
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
    const rows = ALL.filter(r => r.mun === mun).flatMap(r => [
      { year: r.year, layer: 'Land',         value: r.land_value },
      { year: r.year, layer: 'Improvements', value: r.improvement_value },
    ])
    return {
      width,
      marginLeft: 56,
      marginBottom: 36,
      x: { label: null, tickFormat: (d: number) => String(d) },
      y: { label: 'Assessed value', tickFormat: billions, grid: true },
      color: {
        domain: ['Improvements', 'Land'],
        range:  [p.improvement, p.land],
        legend: true,
      },
      style: { background: 'transparent', color: p.text, fontSize: '12px' },
      marks: [
        Plot.areaY(rows, { x: 'year', y: 'value', fill: 'layer', order: ['Improvements', 'Land'], curve: 'monotone-x', fillOpacity: 0.9 }),
        Plot.ruleY([0], { stroke: p.muted }),
      ],
    } as Plot.PlotOptions
  }, [mun])
  return <PlotChart build={build} ariaLabel={`Tax base by year for ${ALL.find(r => r.mun === mun)?.name ?? mun}`} />
}
