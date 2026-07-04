import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette, unifiedTip } from './PlotChart'
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
    // One row per year with a field per group (+ total) for the unified tip.
    const years = Array.from(new Set(rows.map(r => r.year))).sort((a, b) => a - b)
    const wide = years.map(y => {
      const rs = rows.filter(r => r.year === y)
      const o: Record<string, unknown> = { year: y }
      let total = 0
      for (const g of GROUP_ORDER) {
        const v = rs.find(r => r.group === g)?.net_value ?? 0
        o[g] = v
        total += v
      }
      o.total = total
      return mode === 'share'
        ? { ...Object.fromEntries(GROUP_ORDER.map(g => [g, total ? (o[g] as number) / total : 0])), year: y, total: 1 }
        : o
    })
    const tipFmt = mode === 'share' ? (v: number) => `${(v * 100).toFixed(1)}%` : billions
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
        }),
        Plot.ruleY([0], { stroke: p.muted }),
        unifiedTip(wide, {
          x: 'year',
          y: 'total',
          // Top-to-bottom of the visual stack (barY stacks GROUP_ORDER[0] at the
          // bottom), so the tip reads in the same order as the segments.
          series: [...GROUP_ORDER].reverse(),
          format: tipFmt,
          header: d => String(d.year),
          total: mode === 'share' ? undefined : 'total',
        }),
      ],
    } as Plot.PlotOptions
  }, [mun, mode])
  return <PlotChart build={build} ariaLabel={`Property class composition by year for ${ALL.find(r => r.mun === mun)?.name ?? mun}`} />
}
