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
 * Projects those points, then repeatedly (a) zooms by the ratio of the frame to
 * their screen bbox and (b) re-centers so the bbox center lands on the frame
 * center. Perspective makes this nonlinear, hence iterate rather than solve.
 */
export function fit3d(
  bounds: [[number, number], [number, number]],
  tops: [number, number, number][],
  cam: { pitch: number; bearing: number },
  size: { width: number; height: number },
  frame: Frame,
  maxZoom = 17,
): Camera {
  const [[x0, y0], [x1, y1]] = bounds
  const corners: [number, number, number][] = [...tops]
  for (const x of [x0, x1]) for (const y of [y0, y1]) corners.push([x, y, 0])
  const { width, height } = size
  const flat = new WebMercatorViewport({ width, height, longitude: (x0 + x1) / 2, latitude: (y0 + y1) / 2, zoom: 12 })
  let { longitude, latitude, zoom } = flat.fitBounds(bounds, { padding: 40 })
  const fw = frame.right - frame.left, fh = frame.bottom - frame.top
  const fcx = (frame.left + frame.right) / 2, fcy = (frame.top + frame.bottom) / 2
  for (let i = 0; i < 6; i++) {
    let vp = new WebMercatorViewport({ width, height, longitude, latitude, zoom, ...cam })
    let pts = corners.map(c => vp.project(c))
    const bw = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))
    const bh = Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]))
    zoom = Math.min(maxZoom, zoom + Math.log2(Math.min(fw / bw, fh / bh)))
    vp = new WebMercatorViewport({ width, height, longitude, latitude, zoom, ...cam })
    pts = corners.map(c => vp.project(c))
    const bcx = (Math.max(...pts.map(p => p[0])) + Math.min(...pts.map(p => p[0]))) / 2
    const bcy = (Math.max(...pts.map(p => p[1])) + Math.min(...pts.map(p => p[1]))) / 2
    // Move the camera so the box center shifts from (bcx, bcy) to the frame center.
    ;[longitude, latitude] = vp.unproject([width / 2 + (bcx - fcx), height / 2 + (bcy - fcy)])
  }
  return { longitude, latitude, zoom, ...cam }
}
