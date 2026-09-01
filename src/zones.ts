/**
 * Heart-rate zones, Apple's if we can get them.
 *
 * HealthKit owns zones from iOS 27 / watchOS 27: `HKWorkoutZoneConfiguration`
 * carries the boundaries the user actually has set (or that the system computed
 * from their own heart-rate history), and `HKLiveWorkoutZoneUpdate` carries the
 * live current zone and the running per-zone durations. When the watch sends
 * those through, the numbers on the glasses are the same numbers the Fitness app
 * will show afterwards — which is the point.
 *
 * Everything here is presentation. Zone arithmetic belongs to HealthKit; the
 * only sums we do ourselves are the last-resort fallback below, and it is
 * labelled as ours so it can never be mistaken for Apple's.
 */

import type { ZoneState } from './types'

/** Apple shows five zones by default; HealthKit allows 3–9. */
export const APPLE_DEFAULT_ZONE_COUNT = 5

export function zoneLabel(index: number): string {
  return `Z${index + 1}`
}

/**
 * `148–162` for a middle zone, `<91` for the first, `183+` for the last.
 * Zone 0 has no lower bound and the last zone no upper bound, so the whole
 * range of heart rates is always covered.
 */
export function zoneRangeLabel(zones: ZoneState, index: number): string {
  const lower = index === 0 ? null : zones.boundaries[index - 1]
  const upper = index >= zones.boundaries.length ? null : zones.boundaries[index]
  if (lower == null && upper == null) return '—'
  if (lower == null) return `<${Math.round(upper!)}`
  if (upper == null) return `${Math.round(lower)}+`
  return `${Math.round(lower)}–${Math.round(upper)}`
}

/** Which zone a bpm reading falls in, using the boundaries we were given. */
export function zoneForHeartRate(zones: ZoneState, bpm: number): number {
  for (let i = 0; i < zones.boundaries.length; i++) {
    if (bpm < zones.boundaries[i]!) return i
  }
  return zones.count - 1
}

/**
 * Last-resort zones, used only when the watch sends no zone payload at all —
 * an OS without the HealthKit zones API, or a workout with no heart-rate
 * source. Boundaries at 60/70/80/90% of maximum heart rate: a common enough
 * convention, but not Apple's, so `source` says `computed` and the UI says so
 * too. Anything Apple sends always wins over this.
 */
export function computedZones(maxHeartRate: number, currentBpm: number | null, durations?: number[]): ZoneState {
  const boundaries = [0.60, 0.70, 0.80, 0.90].map(f => Math.round(maxHeartRate * f))
  const zones: ZoneState = {
    source: 'computed',
    count: APPLE_DEFAULT_ZONE_COUNT,
    currentIndex: null,
    boundaries,
    durations: durations && durations.length === APPLE_DEFAULT_ZONE_COUNT
      ? durations
      : new Array(APPLE_DEFAULT_ZONE_COUNT).fill(0),
  }
  if (currentBpm != null) zones.currentIndex = zoneForHeartRate(zones, currentBpm)
  return zones
}

/**
 * Accumulate time in zone ourselves. Only ever called alongside
 * `computedZones` — when HealthKit is supplying durations we use its totals, so
 * that the glasses and the Fitness app cannot disagree.
 */
export function accumulate(durations: number[], index: number | null, deltaSeconds: number): number[] {
  if (index == null || index < 0 || index >= durations.length || deltaSeconds <= 0) return durations
  const out = durations.slice()
  out[index] = (out[index] ?? 0) + deltaSeconds
  return out
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/**
 * A one-line zone histogram for the glasses: `Z1▁ Z2▃ Z3▇ Z4▅ Z5▁`, with the
 * current zone bracketed so it reads at a glance while you are moving.
 */
export function zoneSparkline(zones: ZoneState): string {
  const total = Math.max(1, ...zones.durations)
  return zones.durations
    .map((seconds, i) => {
      const step = Math.min(BLOCKS.length - 1, Math.round((seconds / total) * (BLOCKS.length - 1)))
      const bar = BLOCKS[step]!
      return i === zones.currentIndex ? `[${zoneLabel(i)}${bar}]` : `${zoneLabel(i)}${bar}`
    })
    .join(' ')
}

/** A proportional bar for one zone row, e.g. `▇▇▇▇▇▇░░░░`. */
export function zoneBar(seconds: number, longest: number, width: number): string {
  const filled = longest > 0 ? Math.round((seconds / longest) * width) : 0
  return '▇'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}
