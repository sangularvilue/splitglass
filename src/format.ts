/** Numbers as a runner reads them. */

import type { Units } from './types'

export const METRES_PER_MILE = 1609.344

export function unitDistance(metres: number, units: Units): number {
  return units === 'mi' ? metres / METRES_PER_MILE : metres / 1000
}

/** `26:51`, or `1:02:14` once you are past the hour. */
export function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** `0:42` — a countdown, always minutes and seconds. */
export function fmtCountdown(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtDistance(metres: number | null, units: Units, decimals = 2): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  return unitDistance(metres, units).toFixed(decimals)
}

/** Metres, as metres, when a split is short enough for that to be the useful unit. */
export function fmtShortDistance(metres: number | null): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)}k` : `${Math.round(metres)}m`
}

/** Pace as `7:38`, converted out of the seconds-per-kilometre we carry inside. */
export function fmtPace(secPerKm: number | null, units: Units): string {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '—'
  const per = units === 'mi' ? secPerKm * (METRES_PER_MILE / 1000) : secPerKm
  const m = Math.floor(per / 60)
  const s = Math.round(per % 60)
  // 7:60 is not a pace.
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`
}

export function paceUnitLabel(units: Units): string {
  return units === 'mi' ? '/mi' : '/km'
}

/** Seconds per kilometre from a distance and a duration. */
export function paceFrom(metres: number | null, seconds: number | null): number | null {
  if (metres == null || seconds == null || metres < 5 || seconds <= 0) return null
  return (seconds / metres) * 1000
}

/** Parse `7:38` into seconds per kilometre, given the user's units. */
export function parsePace(text: string, units: Units): number | null {
  const m = text.trim().match(/^(\d+):([0-5]\d)$/)
  if (!m) return null
  const perUnit = Number(m[1]) * 60 + Number(m[2])
  return units === 'mi' ? perUnit / (METRES_PER_MILE / 1000) : perUnit
}
