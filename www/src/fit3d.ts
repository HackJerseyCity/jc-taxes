import { WebMercatorViewport } from '@deck.gl/core'

export interface Camera { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number }

/** Screen rect (px) the fitted content should occupy: the viewport minus
 * overlays (title/chip on top, transport at the bottom). */
export interface Frame { left: number; top: number; right: number; bottom: number }

/**
 * Fit 3D content into `frame` at the given pitch / bearing: the `bounds`
 * footprint at ground level plus `tops` (each bar's top, `[lng, lat, meters]`).
 * `WebMercatorViewport.fitBounds` is 2D (it ignores pitch and extrusion), which
 * under-frames tilted views of tall bars.
 *
 * Bisects zoom: at each candidate zoom, re-centers a few times (so the
 * projected bbox center lands on the frame center; perspective makes this
 * nonlinear) and tests whether the bbox fits the frame. Scaling zoom by the
 * frame / bbox ratio instead diverges when tall bars near the camera blow up
 * under perspective.
 */
export function fit3d(
  bounds: [[number, number], [number, number]],
  tops: [number, number, number][],
  cam: { pitch: number; bearing: number },
  size: { width: number; height: number },
  frame: Frame,
  // Caps single-building focuses, keeping surrounding streets in view.
  maxZoom = 15.5,
): Camera {
  const [[x0, y0], [x1, y1]] = bounds
  const corners: [number, number, number][] = [...tops]
  for (const x of [x0, x1]) for (const y of [y0, y1]) corners.push([x, y, 0])
  const { width, height } = size
  const fcx = (frame.left + frame.right) / 2, fcy = (frame.top + frame.bottom) / 2
  // Screen bbox of the corners at a camera, or null when a point is behind
  // the camera (clip w ≤ 0: it projects mirrored and can look like it fits).
  const bbox = (longitude: number, latitude: number, zoom: number) => {
    const vp = new WebMercatorViewport({ width, height, longitude, latitude, zoom, ...cam })
    const m = vp.viewProjectionMatrix as number[]
    const behind = corners.some(c => {
      const [x, y, z] = vp.projectPosition(c)
      return m[3] * x + m[7] * y + m[11] * z + m[15] <= 0
    })
    if (behind) return null
    const pts = corners.map(c => vp.project(c))
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return { vp, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  }
  const place = (zoom: number) => {
    let longitude = (x0 + x1) / 2, latitude = (y0 + y1) / 2
    for (let i = 0; i < 4; i++) {
      const b = bbox(longitude, latitude, zoom)
      if (!b) return { longitude, latitude, fits: false }
      // Move the camera so the box center shifts to the frame center.
      ;[longitude, latitude] = b.vp.unproject([width / 2 + ((b.minX + b.maxX) / 2 - fcx), height / 2 + ((b.minY + b.maxY) / 2 - fcy)])
      if (!isFinite(longitude + latitude)) return { longitude, latitude, fits: false }
    }
    // Test at the final center (re-centering can diverge near the horizon).
    const b = bbox(longitude, latitude, zoom)
    const fits = !!b && b.minX >= frame.left - 1 && b.maxX <= frame.right + 1 && b.minY >= frame.top - 1 && b.maxY <= frame.bottom + 1
    return { longitude, latitude, fits }
  }
  let lo = 8, hi = maxZoom
  let best = { ...place(lo), zoom: lo }
  for (let i = 0; i < 16; i++) {
    const zoom = (lo + hi) / 2
    const p = place(zoom)
    if (p.fits) { lo = zoom; best = { ...p, zoom } } else hi = zoom
  }
  return { longitude: best.longitude, latitude: best.latitude, zoom: best.zoom, ...cam }
}
