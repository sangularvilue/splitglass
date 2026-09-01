import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// A workout is over long before this; the TTL only exists so an abandoned pair
// code cannot leave a reading sitting in Redis for ever.
export const SNAPSHOT_TTL = 60 * 60 * 6

export function snapshotKey(code) {
  return `splitglass:snap:${code}`
}

/**
 * Pair codes are six characters from an unambiguous alphabet. Validating the
 * shape keeps a stray query string from turning into an unbounded key space.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  return /^[A-Z0-9]{6}$/.test(code) ? code : null
}

/**
 * The relay is a pipe, not a store of record: it keeps exactly one reading per
 * pair code and never writes anything to disk. Validate the shape anyway, so a
 * malformed post cannot poison the HUD.
 */
export function sanitizeSnapshot(body) {
  if (!body || typeof body !== 'object' || body.v !== 1) return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const elapsed = num(body.elapsed)
  if (elapsed === null) return null

  const states = ['idle', 'running', 'paused', 'ended']
  const activities = ['running', 'walking', 'cycling', 'hiking', 'other']

  let zones = null
  const z = body.zones
  if (z && typeof z === 'object' && Array.isArray(z.boundaries) && Array.isArray(z.durations)) {
    const count = num(z.count) ?? z.durations.length
    if (count >= 2 && count <= 9 && z.durations.length === count && z.boundaries.length === count - 1) {
      zones = {
        source: z.source === 'apple' ? 'apple' : 'computed',
        count,
        currentIndex: num(z.currentIndex),
        boundaries: z.boundaries.map(Number),
        durations: z.durations.map(Number),
      }
    }
  }

  return {
    v: 1,
    seq: num(body.seq) ?? 0,
    at: num(body.at) ?? Date.now(),
    workoutId: typeof body.workoutId === 'string' ? body.workoutId.slice(0, 64) : 'unknown',
    state: states.includes(body.state) ? body.state : 'idle',
    activity: activities.includes(body.activity) ? body.activity : 'other',
    indoor: body.indoor === true,
    elapsed,
    distance: num(body.distance),
    heartRate: num(body.heartRate),
    energy: num(body.energy),
    paceSecPerKm: num(body.paceSecPerKm),
    cadence: num(body.cadence),
    zones,
  }
}

export function cors(res) {
  // The plugin is served from a different origin when it runs from an .ehpk, and
  // the phone app posts from no origin at all.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
