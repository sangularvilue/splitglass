/**
 * Parsing what comes off the wire.
 *
 * Kept apart from the transport so it touches no DOM at all: the relay is a
 * dumb pipe and the phone app will change under us, so a malformed field must
 * cost one number on the HUD rather than throw inside the render loop. Pure, so
 * checks/workout.ts can exercise it directly.
 */

import type { Snapshot } from './types'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Validate rather than trust. The relay is a dumb pipe and the phone app will
 * change under us; a malformed field must degrade one number on the HUD, not
 * throw inside the render loop.
 */
export function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return null
  const elapsed = num(o.elapsed)
  if (elapsed == null) return null

  const state = o.state
  const validState = state === 'idle' || state === 'running' || state === 'paused' || state === 'ended'
  const activity = o.activity
  const validActivity = activity === 'running' || activity === 'walking' || activity === 'cycling'
    || activity === 'hiking' || activity === 'other'

  let zones: Snapshot['zones'] = null
  const z = o.zones as Record<string, unknown> | null | undefined
  if (z && typeof z === 'object') {
    const boundaries = Array.isArray(z.boundaries) ? z.boundaries.filter(x => typeof x === 'number') as number[] : []
    const durations = Array.isArray(z.durations) ? z.durations.filter(x => typeof x === 'number') as number[] : []
    const count = num(z.count) ?? durations.length
    if (count >= 2 && durations.length === count && boundaries.length === count - 1) {
      zones = {
        source: z.source === 'apple' ? 'apple' : 'computed',
        count,
        currentIndex: num(z.currentIndex),
        boundaries,
        durations,
      }
    }
  }

  return {
    v: 1,
    seq: num(o.seq) ?? 0,
    at: num(o.at) ?? Date.now(),
    workoutId: typeof o.workoutId === 'string' ? o.workoutId : 'unknown',
    state: validState ? state : 'idle',
    activity: validActivity ? activity : 'other',
    indoor: o.indoor === true,
    elapsed,
    distance: num(o.distance),
    heartRate: num(o.heartRate),
    energy: num(o.energy),
    paceSecPerKm: num(o.paceSecPerKm),
    cadence: num(o.cadence),
    zones,
  }
}
