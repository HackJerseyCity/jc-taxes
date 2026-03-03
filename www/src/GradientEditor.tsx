import { useState, useRef, useCallback, useMemo, useEffect } from 'react'

export type ColorStop = {
  value: number
  color: [number, number, number]
}

export type ScaleType = 'linear' | 'sqrt' | 'log'

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
}

// Convert value to position (0-1) based on scale
function valueToPosition(value: number, max: number, scale: ScaleType, min = 0): number {
  const range = max - min
  const clamped = Math.max(0, Math.min(value - min, range))
  switch (scale) {
    case 'sqrt':
      return Math.sqrt(clamped / range)
    case 'log':
      if (clamped <= 0) return 0
      return Math.log1p(clamped) / Math.log1p(range)
    default:
      return clamped / range
  }
}

// Convert position (0-1) to value based on scale
function positionToValue(pos: number, max: number, scale: ScaleType, min = 0): number {
  const range = max - min
  const p = Math.max(0, Math.min(pos, 1))
  switch (scale) {
    case 'sqrt':
      return p * p * range + min
    case 'log':
      return Math.expm1(p * Math.log1p(range)) + min
    default:
      return p * range + min
  }
}

// Interpolate color between stops for a given value
export function interpolateColor(
  value: number,
  stops: ColorStop[],
  max: number,
  scale: ScaleType,
  alpha = 180,
  min = 0,
): [number, number, number, number] {
  if (stops.length === 0) return [128, 128, 128, alpha]
  if (stops.length === 1) return [...stops[0].color, alpha]

  const sorted = [...stops].sort((a, b) => a.value - b.value)

  // Find surrounding stops
  if (value <= sorted[0].value) return [...sorted[0].color, alpha]
  if (value >= sorted[sorted.length - 1].value) return [...sorted[sorted.length - 1].color, alpha]

  for (let i = 0; i < sorted.length - 1; i++) {
    if (value >= sorted[i].value && value <= sorted[i + 1].value) {
      const v0 = sorted[i].value
      const v1 = sorted[i + 1].value
      const c0 = sorted[i].color
      const c1 = sorted[i + 1].color

      // Interpolate in scaled space
      const p0 = valueToPosition(v0, max, scale, min)
      const p1 = valueToPosition(v1, max, scale, min)
      const pv = valueToPosition(value, max, scale, min)
      const t = p1 === p0 ? 0 : (pv - p0) / (p1 - p0)

      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
        alpha,
      ]
    }
  }

  return [...sorted[sorted.length - 1].color, alpha]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export default function GradientEditor({ stops, setStops, scale, setScale, max, min = 0, prefix = '$', onReset, metricLabel = '/sqft' }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

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
    const newValue = Math.round(positionToValue(pos, max, scale, min) * 10) / 10

    setStops(stops.map((s, i) => i === dragging ? { ...s, value: newValue } : s))
  }, [dragging, stops, setStops, max, min, scale])

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
          const newValue = Math.round(positionToValue(pos, max, scale, min) * 10) / 10
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
            style={{ ...inputStyle, width: 60 }}
            step={1}
            min={min}
          />
          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{metricLabel}</span>
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
        <span>{prefix}{min}</span>
        <span>{prefix}{max}{metricLabel}</span>
      </div>
    </div>
  )
}

// URL encoding helpers
// Format: "value hex value hex ..." (space-separated pairs, no colons to avoid %3A)
// Backwards-compatible decode also accepts old "value:hex" format
export function encodeStops(stops: ColorStop[]): string {
  return stops
    .map(s => `${s.value} ${s.color.map(c => c.toString(16).padStart(2, '0')).join('')}`)
    .join(' ')
}

export function decodeStops(str: string): ColorStop[] | null {
  try {
    if (!str) return null
    // Old format: "value:hex value:hex ..." (colon-separated)
    if (str.includes(':')) {
      return str.split(/[, ]+/).map(part => {
        const [valueStr, colorStr] = part.split(':')
        return { value: parseFloat(valueStr), color: parseHex(colorStr) }
      })
    }
    // New format: "value hex value hex ..." (space-separated pairs)
    const tokens = str.split(/[, ]+/)
    const stops: ColorStop[] = []
    for (let i = 0; i < tokens.length - 1; i += 2) {
      stops.push({ value: parseFloat(tokens[i]), color: parseHex(tokens[i + 1]) })
    }
    return stops.length > 0 ? stops : null
  } catch {
    return null
  }
}

function parseHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

export const DEFAULT_STOPS_DARK: ColorStop[] = [
  { value: 0, color: [96, 96, 96] },
  { value: 3.8, color: [255, 0, 0] },
  { value: 9.9, color: [255, 217, 26] },
  { value: 92.6, color: [0, 255, 0] },
]

export const DEFAULT_STOPS_LIGHT: ColorStop[] = [
  { value: 0, color: [255, 255, 255] },
  { value: 3.8, color: [255, 71, 71] },
  { value: 9.9, color: [230, 190, 0] },
  { value: 92.6, color: [0, 214, 0] },
]
