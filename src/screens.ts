/**
 * What each screen looks like, as data.
 *
 * Two hardware facts shape all of this:
 *
 *  - **There is no font size.** The firmware draws one 27px face and that is
 *    that, so "big number" HUDs are not available. Emphasis comes from
 *    `textColor` (0–4, 4 brightest) and from position, not from scale.
 *  - **A page holds at most 8 non-image containers**, and `textColor` applies to
 *    a whole container. So a two-line tile — label above, value below, one
 *    container — is the unit of layout: it gives a column that stays aligned
 *    under a proportional font, which space-padding never would.
 *
 * These builders are pure. checks/screens.ts runs every one of them through the
 * SDK's own page validator and through real font measurement, so a layout that
 * would overflow or blow the container budget fails on Windows rather than on
 * your wrist.
 */

import type { GlassesScreen, SplitglassSettings, Snapshot, TransportKind } from './types'
import type { WorkoutView } from './workout'
import {
  fmtCountdown, fmtDistance, fmtDuration, fmtPace, fmtShortDistance, paceUnitLabel,
} from './format'
import { zoneBar, zoneLabel, zoneRangeLabel, zoneSparkline } from './zones'
import { MAP_H, MAP_W } from './map'
import { pxTruncate } from '@evenrealities/pretext'

/**
 * Clip-proofing.
 *
 * Every dynamic line here is assembled from parts whose widths depend on the
 * numbers of the moment: a two-digit distance, a route deviation, a long plan
 * name. Measured against the real firmware advance widths and truncated to the
 * box, a line can no longer silently wrap into a row that is not there — which
 * on a HUD reads as a number that has simply gone missing.
 */
function fit(line: string, width: number): string {
  return pxTruncate(line, width)
}

/** Fit each line of a multi-line container independently. */
function fitLines(lines: string[], width: number): string {
  return lines.map(l => fit(l, width)).join('\n')
}

export type TextBox = {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  /** textColor 0–4; 4 is the device default and the brightest. */
  level: number
  capture?: boolean
}

export type ListBox = {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
  capture?: boolean
}

export type ImageBox = { id: number; name: string; x: number; y: number; w: number; h: number }

export type ScreenSpec = {
  screen: GlassesScreen
  text: TextBox[]
  lists: ListBox[]
  images: ImageBox[]
}

const SCREEN_W = 576
const SCREEN_H = 288
const LINE = 27

// Brightness roles. Kept here rather than sprinkled through the builders so the
// hierarchy is legible in one place — and so it can be tuned in one place after
// the first run in daylight.
const L = {
  primary: 4,   // the two or three numbers you actually glance at
  secondary: 3, // useful, but not why you looked up
  label: 2,     // zone ranges, split rows
  chrome: 1,    // status, scale, plan name
} as const

// Three columns that fit 576px with 6px gutters.
const COL_X = [6, 196, 386] as const
const COL_W = 184
const ROW_Y = [4, 70] as const
const TILE_H = 2 * LINE + 2
// The step block gets three lines — target, what to hold, and the bar — because
// squeezing the bar onto the same line as a pace band overflows 576px.
const STEP_Y = 128
const STEP_H = 3 * LINE
const FOOT_Y = 212

/** A label above its value, in one container: the column stays aligned. */
function tile(id: number, name: string, col: 0 | 1 | 2, row: 0 | 1, label: string, value: string, level: number): TextBox {
  return {
    id,
    name,
    x: COL_X[col],
    y: ROW_Y[row],
    w: COL_W,
    h: TILE_H,
    content: `${label}\n${value}`,
    level,
  }
}

function wide(id: number, name: string, y: number, h: number, content: string, level: number, capture = false): TextBox {
  return { id, name, x: 6, y, w: SCREEN_W - 12, h, content, level, capture }
}

// ── Shared furniture ──

function transportGlyph(kind: TransportKind): string {
  switch (kind) {
    case 'local': return '◉ phone'
    case 'stream': return '◉ live'
    case 'poll': return '◍ poll'
    default: return '○ —'
  }
}

function stateWord(snap: Snapshot | null): string {
  if (!snap) return 'idle'
  switch (snap.state) {
    case 'running': return snap.indoor ? 'indoor' : 'running'
    case 'paused': return 'paused'
    case 'ended': return 'ended'
    default: return 'ready'
  }
}

/**
 * The status line. Staleness is spelled out rather than hidden: a frozen number
 * on a HUD is worse than an obviously absent one, so once readings stop arriving
 * the line says how long ago the last one was.
 */
function statusLine(view: WorkoutView, kind: TransportKind, settings: SplitglassSettings, battery?: number | null): string {
  const stale = view.staleSeconds
  const staleNote = !Number.isFinite(stale) ? 'no data'
    : stale > 5 ? `${Math.round(stale)}s ago`
      : ''
  const parts = [transportGlyph(kind), stateWord(view.snapshot), settings.planName]
  if (staleNote) parts.push(staleNote)
  // The glasses' own battery. You do not want the HUD dying at mile five, and
  // the phone is in a pocket.
  if (battery != null) parts.push(`G2 ${Math.round(battery)}%`)
  return parts.join(' · ')
}

function zoneNow(view: WorkoutView): string {
  const z = view.zones
  const bpm = view.snapshot?.heartRate
  if (!z || z.currentIndex == null) return bpm != null ? `${Math.round(bpm)}` : '—'
  return `${bpm != null ? Math.round(bpm) : '—'}  ${zoneLabel(z.currentIndex)}`
}

// ── Run ──

/**
 * The main screen. Distance, elapsed and heart rate on the top row at full
 * brightness; pace, average and energy beneath at one step down; the current
 * step of the plan across the middle; zones and status at the foot.
 */
export function runScreen(view: WorkoutView, kind: TransportKind, settings: SplitglassSettings, battery?: number | null): ScreenSpec {
  const snap = view.snapshot
  const u = settings.units
  const paceUnit = paceUnitLabel(u)

  const text: TextBox[] = [
    tile(1, 'sg-dist', 0, 0, u === 'mi' ? 'DIST mi' : 'DIST km',
      fmtDistance(snap?.distance ?? null, u), L.primary),
    tile(2, 'sg-time', 1, 0, 'TIME',
      fmtDuration(snap?.elapsed ?? null), L.primary),
    tile(3, 'sg-hr', 2, 0, 'HR',
      zoneNow(view), L.primary),

    tile(4, 'sg-pace', 0, 1, `PACE ${paceUnit}`,
      fmtPace(view.paceSecPerKm, u), L.primary),
    tile(5, 'sg-avg', 1, 1, `AVG ${paceUnit}`,
      fmtPace(view.avgPaceSecPerKm, u), L.secondary),
    tile(6, 'sg-cal', 2, 1, 'CAL',
      snap?.energy != null ? String(Math.round(snap.energy)) : '—', L.secondary),

    wide(7, 'sg-step', STEP_Y, STEP_H, stepBlock(view, settings), L.primary),
    wide(8, 'sg-foot', FOOT_Y, TILE_H,
      fitLines([
        view.zones ? zoneSparkline(view.zones) : 'No HR',
        statusLine(view, kind, settings, battery),
      ], SCREEN_W - 12),
      L.chrome, true),
  ]

  return { screen: 'run', text, lists: [], images: [] }
}

/**
 * The two lines that make the plan useful mid-effort: how much of this step is
 * left, and what to hold while you finish it.
 */
function stepBlock(view: WorkoutView, settings: SplitglassSettings): string {
  const p = view.progress
  if (!p) {
    return view.planComplete ? 'Plan complete' : 'No workout'
  }

  const u = settings.units
  const left = p.step.target.by === 'time'
    ? `${fmtCountdown(p.secondsLeft)} left`
    : `${fmtShortDistance(p.metresLeft)} left${p.secondsLeft != null ? ` · ${fmtCountdown(p.secondsLeft)}` : ''}`

  // The last five seconds of a step count down in front of everything else, and
  // name what comes next — that is the moment you need to know.
  const countdown = p.secondsLeft != null && p.secondsLeft > 0 && p.secondsLeft <= 5
    ? `${Math.ceil(p.secondsLeft)} → ${p.next ? p.next.label : 'done'}`
    : null

  const head = countdown ?? `${p.step.label}  (${p.index + 1}/${p.total})  ${left}`

  // Zone before easy: a zone workout marks its Z1 blocks easy, and the zone is
  // the more useful of the two things to say.
  const hold = p.step.holdPaceSecPerKm
    ? `hold ${fmtPace(p.step.holdPaceSecPerKm.from, u)}–${fmtPace(p.step.holdPaceSecPerKm.to, u)}${paceUnitLabel(u)}`
    : p.step.holdZone != null
      ? zoneHold(p.step.holdZone, view)
      : p.step.easy ? 'easy' : ''

  const next = p.next ? `next: ${p.next.label}` : 'last step'
  const stepPace = paceHold(view, p.step.holdPaceSecPerKm, u)

  return fitLines([
    head,
    [stepPace, hold, next].filter(Boolean).join('  ·  '),
    progressGlyphs(p.fraction, 20),
  ], SCREEN_W - 12)
}

/**
 * Pace over this step so far, with a verdict against the band if there is one.
 * `from` is the fast end of the band and `to` the slow end (both seconds per
 * kilometre), so slower than `to` means push and faster than `from` means ease.
 */
function paceHold(view: WorkoutView, band: { from: number; to: number } | undefined, u: SplitglassSettings['units']): string {
  const pace = view.stepPaceSecPerKm
  if (pace == null) return ''
  const label = `step ${fmtPace(pace, u)}`
  if (!band) return label
  if (pace > band.to) return `${label} · push`
  if (pace < band.from) return `${label} · ease`
  return `${label} ✓`
}

/**
 * What to do about the zone you are in.
 *
 * A target written for five zones has to survive a wearer whose Health settings
 * give them seven or three, so the target is clamped to whatever HealthKit
 * actually reported. `ease` and `push` rather than arrows: an arrow is ambiguous
 * about whether it means your heart rate or your effort.
 */
function zoneHold(target: number, view: WorkoutView): string {
  const z = view.zones
  const capped = z ? Math.min(target, z.count - 1) : target
  const label = `hold ${zoneLabel(capped)}`
  if (!z || z.currentIndex == null) return label
  if (z.currentIndex === capped) return `${label} ✓`
  return z.currentIndex > capped ? `${label} · ease` : `${label} · push`
}

function progressGlyphs(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

// ── Splits ──

/**
 * Every finished split, newest last, in a native list so the firmware handles
 * the scrolling. A list also sidesteps the container budget: three containers
 * whatever the split count.
 */
export function splitsScreen(view: WorkoutView, kind: TransportKind, settings: SplitglassSettings, battery?: number | null): ScreenSpec {
  const u = settings.units
  const items = view.splits.length === 0
    ? ['No splits']
    : view.splits.slice(-20).map(s => {
      const pace = fmtPace(s.paceSecPerKm, u)
      const hr = s.avgHeartRate != null ? `${s.avgHeartRate}` : '—'
      return fit(`${String(s.index).padStart(2)}  ${s.label}  ${fmtDuration(s.seconds)}  ${pace}${paceUnitLabel(u)}  ${hr}`, SCREEN_W - 36)
    })

  return {
    screen: 'splits',
    text: [
      wide(1, 'sg-splits-h', 2, LINE, fit(`Splits ${view.splits.length} · ${settings.planName}`, SCREEN_W - 12), L.secondary),
      wide(8, 'sg-splits-f', 252, LINE, fit(statusLine(view, kind, settings, battery), SCREEN_W - 12), L.chrome),
    ],
    lists: [{
      id: 2,
      name: 'sg-splits-l',
      x: 6,
      y: 34,
      w: SCREEN_W - 12,
      h: 212,
      items,
      capture: true,
    }],
    images: [],
  }
}

// ── Zones ──

/**
 * Time in each zone. When HealthKit supplied the zones these are the user's own
 * boundaries and HealthKit's own accumulated totals — the same figures the
 * Fitness app will show for this workout. The header says whose maths it is, so
 * the fallback can never be mistaken for Apple's.
 *
 * A list again, because HealthKit permits anywhere from three to nine zones and
 * nine rows would not fit the container budget.
 */
export function zonesScreen(view: WorkoutView, kind: TransportKind, settings: SplitglassSettings, battery?: number | null): ScreenSpec {
  const z = view.zones
  const header = z
    ? `Zones · ${z.source === 'apple' ? 'Health' : 'est. max ' + settings.maxHeartRate}`
    : 'Zones · no HR'

  const items: string[] = []
  if (z) {
    const longest = Math.max(1, ...z.durations)
    for (let i = 0; i < z.count; i++) {
      const seconds = z.durations[i] ?? 0
      const here = i === z.currentIndex ? '▸' : ' '
      items.push(fit(`${here} ${zoneLabel(i)}  ${zoneRangeLabel(z, i).padEnd(8)} ${fmtDuration(seconds).padStart(6)}  ${zoneBar(seconds, longest, 12)}`, SCREEN_W - 36))
    }
  } else {
    items.push('No zones')
  }

  return {
    screen: 'zones',
    text: [
      wide(1, 'sg-zones-h', 2, LINE, fit(header, SCREEN_W - 12), L.secondary),
      wide(8, 'sg-zones-f', 252, LINE, fit(statusLine(view, kind, settings, battery), SCREEN_W - 12), L.chrome),
    ],
    lists: [{ id: 2, name: 'sg-zones-l', x: 6, y: 34, w: SCREEN_W - 12, h: 212, items, capture: true }],
    images: [],
  }
}

// ── Map ──

/**
 * The breadcrumb. Outdoor only — GPS is the single part of this app that a
 * treadmill cannot feed, so the screen says so rather than showing an empty box.
 */
export function mapScreen(
  view: WorkoutView,
  kind: TransportKind,
  settings: SplitglassSettings,
  map: { available: boolean; scaleMetres: number | null; offRouteMetres: number | null; gpsMetres: number | null },
  battery?: number | null,
): ScreenSpec {
  const u = settings.units
  const snap = view.snapshot

  const hasMap = map.available && map.scaleMetres != null
  const text: TextBox[] = [
    wide(1, 'sg-map-h', 2, LINE,
      fit(hasMap
        ? `${map.scaleMetres! >= 1000 ? `${map.scaleMetres! / 1000}k` : `${map.scaleMetres}`}m · N↑`
        : snap?.indoor ? 'Indoor' : 'No GPS', SCREEN_W - 12),
      L.chrome),
    wide(7, 'sg-map-a', 140, LINE,
      fit(`${fmtDistance(snap?.distance ?? null, u)} ${u}  ·  ${fmtDuration(snap?.elapsed ?? null)}  ·  ${fmtPace(view.paceSecPerKm, u)}${paceUnitLabel(u)}`, SCREEN_W - 12),
      L.primary),
    wide(8, 'sg-map-f', 200, 2 * LINE, mapFootLines(view, kind, settings, map, battery), L.chrome, true),
  ]

  const images: ImageBox[] = hasMap
    ? [{ id: 3, name: 'sg-map-img', x: Math.round((SCREEN_W - MAP_W) / 2), y: 34, w: MAP_W, h: MAP_H }]
    : []

  return { screen: 'map', text, lists: [], images }
}

/**
 * Two lines: route and cross-check on the first, transport and state on the
 * second. They were one line, which overflowed as soon as a route deviation and
 * a distance disagreement turned up together.
 */
function mapFootLines(
  view: WorkoutView,
  kind: TransportKind,
  settings: SplitglassSettings,
  map: { offRouteMetres: number | null; gpsMetres: number | null },
  battery?: number | null,
): string {
  const bits: string[] = []
  if (map.offRouteMetres != null) {
    bits.push(map.offRouteMetres <= 25 ? 'on route' : `${Math.round(map.offRouteMetres)}m off`)
  }
  // GPS distance is shown next to HealthKit's only when they disagree enough to
  // matter — a quiet cross-check rather than a second number to read.
  const hk = view.snapshot?.distance
  if (map.gpsMetres != null && hk != null && Math.abs(map.gpsMetres - hk) > Math.max(50, hk * 0.04)) {
    bits.push(`gps ${fmtDistance(map.gpsMetres, settings.units)} · watch ${fmtDistance(hk, settings.units)}`)
  }
  return fitLines([
    bits.length ? bits.join(' · ') : '',
    statusLine(view, kind, settings, battery),
  ], SCREEN_W - 12)
}

// ── Flash ──

/**
 * A moment, not a screen. The G2 has no haptics and no audio, so a step change
 * has to be *seen*: three centred lines at full brightness for a few seconds,
 * then back to whatever was showing. One container per line so each can be cut
 * to width independently.
 */
export function flashScreen(lines: string[]): ScreenSpec {
  const shown = lines.slice(0, 3)
  const top = Math.round((SCREEN_H - shown.length * (LINE + 8)) / 2)
  const text: TextBox[] = shown.map((line, i) => ({
    id: 20 + i,
    name: `sg-flash-${i}`,
    x: 6,
    y: top + i * (LINE + 8),
    w: SCREEN_W - 12,
    h: LINE,
    content: fit(line, SCREEN_W - 12),
    level: i === 0 ? L.primary : L.secondary,
    capture: i === 0,
  }))
  return { screen: 'run', text, lists: [], images: [] }
}

// ── Dispatch ──

export function buildScreen(
  screen: GlassesScreen,
  view: WorkoutView,
  kind: TransportKind,
  settings: SplitglassSettings,
  map: { available: boolean; scaleMetres: number | null; offRouteMetres: number | null; gpsMetres: number | null },
  battery?: number | null,
): ScreenSpec {
  switch (screen) {
    case 'splits': return splitsScreen(view, kind, settings, battery)
    case 'zones': return zonesScreen(view, kind, settings, battery)
    case 'map': return mapScreen(view, kind, settings, map, battery)
    default: return runScreen(view, kind, settings, battery)
  }
}

export const SCREEN_ORDER: GlassesScreen[] = ['run', 'splits', 'zones', 'map']

export function nextScreen(current: GlassesScreen, delta: number, mapEnabled: boolean): GlassesScreen {
  const order = mapEnabled ? SCREEN_ORDER : SCREEN_ORDER.filter(s => s !== 'map')
  const i = Math.max(0, order.indexOf(current))
  return order[(i + delta + order.length) % order.length]!
}
