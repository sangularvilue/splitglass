/**
 * Engine check: drive a whole session through the reducer and assert the plan
 * behaves. No network, no glasses, no watch — the splits logic is the part most
 * likely to be wrong and the part hardest to debug while running.
 */

import { createEngine, distancePlan, intervalPlan, openPlan, steadyPlan, timePlan, zonePlan } from '../src/workout'
import { BUILT_INS, parseZoneBlocks, ZONE_GUIDE } from '../src/library'
import { METRES_PER_MILE } from '../src/format'
import { parseSnapshot } from '../src/wire'
import { computedZones, zoneForHeartRate, zoneRangeLabel } from '../src/zones'
import { fmtPace, parsePace, paceFrom } from '../src/format'
import type { Snapshot } from '../src/types'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  ok    ${label}`) }
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`) }
}

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    v: 1, seq: 0, at: Date.now(), workoutId: 'W1',
    state: 'running', activity: 'running', indoor: false,
    elapsed: 0, distance: 0, heartRate: 150, energy: 0,
    paceSecPerKm: 300, cadence: 176, zones: null,
    ...over,
  }
}

// ── Distance intervals, the treadmill case ──
console.log('distance intervals (HealthKit distance, no GPS):')
{
  // 4 × 400m with 100m float, no warm-up: eight steps, all distance-based.
  const plan = intervalPlan({
    name: '4 × 400m',
    reps: 4,
    work: { by: 'distance', metres: 400 },
    recovery: { by: 'distance', metres: 100 },
  })
  check('plan has 7 steps (4 work + 3 recovery)', plan.steps.length === 7, `got ${plan.steps.length}`)

  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  // 3.4 m/s for 600 s covers 2040 m — enough for 4×400 + 3×100 = 1900 m.
  let view = engine.view()
  for (let t = 0; t <= 620; t++) {
    view = engine.ingest(snap({ seq: t, elapsed: t, distance: t * 3.4 }))
  }
  check('all 7 steps completed', view.splits.length === 7, `got ${view.splits.length}`)
  check('plan reported complete', view.planComplete)
  check('no step running once complete', view.progress === null)

  const first = view.splits[0]!
  check('first split is ~400m', Math.abs(first.metres - 400) < 8, `${first.metres.toFixed(1)}m`)
  check('first split pace is ~4:54/km', Math.abs((first.paceSecPerKm ?? 0) - 294) < 8, `${first.paceSecPerKm?.toFixed(0)}s/km`)
  check('split carries an average heart rate', first.avgHeartRate === 150, String(first.avgHeartRate))
  check('splits are labelled from the plan', first.label === 'Rep 1/4', first.label)
}

// ── Time intervals ──
console.log('\ntime intervals:')
{
  const plan = intervalPlan({
    name: '3 × 3 min',
    reps: 3,
    work: { by: 'time', seconds: 180 },
    recovery: { by: 'time', seconds: 60 },
  })
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  let view = engine.view()
  for (let t = 0; t <= 200; t++) view = engine.ingest(snap({ seq: t, elapsed: t, distance: t * 3 }))

  check('one split after 200s (180 work done, 60 recovery not)', view.splits.length === 1, `got ${view.splits.length}`)
  check('now in the recovery step', view.progress?.step.label === 'Easy', view.progress?.step.label)
  check('countdown is 40s', Math.abs((view.progress?.secondsLeft ?? 0) - 40) < 1.5, String(view.progress?.secondsLeft))
  check('fraction is ~1/3', Math.abs((view.progress?.fraction ?? 0) - 20 / 60) < 0.02, String(view.progress?.fraction))
  check('next step is named', view.progress?.next?.label === 'Rep 2/3', view.progress?.next?.label)
}

// ── A late packet spanning several steps ──
console.log('\nrobustness:')
{
  const plan = intervalPlan({ name: 'short', reps: 3, work: { by: 'time', seconds: 10 }, recovery: { by: 'time', seconds: 5 } })
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  engine.ingest(snap({ seq: 1, elapsed: 0 }))
  // One packet 60 s later: every step of the plan has elapsed inside the gap,
  // and the splits list must reflect all of them rather than just the next one.
  const view = engine.ingest(snap({ seq: 2, elapsed: 60, distance: 200 }))
  check('a 60s gap closes every step it spans', view.splits.length === 5, `got ${view.splits.length}`)
  check('plan complete after the gap', view.planComplete)
}
{
  const plan = openPlan()
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  engine.ingest(snap({ seq: 5, elapsed: 100, distance: 340 }))
  const replayed = engine.ingest(snap({ seq: 3, elapsed: 40, distance: 130 }))
  check('a replayed packet cannot wind the clock back', replayed.snapshot?.elapsed === 100, String(replayed.snapshot?.elapsed))

  const restarted = engine.ingest(snap({ workoutId: 'W2', seq: 0, elapsed: 0, distance: 0 }))
  check('a new workoutId resets the splits', restarted.splits.length === 0)
}
{
  const plan = steadyPlan('Mile splits', 3, 'mi')
  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  let view = engine.view()
  for (let t = 0; t <= 900; t += 5) view = engine.ingest(snap({ seq: t, elapsed: t, distance: t * 3.4 }))
  check('unit-split plan cuts miles', view.splits.length === 1, `got ${view.splits.length}`)
  check('mile split is ~1609m', Math.abs(view.splits[0]!.metres - 1609.344) < 20, `${view.splits[0]!.metres.toFixed(0)}m`)

  const lapped = engine.lap()
  check('Lap closes the current step early', lapped.splits.length === 2, `got ${lapped.splits.length}`)
  const cleared = engine.restartPlan()
  check('Restart plan clears splits and re-arms step 1', cleared.splits.length === 0 && cleared.progress?.index === 0)
}

// ── Zones ──
console.log('\nzones:')
{
  const apple = snap({
    zones: {
      source: 'apple', count: 5, currentIndex: 2,
      boundaries: [116, 139, 158, 172],
      durations: [30, 220, 640, 180, 12],
    },
  })
  const engine = createEngine({ getPlan: () => openPlan(), getMaxHeartRate: () => 185 })
  const view = engine.ingest(apple)
  check("HealthKit's zones are used verbatim", view.zones?.source === 'apple' && view.zones?.durations[2] === 640)
  check('zone 0 range has no lower bound', zoneRangeLabel(view.zones!, 0) === '<116', zoneRangeLabel(view.zones!, 0))
  check('last zone range is open-ended', zoneRangeLabel(view.zones!, 4) === '172+', zoneRangeLabel(view.zones!, 4))
  check('middle zone range reads as a band', zoneRangeLabel(view.zones!, 2) === '139–158', zoneRangeLabel(view.zones!, 2))
}
{
  const engine = createEngine({ getPlan: () => openPlan(), getMaxHeartRate: () => 180 })
  const view = engine.ingest(snap({ zones: null, heartRate: 150 }))
  check('no zone payload falls back to computed', view.zones?.source === 'computed')
  // 150 bpm against a 180 max: 83%, which is zone 4 of 5 (index 3).
  check('fallback puts 150bpm of 180max in Z4', view.zones?.currentIndex === 3, String(view.zones?.currentIndex))

  const z = computedZones(180, null)
  check('fallback boundaries are 108/126/144/162', z.boundaries.join(',') === '108,126,144,162', z.boundaries.join(','))
  check('a bpm below every boundary is zone 0', zoneForHeartRate(z, 90) === 0)
  check('a bpm above every boundary is the last zone', zoneForHeartRate(z, 200) === 4)
}

// ── Formatting round trips ──
console.log('\nformatting:')
{
  check('7:38/mi round-trips', fmtPace(parsePace('7:38', 'mi'), 'mi') === '7:38', fmtPace(parsePace('7:38', 'mi'), 'mi'))
  check('4:45/km round-trips', fmtPace(parsePace('4:45', 'km'), 'km') === '4:45', fmtPace(parsePace('4:45', 'km'), 'km'))
  check('a 6:00/km pace is 9:39/mi', fmtPace(360, 'mi') === '9:39', fmtPace(360, 'mi'))
  check('pace never renders as :60', fmtPace(paceFrom(1000, 359.7), 'km') === '6:00', fmtPace(paceFrom(1000, 359.7), 'km'))
  check('an absurd pace is suppressed', fmtPace(99_999, 'mi') === '—')
  check('no distance yields no pace', paceFrom(null, 100) === null)
}

// ── Wire parsing ──
console.log('\nwire:')
{
  check('a non-v1 payload is rejected', parseSnapshot({ v: 2, elapsed: 1 }) === null)
  check('a payload without elapsed is rejected', parseSnapshot({ v: 1 }) === null)
  check('garbage is rejected', parseSnapshot('nope') === null)
  const partial = parseSnapshot({ v: 1, elapsed: 12, state: 'sprinting', zones: { count: 5, boundaries: [1], durations: [] } })
  check('an unknown state degrades to idle', partial?.state === 'idle', partial?.state)
  check('a malformed zone block is dropped, not thrown', partial?.zones === null)
  const good = parseSnapshot({
    v: 1, seq: 7, elapsed: 60, distance: 200, heartRate: 149, workoutId: 'W9',
    state: 'running', activity: 'running', indoor: true,
    zones: { source: 'apple', count: 3, currentIndex: 1, boundaries: [120, 150], durations: [10, 20, 30] },
  })
  check('a 3-zone payload is accepted', good?.zones?.count === 3 && good.zones.source === 'apple')
  check('indoor survives the wire', good?.indoor === true)
}

// ── The library ──
console.log('\nbuilt-in library:')
{
  check('every group is represented', new Set(BUILT_INS.map(b => b.group)).size === 4)
  // Nothing should leave you standing still at the top of the effort range.
  for (const entry of BUILT_INS.filter(b => b.group === 'zones')) {
    const steps = entry.build('mi').steps
    const last = steps[steps.length - 1]!.holdZone ?? 0
    check(`${entry.label} ends easy`, last <= 1, `ends on Z${last + 1}`)
  }
  check('ids are unique', new Set(BUILT_INS.map(b => b.id)).size === BUILT_INS.length)

  let bad = 0
  for (const entry of BUILT_INS) {
    for (const units of ['mi', 'km'] as const) {
      const built = entry.build(units)
      const problems: string[] = []
      if (!built.name.trim()) problems.push('no name')
      if (built.steps.length === 0) problems.push('no steps')
      for (const step of built.steps) {
        if (!step.label.trim()) problems.push('unlabelled step')
        const amount = step.target.by === 'time' ? step.target.seconds : step.target.metres
        if (!Number.isFinite(amount) || amount <= 0) problems.push(`bad target ${amount}`)
        // holdZone is 0-based and HealthKit allows 3-9 zones; a preset must not
        // aim at a zone that cannot exist.
        if (step.holdZone != null && (step.holdZone < 0 || step.holdZone > 8)) {
          problems.push(`holdZone ${step.holdZone} out of range`)
        }
      }
      if (problems.length) { bad++; console.log(`  FAIL  ${entry.id}/${units}: ${problems.join(', ')}`) }
    }
  }
  check('all built-ins build cleanly in both unit systems', bad === 0, `${bad} bad`)

  // The one Will asked for by name.
  const ladder = BUILT_INS.find(b => b.id === 'z-ladder')!.build('mi')
  check('Ladder is 5 Z1 / 20 Z2 / 3 Z4 / 2 Z5 / 5 Z1 down',
    ladder.steps.length === 5
    && ladder.steps.every(s => s.target.by === 'time')
    && ladder.steps.map(s => s.target.by === 'time' ? s.target.seconds / 60 : 0).join(',') === '5,20,3,2,5'
    && ladder.steps.map(s => s.holdZone).join(',') === '0,1,3,4,0',
    JSON.stringify(ladder.steps.map(s => [s.holdZone, s.target])))
}

console.log('\nset distance and time:')
{
  const fiveK = distancePlan('5K', 5000, 'km')
  check('5K in km is 5 steps', fiveK.steps.length === 5, `${fiveK.steps.length}`)
  check('5K in km has no remainder step', !fiveK.steps.some(s => s.label === 'Finish'))

  const fiveKmi = distancePlan('5K', 5000, 'mi')
  check('5K in miles is 3 miles plus a finish', fiveKmi.steps.length === 4, `${fiveKmi.steps.length}`)
  check('the finish step is the remainder',
    Math.abs((fiveKmi.steps[3]!.target as { metres: number }).metres - (5000 - 3 * METRES_PER_MILE)) < 1)

  const short = distancePlan('800m', 800, 'km')
  check('a distance under one unit is a single step', short.steps.length === 1, `${short.steps.length}`)

  const half = distancePlan('Half', 21_097.5, 'km')
  check('a half marathon is 21 km plus a finish', half.steps.length === 22, `${half.steps.length}`)

  const thirty = timePlan('30 min', 1800)
  check('a set time is one step of that length',
    thirty.steps.length === 1 && (thirty.steps[0]!.target as { seconds: number }).seconds === 1800)

  // Ends when the distance is covered, on HealthKit distance alone.
  const engine = createEngine({ getPlan: () => fiveK, getMaxHeartRate: () => 185 })
  let view = engine.view()
  for (let t = 0; t <= 1500; t += 5) view = engine.ingest(snap({ seq: t, elapsed: t, distance: t * 3.4 }))
  check('a 5K plan completes on distance', view.planComplete && view.splits.length === 5, `${view.splits.length} splits`)
}

console.log('\nzone blocks:')
{
  const plan = zonePlan('Ladder', [
    { zone: 0, minutes: 5 }, { zone: 1, minutes: 20 }, { zone: 3, minutes: 3 }, { zone: 4, minutes: 2 },
  ])
  check('blocks become timed steps with a zone to hold',
    plan.steps.every(s => s.target.by === 'time') && plan.steps[2]!.holdZone === 3)
  check('Z1 blocks are marked easy', plan.steps[0]!.easy === true)
  check('Z4 blocks are not', plan.steps[2]!.easy === false)
  check('default labels name the zone as displayed', plan.steps[1]!.label === 'Z2 · 20 min', plan.steps[1]!.label)

  const engine = createEngine({ getPlan: () => plan, getMaxHeartRate: () => 185 })
  let view = engine.view()
  // The clock runs whether or not you are in the zone, so 30 minutes finishes it.
  for (let t = 0; t <= 1810; t += 10) view = engine.ingest(snap({ seq: t, elapsed: t, distance: t * 3 }))
  check('a 30-minute ladder completes on the clock', view.planComplete, `${view.splits.length} splits`)

  // Parsing, in display zones (Z1..Zn), converted to 0-based holdZone.
  check('parses the canonical form',
    JSON.stringify(parseZoneBlocks('5@1, 20@2, 3@4, 2@5'))
      === JSON.stringify([{ zone: 0, minutes: 5 }, { zone: 1, minutes: 20 }, { zone: 3, minutes: 3 }, { zone: 4, minutes: 2 }]),
    JSON.stringify(parseZoneBlocks('5@1, 20@2, 3@4, 2@5')))
  check('spaces work as separators', parseZoneBlocks('5@1 20@2').length === 2)
  check('an explicit Z is allowed', parseZoneBlocks('10@z3').length === 1)
  check('x and / work as the join', parseZoneBlocks('10x3 5/2').length === 2)
  check('fractional minutes are allowed', parseZoneBlocks('1.5@2')[0]?.minutes === 1.5)
  check('a zone above the count is dropped', parseZoneBlocks('10@7', 5).length === 0)
  check('zone 0 is dropped', parseZoneBlocks('10@0').length === 0)
  check('nonsense yields nothing', parseZoneBlocks('what even is this').length === 0)
  check('garbage among good tokens is skipped', parseZoneBlocks('5@1 nope 20@2').length === 2)
}

console.log('\nzone guide:')
{
  check('one row per zone', ZONE_GUIDE.length === 5)
  check('rows are numbered 1-5', ZONE_GUIDE.map(r => r.zone).join(',') === '1,2,3,4,5')
  check('every row has feel, purpose and a weekly share',
    ZONE_GUIDE.every(r => r.name && r.feel && r.purpose && /%/.test(r.week)))
  // The weekly shares should add up to roughly a whole week.
  const mid = ZONE_GUIDE.reduce((sum, r) => {
    const [lo, hi] = r.week.replace('%', '').split('–').map(Number)
    return sum + (lo + (hi ?? lo)) / 2
  }, 0)
  check('midpoints total near 100%', mid > 90 && mid < 110, `${mid.toFixed(0)}%`)
}

console.log(failures === 0 ? '\nOK' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
