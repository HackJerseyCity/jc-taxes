import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Props = {
  values: number[]
  percentile: number | undefined
  max: number
  prefix: string
  metricLabel: string
  // Compact formatter for wide-range metrics (e.g. total $: "$1.2M"); replaces
  // `prefix` + raw number in axis ticks and the hover readout.
  format?: (n: number) => string
  // Bin spacing. Linear bins collapse into a single spike for metrics spanning
  // orders of magnitude (total $ per block: $525k median, $80.8M max — 97% of
  // blocks land in bin 0), so those pass 'log'.
  binScale?: 'linear' | 'log'
}

const NUM_BINS = 40
const W = 220
const H = 80
const PAD = { top: 4, right: 28, bottom: 16, left: 4 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

type BinData = { lo: number; hi: number; count: number; cumPct: number }

export default function DistributionChart({ values, percentile, max, prefix, metricLabel, format, binScale = 'linear' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const n = values.length
  const [hoverBin, setHoverBin] = useState<number | null>(null)
  const fmt = useCallback(
    (v: number) => format ? format(v) : `${prefix}${v < 10 ? v.toFixed(1) : Math.round(v)}`,
    [format, prefix],
  )

  // Value ⇄ x-position (0-1). Log bins use log1p so 0 still maps to 0.
  const logMax = Math.log1p(max)
  const toPos = useCallback(
    (v: number) => binScale === 'log' ? (v <= 0 ? 0 : Math.log1p(v) / logMax) : v / max,
    [binScale, logMax, max],
  )
  const fromPos = useCallback(
    (p: number) => binScale === 'log' ? Math.expm1(p * logMax) : p * max,
    [binScale, logMax, max],
  )

  const bins = useMemo((): BinData[] => {
    if (n === 0) return []
    const counts = new Array(NUM_BINS).fill(0)
    for (const v of values) {
      counts[Math.min(Math.floor(toPos(v) * NUM_BINS), NUM_BINS - 1)]++
    }
    let cum = 0
    return counts.map((count, i) => {
      cum += count
      return { lo: fromPos(i / NUM_BINS), hi: fromPos((i + 1) / NUM_BINS), count, cumPct: cum / n * 100 }
    })
  }, [values, n, toPos, fromPos])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || bins.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const maxBin = Math.max(...bins.map(b => b.count))
    if (maxBin === 0) return

    const style = getComputedStyle(canvas)
    const textSecondary = style.getPropertyValue('color') || 'rgba(150,150,150,0.6)'

    // Histogram bars
    for (let i = 0; i < NUM_BINS; i++) {
      if (bins[i].count === 0) continue
      const x = PAD.left + (i / NUM_BINS) * PLOT_W
      const barW = PLOT_W / NUM_BINS - 0.5
      const barH = (bins[i].count / maxBin) * PLOT_H
      ctx.fillStyle = i === hoverBin ? '#ff9800' : textSecondary
      ctx.globalAlpha = i === hoverBin ? 0.7 : 0.35
      ctx.fillRect(x, PAD.top + PLOT_H - barH, barW, barH)
    }
    ctx.globalAlpha = 1

    // CDF line
    ctx.strokeStyle = '#4fc3f7'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < NUM_BINS; i++) {
      const x = PAD.left + ((i + 0.5) / NUM_BINS) * PLOT_W
      const y = PAD.top + PLOT_H - (bins[i].cumPct / 100) * PLOT_H
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // CDF axis labels (right side)
    ctx.fillStyle = '#4fc3f7'
    ctx.globalAlpha = 0.7
    ctx.font = '9px system-ui'
    ctx.textAlign = 'left'
    ctx.fillText('100%', PAD.left + PLOT_W + 2, PAD.top + 8)
    ctx.fillText('0%', PAD.left + PLOT_W + 2, PAD.top + PLOT_H)
    ctx.globalAlpha = 1

    // Percentile marker
    if (percentile != null && percentile < 100) {
      const pctIdx = Math.floor(n * percentile / 100)
      const pctVal = values[Math.min(pctIdx, n - 1)]
      const x = PAD.left + Math.min(toPos(pctVal), 1) * PLOT_W
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = '#ff9800'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, PAD.top)
      ctx.lineTo(x, PAD.top + PLOT_H)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // X-axis tick labels
    ctx.fillStyle = textSecondary
    ctx.globalAlpha = 0.7
    ctx.font = '9px system-ui'
    ctx.textAlign = 'center'
    // Ticks are evenly spaced on screen, so their values follow the bin scale
    for (const p of [0, 0.5, 1]) {
      ctx.fillText(fmt(fromPos(p)), PAD.left + p * PLOT_W, H - 2)
    }
    ctx.globalAlpha = 1
  }, [values, bins, n, percentile, max, prefix, metricLabel, hoverBin, fmt, toPos, fromPos])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const binIdx = Math.floor(((x - PAD.left) / PLOT_W) * NUM_BINS)
    setHoverBin(binIdx >= 0 && binIdx < NUM_BINS ? binIdx : null)
  }, [])

  const onMouseLeave = useCallback(() => setHoverBin(null), [])

  if (n === 0) return null

  const hovered = hoverBin != null ? bins[hoverBin] : null

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: W, height: H, display: 'block', color: 'var(--text-secondary)', cursor: 'crosshair' }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
      {hovered && hovered.count > 0 && (
        <div style={{
          position: 'absolute',
          left: PAD.left + ((hoverBin! + 0.5) / NUM_BINS) * PLOT_W,
          top: 0,
          transform: 'translateX(-50%)',
          background: 'var(--panel-bg)',
          border: '1px solid var(--input-border)',
          borderRadius: 3,
          padding: '2px 5px',
          fontSize: 10,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          lineHeight: 1.4,
        }}>
          <div>{fmt(hovered.lo)}–{fmt(hovered.hi)}{metricLabel}</div>
          <div>{hovered.count.toLocaleString()} parcels ({hovered.cumPct.toFixed(0)}%)</div>
        </div>
      )}
    </div>
  )
}
