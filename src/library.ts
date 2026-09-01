/**
 * The workout library: built-ins you can't break, and your own that you can.
 *
 * Built-ins are functions of the unit system rather than fixed plans, so a 5K
 * splits into miles or kilometres depending on the setting. Saved workouts are
 * plain `Plan` objects in local storage, mirrored to host storage so they
 * survive a packaged cold launch.
 */

import type { Plan, Units } from './types'
import { distancePlan, intervalPlan, openPlan, timePlan, zonePlan } from './workout'

export type LibraryGroup = 'distance' | 'time' | 'intervals' | 'zones'

export type BuiltIn = {
  id: string
  group: LibraryGroup
  /** Button text. Terse — the whole grid has to be scannable. */
  label: string
  build: (units: Units) => Plan
}

const HALF_MARATHON = 21_097.5
const MARATHON = 42_195

export const GROUP_LABELS: Record<LibraryGroup, string> = {
  distance: 'Distance',
  time: 'Time',
  intervals: 'Intervals',
  zones: 'Zones',
}

export const BUILT_INS: BuiltIn[] = [
  // ── Set distance ──
  { id: 'd-5k', group: 'distance', label: '5K', build: u => distancePlan('5K', 5000, u) },
  { id: 'd-10k', group: 'distance', label: '10K', build: u => distancePlan('10K', 10_000, u) },
  { id: 'd-half', group: 'distance', label: 'Half', build: u => distancePlan('Half marathon', HALF_MARATHON, u) },
  { id: 'd-full', group: 'distance', label: 'Marathon', build: u => distancePlan('Marathon', MARATHON, u) },

  // ── Set time ──
  { id: 't-30', group: 'time', label: '30 min', build: () => timePlan('30 min', 30 * 60) },
  { id: 't-45', group: 'time', label: '45 min', build: () => timePlan('45 min', 45 * 60) },
  { id: 't-60', group: 'time', label: '60 min', build: () => timePlan('60 min', 60 * 60) },
  { id: 't-90', group: 'time', label: '90 min', build: () => timePlan('90 min', 90 * 60) },

  // ── Intervals ──
  {
    id: 'i-400', group: 'intervals', label: '8×400m',
    build: () => intervalPlan({
      name: '8 × 400m', reps: 8,
      work: { by: 'distance', metres: 400 },
      recovery: { by: 'time', seconds: 90 },
      warmupSeconds: 600, cooldownSeconds: 600,
    }),
  },
  {
    id: 'i-800', group: 'intervals', label: '6×800m',
    build: () => intervalPlan({
      name: '6 × 800m', reps: 6,
      work: { by: 'distance', metres: 800 },
      recovery: { by: 'time', seconds: 150 },
      warmupSeconds: 600, cooldownSeconds: 600,
    }),
  },
  {
    id: 'i-mile', group: 'intervals', label: '4×1mi',
    build: () => intervalPlan({
      name: '4 × 1 mile', reps: 4,
      work: { by: 'distance', metres: 1609 },
      recovery: { by: 'time', seconds: 180 },
      warmupSeconds: 900, cooldownSeconds: 600,
    }),
  },
  {
    id: 'i-tempo', group: 'intervals', label: 'Tempo 20',
    build: () => ({
      name: '20 min tempo',
      steps: [
        { label: 'Warm-up', target: { by: 'time', seconds: 900 }, easy: true },
        { label: 'Tempo', target: { by: 'time', seconds: 1200 }, holdZone: 3 },
        { label: 'Cool-down', target: { by: 'time', seconds: 600 }, easy: true },
      ],
    }),
  },

  // ── Time in zones. holdZone is 0-based: zone 0 is Z1 on the display. ──
  {
    id: 'z-ladder', group: 'zones', label: 'Ladder',
    build: () => zonePlan('Zone ladder', [
      { zone: 0, minutes: 5, label: 'Warm-up' },
      { zone: 1, minutes: 20 },
      { zone: 3, minutes: 3 },
      { zone: 4, minutes: 2 },
      { zone: 0, minutes: 5, label: 'Cool-down' },
    ]),
  },
  {
    id: 'z-easy', group: 'zones', label: 'Easy Z2',
    build: () => zonePlan('Easy Z2', [
      { zone: 0, minutes: 10, label: 'Warm-up' },
      { zone: 1, minutes: 40 },
      { zone: 0, minutes: 5, label: 'Cool-down' },
    ]),
  },
  {
    id: 'z-threshold', group: 'zones', label: 'Threshold',
    build: () => zonePlan('Threshold 4×6', [
      { zone: 0, minutes: 12, label: 'Warm-up' },
      { zone: 3, minutes: 6, label: 'Z4 · 1/4' },
      { zone: 1, minutes: 2, label: 'Float' },
      { zone: 3, minutes: 6, label: 'Z4 · 2/4' },
      { zone: 1, minutes: 2, label: 'Float' },
      { zone: 3, minutes: 6, label: 'Z4 · 3/4' },
      { zone: 1, minutes: 2, label: 'Float' },
      { zone: 3, minutes: 6, label: 'Z4 · 4/4' },
      { zone: 0, minutes: 8, label: 'Cool-down' },
    ]),
  },
  {
    id: 'z-pyramid', group: 'zones', label: 'Pyramid',
    build: () => zonePlan('Zone pyramid', [
      { zone: 0, minutes: 10, label: 'Warm-up' },
      { zone: 1, minutes: 10 },
      { zone: 2, minutes: 6 },
      { zone: 3, minutes: 4 },
      { zone: 4, minutes: 2 },
      { zone: 2, minutes: 6 },
      { zone: 0, minutes: 8, label: 'Cool-down' },
    ]),
  },

  { id: 'open', group: 'time', label: 'Open run', build: () => openPlan() },
]

export function builtIn(id: string): BuiltIn | null {
  return BUILT_INS.find(b => b.id === id) ?? null
}

// ── Your own ──

export type SavedWorkout = {
  id: string
  plan: Plan
  savedAt: number
}

const LIBRARY_KEY = 'splitglass.library.v1'
const MAX_SAVED = 40

export function loadSaved(): SavedWorkout[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSaved).sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

function isSaved(value: unknown): value is SavedWorkout {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  const plan = o.plan as Plan | undefined
  return typeof o.id === 'string'
    && !!plan
    && typeof plan.name === 'string'
    && Array.isArray(plan.steps)
    && plan.steps.length > 0
}

function writeSaved(list: SavedWorkout[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list.slice(0, MAX_SAVED)))
  } catch { /* private mode */ }
}

/**
 * Save a plan under its own name. Saving twice under the same name replaces the
 * first, which is what you want after tweaking a session by two minutes.
 */
export function saveWorkout(plan: Plan): SavedWorkout {
  const entry: SavedWorkout = {
    id: `s-${Date.now().toString(36)}`,
    plan,
    savedAt: Date.now(),
  }
  const rest = loadSaved().filter(s => s.plan.name.toLowerCase() !== plan.name.toLowerCase())
  writeSaved([entry, ...rest])
  return entry
}

export function deleteWorkout(id: string): void {
  writeSaved(loadSaved().filter(s => s.id !== id))
}

export function exportLibrary(): string {
  return JSON.stringify(loadSaved())
}

export function importLibrary(json: string | null): void {
  if (!json) return
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) writeSaved(parsed.filter(isSaved))
  } catch { /* ignore malformed */ }
}

// ── Zone blocks as text ──

/**
 * Parse `5@1, 20@2, 3@4, 2@5` — minutes at zone, in the order written.
 *
 * A text field rather than a repeating form: this is how the workout gets
 * described out loud, and typing it takes a couple of seconds where a form takes
 * a dozen taps. Separators are loose on purpose (commas, spaces, semicolons).
 */
export function parseZoneBlocks(text: string, zoneCount = 5): { zone: number; minutes: number }[] {
  const blocks: { zone: number; minutes: number }[] = []
  for (const token of text.split(/[,;\s]+/)) {
    if (!token) continue
    const m = token.match(/^(\d+(?:\.\d+)?)\s*[@xX/]\s*[zZ]?(\d)$/)
    if (!m) continue
    const minutes = Number(m[1])
    const displayZone = Number(m[2])
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) continue
    if (displayZone < 1 || displayZone > zoneCount) continue
    // The field is written in display zones (Z1…Zn); holdZone is 0-based.
    blocks.push({ zone: displayZone - 1, minutes })
  }
  return blocks
}

// ── Zone guide ──

export type ZoneGuideRow = {
  /** 1-based, as shown. */
  zone: number
  name: string
  /** What it feels like — the only reliable way to recognise a zone. */
  feel: string
  purpose: string
  /** Share of weekly training time. */
  week: string
}

/**
 * Reference for the (i) panel.
 *
 * These are the common five-zone descriptions and the widely-cited polarised
 * split: roughly 80% of weekly time easy, 20% hard. General guidance, not a
 * prescription — and note that the *boundaries* come from Health, not from here.
 */
export const ZONE_GUIDE: ZoneGuideRow[] = [
  { zone: 1, name: 'Very light', feel: 'Nose breathing, could hold a conversation all day', purpose: 'Warm-up, cool-down, recovery between hard days', week: '10–20%' },
  { zone: 2, name: 'Light', feel: 'Full sentences, comfortable, slightly boring', purpose: 'Aerobic base — mitochondria, capillaries, fat oxidation', week: '55–75%' },
  { zone: 3, name: 'Moderate', feel: 'Short sentences, breathing has a rhythm', purpose: 'Aerobic power, marathon to half-marathon effort', week: '5–10%' },
  { zone: 4, name: 'Hard', feel: 'A few words at a time, uncomfortable but steady', purpose: 'Lactate threshold, 10K to half-marathon pace', week: '5–10%' },
  { zone: 5, name: 'Maximum', feel: 'No talking, cannot hold it long', purpose: 'VO₂ max and speed — measured in minutes, not hours', week: '1–5%' },
]

export const ZONE_GUIDE_NOTE =
  'Roughly 80% of weekly time in Z1–Z2 and 20% in Z3–Z5. General guidance, not a prescription. '
  + 'Zone boundaries come from Health, not from this app.'
