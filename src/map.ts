/**
 * The HUD map: a breadcrumb of where you have actually run.
 *
 * There are no map tiles here and there cannot be — the BLE link to the glasses
 * carries 10–30 KB/s and a tile would eat a second of it to tell you something
 * you can see by looking up. What a HUD can usefully show is the shape of your
 * own track, your position and heading on it, and — if you loaded one — the
 * route you meant to follow, so "am I still on course" is answerable without
 * taking the phone out.
 *
 * GPS is the one part of the app that is outdoor-only. Everything on the other
 * screens comes from HealthKit and works on a treadmill.
 *
 * Rendering: draw on a 2D canvas, then reduce to the 4-bit greyscale the glasses
 * want. 192×96 at Gray4 is about 9 KB on the wire, which is a redraw every few
 * seconds rather than every second — hence `mapIntervalSec`.
 */

import { AppLocationAccuracy, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export type Fix = {
  lat: number
  lon: number
  /** Metres per second, when the phone reports it. */
  speed: number | null
  /** Degrees clockwise from true north, when the phone reports it. */
  heading: number | null
  at: number
}

export const MAP_W = 192
export const MAP_H = 96

// Roughly a stride: closer fixes than this are jitter, not progress.
const MIN_STEP_M = 4
const MAX_POINTS = 900

// ── Track store ──

export type Track = ReturnType<typeof createTrack>

export function createTrack() {
  let points: Fix[] = []
  let route: { lat: number; lon: number }[] = []
  let watching = false

  return {
    add(fix: Fix): boolean {
      const last = points[points.length - 1]
      if (last && haversine(last.lat, last.lon, fix.lat, fix.lon) < MIN_STEP_M) {
        // Still worth keeping the freshest heading and speed.
        points[points.length - 1] = { ...last, speed: fix.speed, heading: fix.heading, at: fix.at }
        return false
      }
      points.push(fix)
      if (points.length > MAX_POINTS) points = decimate(points)
      return true
    },

    points: () => points,
    last: () => points[points.length - 1] ?? null,
    clear() { points = [] },

    /** A route to follow, as [lat, lon] pairs — from a GPX drop in the companion. */
    setRoute(r: { lat: number; lon: number }[]) { route = r },
    route: () => route,

    /** Straight-line metres from the current fix to the nearest point on the route. */
    offRouteMetres(): number | null {
      const here = points[points.length - 1]
      if (!here || route.length === 0) return null
      let best = Infinity
      for (const p of route) {
        const d = haversine(here.lat, here.lon, p.lat, p.lon)
        if (d < best) best = d
      }
      return best
    },

    /** Metres covered along the recorded track — a GPS cross-check on HealthKit. */
    gpsMetres(): number {
      let total = 0
      for (let i = 1; i < points.length; i++) {
        total += haversine(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon)
      }
      return total
    },

    async watch(bridge: EvenAppBridge | null, log?: (m: string) => void): Promise<boolean> {
      if (!bridge || typeof (bridge as any).startAppLocationUpdates !== 'function') {
        log?.('Location updates not available in this SDK/host — map disabled')
        return false
      }
      if (watching) return true
      bridge.onAppLocationChanged((loc) => {
        if (typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number') return
        this.add({
          lat: loc.latitude,
          lon: loc.longitude,
          speed: typeof loc.speed === 'number' && loc.speed >= 0 ? loc.speed : null,
          heading: typeof loc.heading === 'number' && loc.heading >= 0 ? loc.heading : null,
          at: typeof loc.timestamp === 'number' ? loc.timestamp : Date.now(),
        })
      })
      const ok = await bridge.startAppLocationUpdates({
        accuracy: AppLocationAccuracy.High,
        intervalMs: 1000,
        distanceFilter: MIN_STEP_M,
      })
      watching = ok !== false
      log?.(watching ? 'GPS track on' : 'GPS permission refused — map disabled')
      return watching
    },

    async unwatch(bridge: EvenAppBridge | null): Promise<void> {
      if (!bridge || !watching) return
      try { await bridge.stopAppLocationUpdates() } catch { /* already stopped */ }
      watching = false
    },

    isWatching: () => watching,
  }
}

/** Halve the point count by dropping every other interior point. */
function decimate(points: Fix[]): Fix[] {
  const out: Fix[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i += 2) out.push(points[i]!)
  out.push(points[points.length - 1]!)
  return out
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8
  const p = Math.PI / 180
  const dLat = (lat2 - lat1) * p
  const dLon = (lon2 - lon1) * p
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ── Rendering ──

export type MapRender = {
  /** One byte per pixel, 0–255. The host reduces this to the display's 16 levels. */
  gray8: Uint8Array
  /** Two pixels per byte, high nibble first — half the bytes on the wire. */
  gray4: Uint8Array
  width: number
  height: number
  /** Metres represented by the scale bar drawn bottom-left. */
  scaleMetres: number
  /** Hash of the drawn content, so an unchanged map is not re-sent. */
  signature: string
}

/**
 * Draw the track (and route) to fill the frame, north up.
 *
 * Equirectangular projection with a cos(latitude) correction on longitude: over
 * the few kilometres a run covers this is indistinguishable from anything
 * fancier, and it keeps the aspect ratio honest so a lap of a track looks like a
 * lap of a track.
 */
export function renderMap(track: Track, opts: { width?: number; height?: number } = {}): MapRender | null {
  const width = opts.width ?? MAP_W
  const height = opts.height ?? MAP_H
  const points = track.points()
  const route = track.route()
  if (points.length < 2 && route.length < 2) return null

  const all = [...points.map(p => ({ lat: p.lat, lon: p.lon })), ...route]
  const lat0 = all.reduce((a, p) => a + p.lat, 0) / all.length
  const kx = Math.cos(lat0 * Math.PI / 180)

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of all) {
    const x = p.lon * kx
    const y = p.lat
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const pad = 6
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY)
  const offX = (width - spanX * scale) / 2
  const offY = (height - spanY * scale) / 2

  const toPx = (lat: number, lon: number): [number, number] => [
    offX + (lon * kx - minX) * scale,
    // Screen y grows downward; north must be up.
    height - (offY + (lat - minY) * scale),
  ]

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // The planned route, dim and dashed: context, not the subject.
  if (route.length >= 2) {
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = '#6b6b6b'
    ctx.lineWidth = 1
    ctx.beginPath()
    route.forEach((p, i) => {
      const [x, y] = toPx(p.lat, p.lon)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.setLineDash([])
  }

  // The track you have actually run, bright and solid.
  if (points.length >= 2) {
    ctx.strokeStyle = '#e6e6e6'
    ctx.lineWidth = 2
    ctx.beginPath()
    points.forEach((p, i) => {
      const [x, y] = toPx(p.lat, p.lon)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Where you started, hollow; where you are, solid with a heading tick.
    const [sx, sy] = toPx(points[0]!.lat, points[0]!.lon)
    ctx.strokeStyle = '#9a9a9a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(sx, sy, 3, 0, Math.PI * 2)
    ctx.stroke()

    const here = points[points.length - 1]!
    const [hx, hy] = toPx(here.lat, here.lon)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2)
    ctx.fill()
    if (here.heading != null) {
      const rad = (here.heading - 90) * Math.PI / 180
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(hx, hy)
      ctx.lineTo(hx + Math.cos(rad) * 11, hy + Math.sin(rad) * 11)
      ctx.stroke()
    }
  }

  // North arrow, top right.
  ctx.strokeStyle = '#8f8f8f'
  ctx.fillStyle = '#8f8f8f'
  ctx.lineWidth = 1
  const nx = width - 9, ny = 14
  ctx.beginPath()
  ctx.moveTo(nx, ny)
  ctx.lineTo(nx, ny - 9)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(nx - 3, ny - 6)
  ctx.lineTo(nx, ny - 11)
  ctx.lineTo(nx + 3, ny - 6)
  ctx.fill()

  // Scale bar, bottom left, snapped to a round number of metres.
  const metresPerPx = metresPerDegLat(lat0) / scale
  const target = (width - 2 * pad) * 0.3 * metresPerPx
  const scaleMetres = roundScale(target)
  const barPx = Math.round(scaleMetres / metresPerPx)
  ctx.strokeStyle = '#8f8f8f'
  ctx.beginPath()
  ctx.moveTo(pad, height - 5)
  ctx.lineTo(pad + barPx, height - 5)
  ctx.moveTo(pad, height - 8)
  ctx.lineTo(pad, height - 2)
  ctx.moveTo(pad + barPx, height - 8)
  ctx.lineTo(pad + barPx, height - 2)
  ctx.stroke()

  const rgba = ctx.getImageData(0, 0, width, height).data
  const gray8 = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // Rec. 601 luma. The canvas is drawn in greys already, so this is really
    // just picking a channel with rounding that survives the 4-bit reduction.
    gray8[p] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8
  }

  const gray4 = new Uint8Array(Math.ceil(gray8.length / 2))
  for (let p = 0, b = 0; p < gray8.length; p += 2, b++) {
    const hi = gray8[p]! >> 4
    const lo = (gray8[p + 1] ?? 0) >> 4
    gray4[b] = (hi << 4) | lo
  }

  return { gray8, gray4, width, height, scaleMetres, signature: signatureOf(gray4) }
}

function metresPerDegLat(lat: number): number {
  // Good to a few parts in ten thousand, which is far below one pixel here.
  return 111132.92 - 559.82 * Math.cos(2 * lat * Math.PI / 180)
}

function roundScale(metres: number): number {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
  for (const s of steps) if (metres <= s) return s
  return 10000
}

/** Cheap content hash — enough to skip an identical redraw, not a checksum. */
function signatureOf(bytes: Uint8Array): string {
  let h = 2166136261
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36) + ':' + bytes.length
}
