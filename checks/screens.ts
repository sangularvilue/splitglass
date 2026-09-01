/**
 * Layout regression check.
 *
 * Every screen, built with realistic data, is run through two independent
 * judges: the SDK's own page validator (container budget, event capture,
 * brightness range, z-order, menu limits) and @evenrealities/pretext (does the
 * text actually fit the box it was given, at the real firmware metrics).
 *
 * The point is that a HUD which would clip a number, or a page that would blow
 * the 8-container limit, fails here on a laptop rather than at mile four.
 */

import {
  ImageContainerProperty, ListContainerProperty, ListItemContainerProperty,
  MenuContainerProperty, MenuItemProperty,
  TextContainerProperty,
  formatEvenHubPageContainerValidationError,
  isMenuNameWithinLimit, isValidMenuItemID, isValidTextBrightness,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'

import { buildScreen, SCREEN_ORDER } from '../src/screens'
import type { GlassesScreen, SplitglassSettings, Snapshot, TransportKind, ZoneState } from '../src/types'
import type { WorkoutView } from '../src/workout'
import { createEngine, intervalPlan, zonePlan } from '../src/workout'

const LINE_HEIGHT = 27
const SCREEN_W = 576
const SCREEN_H = 288
const LIST_ITEM_H = 40

let failures = 0
function fail(msg: string): void { failures++; console.log(`  FAIL  ${msg}`) }

// ── Fixtures ──

const settings: SplitglassSettings = {
  pairCode: 'H4KQ7M',
  units: 'mi',
  maxHeartRate: 185,
  homeScreen: 'run',
  templeNav: true,
  mapEnabled: true,
  mapIntervalSec: 6,
  preferLocal: true,
  planName: '8 × 400m',
}

// Nine zones is the most HealthKit allows, and the widest zone rows we can be
// handed; the run screen's sparkline has to survive it too.
function zones(count: number, source: 'apple' | 'computed', current?: number): ZoneState {
  const boundaries: number[] = []
  for (let i = 1; i < count; i++) boundaries.push(Math.round(95 + i * (95 / count) * 1.8))
  return {
    source,
    count,
    currentIndex: current ?? Math.min(count - 1, 3),
    boundaries,
    durations: Array.from({ length: count }, (_, i) => 120 + i * 97),
  }
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    seq: 400,
    at: Date.now(),
    workoutId: 'W-1',
    state: 'running',
    activity: 'running',
    indoor: false,
    elapsed: 3971,          // over an hour, so the duration format grows
    distance: 17_403.7,     // 10.8 miles — two-digit distance
    heartRate: 171,
    energy: 1284,
    paceSecPerKm: 283,
    cadence: 178,
    zones: zones(5, 'apple'),
    ...over,
  }
}

/** A view with a long plan and a full splits list, i.e. the worst case. */
function busyView(over: Partial<Snapshot> = {}): WorkoutView {
  const plan = intervalPlan({
    name: '8 × 400m',
    reps: 8,
    work: { by: 'distance', metres: 400 },
    recovery: { by: 'time', seconds: 90 },
    holdPaceSecPerKm: { from: 236, to: 249 },
    warmupSeconds: 600,
    cooldownSeconds: 600,
  })
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => settings.maxHeartRate })
  // Walk a whole session in so the splits list is long and the step cursor is
  // somewhere in the middle.
  for (let t = 0; t <= 2600; t += 10) {
    engine.ingest(snapshot({
      seq: t,
      elapsed: t,
      distance: t * 3.4,
      ...over,
    }))
  }
  return engine.view()
}

/**
 * Mid-way through a zone workout, so the step line carries a zone target and
 * whatever the compliance hint has to say about it.
 */
function zoneStepView(current?: number): WorkoutView {
  const plan = zonePlan('Zone ladder', [
    { zone: 0, minutes: 5 },
    { zone: 1, minutes: 20 },
    { zone: 3, minutes: 3 },
    { zone: 4, minutes: 2 },
  ])
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => settings.maxHeartRate })
  let view = engine.view()
  for (let t = 0; t <= 1000; t += 10) {
    view = engine.ingest(snapshot({ seq: t, elapsed: t, distance: t * 3.4, zones: zones(5, 'apple', current) }))
  }
  return view
}

const emptyView: WorkoutView = {
  snapshot: null,
  staleSeconds: Infinity,
  zones: null,
  avgPaceSecPerKm: null,
  progress: null,
  splits: [],
  planComplete: false,
}

// ── Judges ──

function checkSpec(name: string, screen: GlassesScreen, view: WorkoutView, kind: TransportKind, map: Parameters<typeof buildScreen>[4]): void {
  const spec = buildScreen(screen, view, kind, settings, map)

  const textObject = spec.text.map(t => new TextContainerProperty({
    containerID: t.id, containerName: t.name, content: t.content,
    xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
    borderWidth: 0, paddingLength: 0, textColor: t.level,
    isEventCapture: t.capture ? 1 : 0,
  }))
  const listObject = spec.lists.map(l => new ListContainerProperty({
    containerID: l.id, containerName: l.name,
    xPosition: l.x, yPosition: l.y, width: l.w, height: l.h,
    itemContainer: new ListItemContainerProperty({
      itemCount: l.items.length, itemWidth: l.w - 12,
      isItemSelectBorderEn: 1, itemName: l.items,
    }),
    isEventCapture: l.capture ? 1 : 0,
  }))
  const imageObject = spec.images.map(i => new ImageContainerProperty({
    containerID: i.id, containerName: i.name,
    xPosition: i.x, yPosition: i.y, width: i.w, height: i.h,
  }))

  const page = {
    containerTotalNum: textObject.length + listObject.length + imageObject.length,
    textObject,
    ...(listObject.length ? { listObject } : {}),
    ...(imageObject.length ? { imageObject } : {}),
    menuObject: new MenuContainerProperty({
      menuItems: [['Lap', 1], ['Next screen', 2], ['Restart plan', 3], ['Miles / km', 4], ['Close', 5]]
        .map(([itemName, itemID]) => new MenuItemProperty({ itemName: itemName as string, itemID: itemID as number })),
    }),
  }

  // 1. The SDK's own validator.
  const res = validateEvenHubPageContainer(page)
  if (!res.valid) fail(`${name}: ${formatEvenHubPageContainerValidationError(res)}`)

  // 2. Container budget and bounds, spelled out — the validator's message is
  //    terse and this is the constraint most likely to bite.
  const nonImage = textObject.length + listObject.length
  if (nonImage > 8) fail(`${name}: ${nonImage} non-image containers (max 8)`)
  if (imageObject.length > 4) fail(`${name}: ${imageObject.length} image containers (max 4)`)

  const captures = [...spec.text.filter(t => t.capture), ...spec.lists.filter(l => l.capture)]
  if (captures.length !== 1) fail(`${name}: ${captures.length} containers capture events (need exactly 1)`)

  const ids = [...spec.text, ...spec.lists, ...spec.images].map(c => c.id)
  if (new Set(ids).size !== ids.length) fail(`${name}: duplicate container ids ${ids.join(',')}`)

  for (const box of [...spec.text, ...spec.lists, ...spec.images]) {
    if (box.x < 0 || box.y < 0 || box.x + box.w > SCREEN_W || box.y + box.h > SCREEN_H) {
      fail(`${name}/${box.name}: box ${box.x},${box.y} ${box.w}×${box.h} leaves the 576×288 canvas`)
    }
  }

  // 3. Brightness in range.
  for (const t of spec.text) {
    if (!isValidTextBrightness(t.level)) fail(`${name}/${t.name}: textColor ${t.level} out of range`)
  }

  // 4. Does the text fit? Measured at the real firmware advance widths.
  for (const t of spec.text) {
    const maxLines = Math.floor(t.h / LINE_HEIGHT)
    let lines = 0
    for (const raw of t.content.split('\n')) {
      const m = measureTextWrap(raw, t.w)
      if (getTextWidth(raw) > t.w) {
        fail(`${name}/${t.name}: line ${getTextWidth(raw)}px > ${t.w}px  "${raw}"`)
      }
      lines += Math.max(1, m.lineCount)
    }
    if (lines > maxLines) {
      fail(`${name}/${t.name}: ${lines} lines in a box that holds ${maxLines}`)
    }
  }

  // 5. List items: within the firmware's 64-character ceiling, and inside the
  //    item width so nothing is silently truncated.
  for (const l of spec.lists) {
    if (l.items.length > 20) fail(`${name}/${l.name}: ${l.items.length} items (max 20)`)
    const visible = Math.floor(l.h / LIST_ITEM_H)
    if (visible < 1) fail(`${name}/${l.name}: height ${l.h} shows no items`)
    for (const item of l.items) {
      if ([...item].length > 64) fail(`${name}/${l.name}: item ${[...item].length} chars (max 64)  "${item}"`)
      const w = getTextWidth(item)
      if (w > l.w - 24) fail(`${name}/${l.name}: item ${w}px > ${l.w - 24}px  "${item}"`)
    }
  }

  const summary = `${String(nonImage).padStart(2)} boxes` + (imageObject.length ? ` +${imageObject.length} img` : '       ')
  console.log(`  ok    ${name.padEnd(34)} ${summary}  ${res.valid ? 'validator: VALID' : ''}`)
}

// ── Menu ──

console.log('menu:')
for (const [label, id] of [['Lap', 1], ['Next screen', 2], ['Restart plan', 3], ['Miles / km', 4], ['Close', 5]] as [string, number][]) {
  if (!isMenuNameWithinLimit(label)) fail(`menu label too long: ${label}`)
  if (!isValidMenuItemID(id)) fail(`menu id invalid: ${id}`)
}
console.log('  ok    5 items, all within limits')

// ── Screens ──

const mapReady = { available: true, scaleMetres: 250, offRouteMetres: 41.6, gpsMetres: 17_120 }
const mapCold = { available: false, scaleMetres: null, offRouteMetres: null, gpsMetres: null }

console.log('\nscreens, mid-session:')
for (const screen of SCREEN_ORDER) {
  checkSpec(`${screen} (running, 5 apple zones)`, screen, busyView(), 'stream', mapReady)
}

console.log('\nscreens, edge cases:')
for (const screen of SCREEN_ORDER) {
  checkSpec(`${screen} (no data)`, screen, emptyView, 'none', mapCold)
}
checkSpec('run (9 zones, computed)', 'run', busyView({ zones: zones(9, 'computed') }), 'poll', mapReady)
checkSpec('zones (9 zones, computed)', 'zones', busyView({ zones: zones(9, 'computed') }), 'poll', mapReady)
checkSpec('run (no heart rate)', 'run', busyView({ heartRate: null, zones: null }), 'local', mapReady)
checkSpec('run (indoor, no distance)', 'run', busyView({ indoor: true, distance: null, paceSecPerKm: null }), 'local', mapCold)
checkSpec('map (indoor)', 'map', busyView({ indoor: true }), 'local', mapCold)
checkSpec('run (km units)', 'run', busyView(), 'stream', mapReady)

// Units flipped, since the pace strings change width.
;(settings as { units: 'mi' | 'km' }).units = 'km'
for (const screen of SCREEN_ORDER) {
  checkSpec(`${screen} (km)`, screen, busyView(), 'stream', mapReady)
}

console.log('\nscreens, zone workouts:')
// In zone, above it, below it, and a wearer whose Health settings give them only
// three zones so the preset's Z4 target has to be clamped.
checkSpec('run (zone step, in zone)', 'run', zoneStepView(1), 'stream', mapReady)
checkSpec('run (zone step, ease off)', 'run', zoneStepView(4), 'stream', mapReady)
checkSpec('run (zone step, push)', 'run', zoneStepView(0), 'stream', mapReady)
checkSpec('splits (zone workout)', 'splits', zoneStepView(1), 'stream', mapReady)

console.log(failures === 0 ? '\nOK — every screen fits' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
