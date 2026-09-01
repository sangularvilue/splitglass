/**
 * Engine check: drive a whole session through the reducer and assert the plan
 * behaves. No network, no glasses, no watch — the splits logic is the part most
 * likely to be wrong and the part hardest to debug while running.
 */

import { createEngine, intervalPlan, openPlan, steadyPlan } from '../src/workout'
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

console.log(failures === 0 ? '\nOK' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
