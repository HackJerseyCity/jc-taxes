import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette } from './PlotChart'
import classRaw from '../../public/data/modiv_class_composition.json'

type Row = { year: number, mun: string, name: string, group: string, parcels: number, net_value: number }
const ALL = classRaw as Row[]

const GROUP_ORDER = ['residential', 'commercial', 'apartment', 'industrial', 'exempt', 'vacant', 'other']

const billions = (v: number) => `$${(v / 1e9).toFixed(1)}B`

export function ClassCompositionChart({ mun = '0906', mode = 'absolute' as 'absolute' | 'share' }: { mun?: string, mode?: 'absolute' | 'share' }) {
  const build = useCallback((theme: 'light' | 'dark', width: number) => {
    const p = palette(theme)
    const rows = ALL.filter(r => r.mun === mun)
    const range = GROUP_ORDER.map(g => p.classes[g])
    return {
      width,
      marginLeft: 56,
      marginBottom: 36,
      x: { label: null, tickFormat: (d: number) => String(d) },
      y: {
        label: mode === 'share' ? 'Share of assessed value' : 'Assessed value',
        tickFormat: mode === 'share' ? '.0%' : billions,
        grid: true,
      },
      color: { domain: GROUP_ORDER, range, legend: true },
      style: { background: 'transparent', color: p.text, fontSize: '12px' },
      marks: [
        Plot.barY(rows, {
          x: 'year',
          y: 'net_value',
          fill: 'group',
          order: GROUP_ORDER,
          offset: mode === 'share' ? 'normalize' : undefined,
          tip: true,
        }),
        Plot.ruleY([0], { stroke: p.muted }),
      ],
    } as Plot.PlotOptions
  }, [mun, mode])
  return <PlotChart build={build} ariaLabel={`Property class composition by year for ${ALL.find(r => r.mun === mun)?.name ?? mun}`} />
}
