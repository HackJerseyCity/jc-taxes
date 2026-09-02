// Pure color-gradient logic shared by GradientEditor and the map: stop types,
// value⇄position scaling, color interpolation, URL encode/decode, and the
// default stop ramps. Kept component-free so Fast Refresh stays happy and the
// map can import it without pulling in the editor UI.

export type ColorStop = {
  value: number
  color: [number, number, number]
}

export type ScaleType = 'linear' | 'sqrt' | 'log'

// Convert value to position (0-1) based on scale
export function valueToPosition(value: number, max: number, scale: ScaleType, min = 0): number {
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
export function positionToValue(pos: number, max: number, scale: ScaleType, min = 0): number {
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

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
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
