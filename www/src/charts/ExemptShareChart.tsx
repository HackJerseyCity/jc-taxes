import * as Plot from '@observablehq/plot'
import { useCallback } from 'react'
import { PlotChart, palette, unifiedTip } from './PlotChart'
import exemptRaw from '../../public/data/modiv_exempt_share.json'

type Row = { year: number, mun: string, name: string, total_value: number, exempt_value: number, exempt_share: number }
const ALL = exemptRaw as Row[]

// Years × munis. We overlay JC's exempt share against the
// (totals-weighted) Hudson-County aggregate to make the comparison fair —
// East Newark's 421 parcels shouldn't pull the average the same as JC's 64k.
export function ExemptShareChart({ mun = '0906' }: { mun?: string }) {
  const build = useCallback((theme: 'light' | 'dark', width: number) => {
    const p = palette(theme)
    // Weighted Hudson average per year:
    //   exempt_share_hudson(y) = Σ exempt_value(y) / Σ total_value(y)
    const years = Array.from(new Set(ALL.map(r => r.year))).sort()
    const hudson = years.map(y => {
      const yr = ALL.filter(r => r.year === y)
      const tot = yr.reduce((s, r) => s + r.total_value, 0)
      const ex = yr.reduce((s, r) => s + r.exempt_value, 0)
      return { year: y, series: 'Hudson County', exempt_share: tot ? ex / tot : 0 }
    })
    const muni = ALL.filter(r => r.mun === mun).map(r => ({
      year: r.year,
      series: r.name,
      exempt_share: r.exempt_share,
    }))
    const muniName = muni[0]?.series ?? 'Jersey City'
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`
    const wide = years.map(y => ({
      year: y,
      [muniName]: muni.find(r => r.year === y)?.exempt_share ?? 0,
      'Hudson County': hudson.find(r => r.year === y)?.exempt_share ?? 0,
    }))
    return {
      width,
      marginLeft: 56,
      marginBottom: 36,
      x: { label: null, ticks: years, tickFormat: (d: number) => String(d) },
      y: { label: 'Exempt share of assessed value', tickFormat: '.0%', grid: true, domain: [0, 0.35] },
      color: {
        domain: [muni[0]?.series ?? 'Jersey City', 'Hudson County'],
        range:  [p.jc, p.muted],
        legend: true,
      },
      style: { background: 'transparent', color: p.text, fontSize: '12px' },
      marks: [
        Plot.lineY([...muni, ...hudson], { x: 'year', y: 'exempt_share', stroke: 'series', strokeWidth: 2.5, curve: 'monotone-x', marker: 'circle' }),
        Plot.ruleY([0], { stroke: p.muted }),
        Plot.ruleX(wide, Plot.pointerX({ x: 'year', stroke: p.muted, strokeOpacity: 0.4 })),
        unifiedTip(wide, {
          x: 'year',
          y: muniName,
          series: [muniName, 'Hudson County'],
          format: pct,
          header: d => String(d.year),
        }),
      ],
    } as Plot.PlotOptions
  }, [mun])
  return <PlotChart build={build} ariaLabel="Exempt share of assessed value over time, Jersey City vs Hudson County" />
}
