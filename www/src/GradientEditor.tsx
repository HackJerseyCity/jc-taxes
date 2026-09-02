import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { type ColorStop, type ScaleType, valueToPosition, positionToValue, rgbToHex, hexToRgb } from './gradient'

type Props = {
  stops: ColorStop[]
  setStops: (stops: ColorStop[]) => void
  scale: ScaleType
  setScale: (scale: ScaleType) => void
  max: number
  min?: number
  prefix?: string
  onReset?: () => void
  metricLabel?: string
  // Compact formatter for wide-range metrics (e.g. total $: "$1.2M"). When set,
  // it replaces `prefix` + raw number in the axis labels.
  format?: (n: number) => string
}

export default function GradientEditor({ stops, setStops, scale, setScale, max, min = 0, prefix = '$', onReset, metricLabel = '/sqft', format }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

  // Coarse stops for wide-range metrics only (i.e. whoever passes `format`):
  // 0.1 steps are meaningful for $/sqft and years, meaningless for
  // million-dollar totals. Keyed off `format` rather than `max` so the existing
  // $/capita (max 15k) and year-built (max 2025) editors keep 1-unit steps.
  const coarse = format != null
  const roundStop = useCallback(
    (v: number) => coarse ? Math.round(v) : Math.round(v * 10) / 10,
    [coarse],
  )
  const stopStep = coarse ? Math.max(1, Math.round(max / 1000)) : 1
  const fmt = useCallback(
    (v: number) => format ? format(v) : `${prefix}${v}`,
    [format, prefix],
  )

  const sortedStops = useMemo(() =>
    [...stops].sort((a, b) => a.value - b.value),
    [stops]
  )

  // Generate CSS gradient for preview
  const gradientCss = useMemo(() => {
    if (sortedStops.length === 0) return 'linear-gradient(to right, #808080, #808080)'
    if (sortedStops.length === 1) {
      const c = rgbToHex(...sortedStops[0].color)
      return `linear-gradient(to right, ${c}, ${c})`
    }

    const colorStops = sortedStops.map(s => {
      const pos = valueToPosition(s.value, max, scale, min) * 100
      return `${rgbToHex(...s.color)} ${pos}%`
    })
    return `linear-gradient(to right, ${colorStops.join(', ')})`
  }, [sortedStops, max, min, scale])

  const handleMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(index)
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (dragging === null || !barRef.current) return
    const rect = barRef.current.getBoundingClientRect()
    const pos = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1))
    const newValue = roundStop(positionToValue(pos, max, scale, min))

    setStops(stops.map((s, i) => i === dragging ? { ...s, value: newValue } : s))
  }, [dragging, stops, setStops, max, min, scale, roundStop])

  const handleMouseUp = useCallback(() => {
    setDragging(null)
  }, [])

  // Attach/detach global mouse listeners for dragging
  useEffect(() => {
    if (dragging !== null) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  const addStop = useCallback(() => {
    // Add a stop at the midpoint
    const midValue = (min + max) / 2
    setStops([...stops, { value: midValue, color: [200, 200, 200] }])
  }, [stops, setStops, min, max])

  const removeStop = useCallback((index: number) => {
    if (stops.length <= 2) return // Keep at least 2 stops
    setStops(stops.filter((_, i) => i !== index))
  }, [stops, setStops])

  const updateStopColor = useCallback((index: number, hex: string) => {
    setStops(stops.map((s, i) => i === index ? { ...s, color: hexToRgb(hex) } : s))
  }, [stops, setStops])

  const updateStopValue = useCallback((index: number, value: number) => {
    setStops(stops.map((s, i) => i === index ? { ...s, value } : s))
  }, [stops, setStops])

  const inputStyle = {
    background: 'var(--input-bg)',
    color: 'var(--text-primary)',
    border: '1px solid var(--input-border)',
    borderRadius: 4,
    padding: '2px 4px',
    fontSize: 12,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Scale:</span>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as ScaleType)}
          style={inputStyle}
        >
          <option value="linear">linear</option>
          <option value="sqrt">sqrt</option>
          <option value="log">log</option>
        </select>
        <button
          onClick={addStop}
          style={{ ...inputStyle, cursor: 'pointer', padding: '2px 8px' }}
        >
          + Add
        </button>
        {onReset && (
          <button
            onClick={onReset}
            title="Reset to defaults"
            style={{ ...inputStyle, cursor: 'pointer', padding: '2px 6px', fontSize: 14 }}
          >
            ↺
          </button>
        )}
      </div>

      {/* Gradient bar with handles */}
      <div
        ref={barRef}
        style={{
          position: 'relative',
          height: 24,
          background: gradientCss,
          borderRadius: 4,
          border: '1px solid var(--input-border)',
          cursor: 'crosshair',
        }}
        onClick={(e) => {
          if (dragging !== null) return
          const rect = barRef.current?.getBoundingClientRect()
          if (!rect) return
          const pos = (e.clientX - rect.left) / rect.width
          const newValue = roundStop(positionToValue(pos, max, scale, min))
          setStops([...stops, { value: newValue, color: [200, 200, 200] }])
        }}
      >
        {stops.map((stop, i) => {
          const pos = valueToPosition(stop.value, max, scale, min) * 100
          return (
            <div
              key={i}
              onMouseDown={(e) => handleMouseDown(i, e)}
              onClick={(e) => {
                e.stopPropagation()
                setEditingIndex(editingIndex === i ? null : i)
              }}
              style={{
                position: 'absolute',
                left: `${pos}%`,
                top: -4,
                transform: 'translateX(-50%)',
                width: 12,
                height: 32,
                background: rgbToHex(...stop.color),
                border: '2px solid white',
                borderRadius: 3,
                cursor: 'grab',
                boxShadow: editingIndex === i ? '0 0 0 2px var(--text-accent)' : '0 1px 3px rgba(0,0,0,0.5)',
              }}
            />
          )
        })}
      </div>

      {/* Stop editor */}
      {editingIndex !== null && stops[editingIndex] && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          background: 'var(--bg-tertiary)',
          borderRadius: 4,
        }}>
          <input
            type="color"
            value={rgbToHex(...stops[editingIndex].color)}
            onChange={(e) => updateStopColor(editingIndex, e.target.value)}
            style={{ width: 32, height: 24, padding: 0, border: 'none', cursor: 'pointer' }}
          />
          <span>{prefix}</span>
          <input
            type="number"
            value={stops[editingIndex].value}
            onChange={(e) => updateStopValue(editingIndex, Number(e.target.value))}
            style={{ ...inputStyle, width: coarse ? 90 : 60 }}
            step={stopStep}
            min={min}
          />
          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
            {format ? format(stops[editingIndex].value) : null}{metricLabel}
          </span>
          <button
            onClick={() => {
              removeStop(editingIndex)
              setEditingIndex(null)
            }}
            disabled={stops.length <= 2}
            style={{
              ...inputStyle,
              cursor: stops.length > 2 ? 'pointer' : 'not-allowed',
              opacity: stops.length > 2 ? 1 : 0.5,
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)' }}>
        <span>{fmt(min)}</span>
        <span>{fmt(max)}{metricLabel}</span>
      </div>
    </div>
  )
}
