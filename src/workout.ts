/**
 * The engine: snapshots in, a HUD-shaped view out.
 *
 * The watch owns the workout. This owns the *plan* — where you are in it, how
 * much of the current step is left, and what each finished split came to. Both
 * are timed off HealthKit's own elapsed clock and HealthKit's own distance,
 * which is what makes a distance-based interval work on a treadmill: the metres
 * come from the watch, not from GPS.
 *
 * Nothing here touches the glasses or the network. It is a pure reducer, so the
 * splits logic can be checked without a run (see checks/workout.ts).
 */

import type {
  Plan, PlanStep, Snapshot, Split, StepProgress, ZoneState, Units,
} from './types'
import { METRES_PER_MILE, paceFrom } from './format'
import { computedZones, accumulate, zoneForHeartRate } from './zones'

export type WorkoutView = {
  snapshot: Snapshot | null
  /** Seconds since the last snapshot arrived — the HUD greys out when this grows. */
  staleSeconds: number
  zones: ZoneState | null
  /** Average pace over the whole workout, seconds per kilometre. */
  avgPaceSecPerKm: number | null
  progress: StepProgress | null
  splits: Split[]
  /** True once every step of the plan is done. */
  planComplete: boolean
}

type StepCursor = {
  index: number
  startElapsed: number
  startDistance: number
  hrSum: number
  hrCount: number
}

export type Engine = ReturnType<typeof createEngine>

export function createEngine(opts: {
  getPlan: () => Plan
  getMaxHeartRate: () => number
  onSplit?: (split: Split) => void
  onStepChange?: (progress: StepProgress | null) => void
}) {
  let snapshot: Snapshot | null = null
  let receivedAt = 0
  let workoutId: string | null = null
  let cursor: StepCursor | null = null
  let splits: Split[] = []
  let planComplete = false

  // Only used when the watch sends no zone payload at all.
  let fallbackDurations: number[] | null = null
  let lastZoneSampleAt: number | null = null

  function reset(): void {
    cursor = null
    splits = []
    planComplete = false
    fallbackDurations = null
    lastZoneSampleAt = null
  }

  /**
   * Open a step at an explicit boundary rather than "wherever the packet
   * landed". Readings arrive about once a second, so a 400m step is typically
   * overshot by a stride or two and a step shorter than the gap between packets
   * would otherwise be skipped entirely. Starting the next step at the boundary
   * the target actually fell on keeps splits exact and lets a single late packet
   * close every step it spans.
   */
  function startStep(index: number, atElapsed: number, atDistance: number): void {
    cursor = { index, startElapsed: atElapsed, startDistance: atDistance, hrSum: 0, hrCount: 0 }
  }

  function consumed(snap: Snapshot): { seconds: number; metres: number } {
    if (!cursor) return { seconds: 0, metres: 0 }
    return {
      seconds: Math.max(0, snap.elapsed - cursor.startElapsed),
      metres: Math.max(0, (snap.distance ?? 0) - cursor.startDistance),
    }
  }

  /**
   * Where this step's target was actually met, interpolated inside the packet
   * that overshot it. A time step's distance and a distance step's time are both
   * apportioned linearly, which over a one-second reading is exact enough to be
   * indistinguishable from the truth.
   */
  function boundaryOf(step: PlanStep, snap: Snapshot): { seconds: number; metres: number } {
    const total = consumed(snap)
    if (step.target.by === 'time') {
      const seconds = Math.min(total.seconds, step.target.seconds)
      const f = total.seconds > 0 ? seconds / total.seconds : 0
      return { seconds, metres: total.metres * f }
    }
    const metres = Math.min(total.metres, step.target.metres)
    const f = total.metres > 0 ? metres / total.metres : 0
    return { seconds: total.seconds * f, metres }
  }

  function recordSplit(step: PlanStep, at: { seconds: number; metres: number }): void {
    if (!cursor) return
    const { seconds, metres } = at
    const split: Split = {
      index: splits.length + 1,
      label: step.label,
      seconds,
      metres,
      paceSecPerKm: paceFrom(metres, seconds),
      avgHeartRate: cursor.hrCount > 0 ? Math.round(cursor.hrSum / cursor.hrCount) : null,
    }
    splits = [...splits, split]
    opts.onSplit?.(split)
  }

  /** Target reached? Distance steps also fall through on time if distance is dead. */
  function stepDone(step: PlanStep, snap: Snapshot): boolean {
    const { seconds, metres } = consumed(snap)
    if (step.target.by === 'time') return seconds >= step.target.seconds
    return metres >= step.target.metres
  }

  function advance(snap: Snapshot, at?: { seconds: number; metres: number }): void {
    const plan = opts.getPlan()
    if (!cursor) return
    const step = plan.steps[cursor.index]
    if (!step) return

    const boundary = at ?? boundaryOf(step, snap)
    const nextElapsed = cursor.startElapsed + boundary.seconds
    const nextDistance = cursor.startDistance + boundary.metres

    recordSplit(step, boundary)

    const nextIndex = cursor.index + 1
    if (nextIndex >= plan.steps.length) {
      planComplete = true
      cursor = null
      opts.onStepChange?.(null)
      return
    }
    startStep(nextIndex, nextElapsed, nextDistance)
    opts.onStepChange?.(progress())
  }

  function progress(): StepProgress | null {
    const plan = opts.getPlan()
    if (!cursor || !snapshot) return null
    const step = plan.steps[cursor.index]
    if (!step) return null

    const { seconds, metres } = consumed(snapshot)

    let secondsLeft: number | null = null
    let metresLeft: number | null = null
    let fraction = 0

    if (step.target.by === 'time') {
      secondsLeft = Math.max(0, step.target.seconds - seconds)
      fraction = step.target.seconds > 0 ? Math.min(1, seconds / step.target.seconds) : 0
    } else {
      metresLeft = Math.max(0, step.target.metres - metres)
      fraction = step.target.metres > 0 ? Math.min(1, metres / step.target.metres) : 0
      // Project the time left from the pace you are actually holding, so a
      // distance step still gives you a number to count down.
      const pace = snapshot.paceSecPerKm ?? paceFrom(metres, seconds)
      if (pace != null && metresLeft != null) secondsLeft = (metresLeft / 1000) * pace
    }

    return {
      index: cursor.index,
      total: plan.steps.length,
      step,
      secondsLeft,
      metresLeft,
      fraction,
      next: plan.steps[cursor.index + 1] ?? null,
    }
  }

  function resolveZones(snap: Snapshot): ZoneState | null {
    // HealthKit's own zones always win: same boundaries, same accumulated time
    // the Fitness app will show.
    if (snap.zones) { fallbackDurations = null; return snap.zones }
    if (snap.heartRate == null) return null

    // No zone payload — accumulate our own from the max-HR setting, and keep the
    // `computed` label on it so the UI can say whose maths it is.
    const now = snap.at
    const delta = lastZoneSampleAt != null ? Math.min(10, (now - lastZoneSampleAt) / 1000) : 0
    lastZoneSampleAt = now

    const base = computedZones(opts.getMaxHeartRate(), snap.heartRate, fallbackDurations ?? undefined)
    const index = zoneForHeartRate(base, snap.heartRate)
    fallbackDurations = accumulate(base.durations, index, delta)
    return { ...base, currentIndex: index, durations: fallbackDurations }
  }

  return {
    /** Feed one snapshot in. Returns the derived view. */
    ingest(snap: Snapshot): WorkoutView {
      // A late or duplicate packet must never wind the clock backwards.
      if (snapshot && snap.workoutId === workoutId && snap.seq <= snapshot.seq) return this.view()

      if (snap.workoutId !== workoutId) {
        workoutId = snap.workoutId
        reset()
      }
      if (snap.state === 'idle' || snap.state === 'ended') {
        if (snap.state === 'idle') reset()
      } else if (!cursor && !planComplete) {
        startStep(0, snap.elapsed, snap.distance ?? 0)
        opts.onStepChange?.(progress())
      }

      snapshot = snap
      receivedAt = Date.now()

      if (cursor && snap.heartRate != null) {
        cursor.hrSum += snap.heartRate
        cursor.hrCount += 1
      }

      // Walk forward, not just one step: a single late packet can span a whole
      // short recovery step, and the splits list has to reflect that.
      let guard = 0
      while (cursor && snap.state === 'running' && stepDone(opts.getPlan().steps[cursor.index]!, snap) && guard++ < 64) {
        advance(snap)
      }

      return this.view()
    },

    /**
     * Force the current step closed — the Lap gesture. A lap ends the step
     * *here*, so the boundary is the whole of what has been consumed rather than
     * the target that was never reached.
     */
    lap(): WorkoutView {
      if (snapshot && cursor && snapshot.state === 'running') advance(snapshot, consumed(snapshot))
      return this.view()
    },

    /** Start the plan again from step one without waiting for a new workout. */
    restartPlan(): WorkoutView {
      reset()
      if (snapshot) { startStep(0, snapshot.elapsed, snapshot.distance ?? 0); opts.onStepChange?.(progress()) }
      return this.view()
    },

    view(): WorkoutView {
      const snap = snapshot
      return {
        snapshot: snap,
        staleSeconds: receivedAt > 0 ? (Date.now() - receivedAt) / 1000 : Infinity,
        zones: snap ? resolveZones(snap) : null,
        avgPaceSecPerKm: snap ? (paceFrom(snap.distance, snap.elapsed)) : null,
        progress: progress(),
        splits,
        planComplete,
      }
    },

    clear(): void {
      snapshot = null
      receivedAt = 0
      workoutId = null
      reset()
    },
  }
}

// ── Plan builders ──

/** Even splits: `8 × 400m hard / 90s easy`, or `mile repeats`. */
export function intervalPlan(opts: {
  name: string
  reps: number
  work: { by: 'distance'; metres: number } | { by: 'time'; seconds: number }
  recovery: { by: 'distance'; metres: number } | { by: 'time'; seconds: number } | null
  holdPaceSecPerKm?: { from: number; to: number }
  warmupSeconds?: number
  cooldownSeconds?: number
}): Plan {
  const steps: PlanStep[] = []
  if (opts.warmupSeconds) {
    steps.push({ label: 'Warm-up', target: { by: 'time', seconds: opts.warmupSeconds }, easy: true })
  }
  for (let i = 1; i <= opts.reps; i++) {
    steps.push({
      label: `Rep ${i}/${opts.reps}`,
      target: opts.work,
      holdPaceSecPerKm: opts.holdPaceSecPerKm,
    })
    if (opts.recovery && i < opts.reps) {
      steps.push({ label: 'Easy', target: opts.recovery, easy: true })
    }
  }
  if (opts.cooldownSeconds) {
    steps.push({ label: 'Cool-down', target: { by: 'time', seconds: opts.cooldownSeconds }, easy: true })
  }
  return { name: opts.name, steps }
}

/** A steady run cut into unit splits, so the HUD counts down to each one. */
export function steadyPlan(name: string, totalUnits: number, units: Units, holdPaceSecPerKm?: { from: number; to: number }): Plan {
  const metres = units === 'mi' ? METRES_PER_MILE : 1000
  const steps: PlanStep[] = []
  for (let i = 1; i <= totalUnits; i++) {
    steps.push({
      label: `${units === 'mi' ? 'Mile' : 'Km'} ${i}`,
      target: { by: 'distance', metres },
      holdPaceSecPerKm,
    })
  }
  return { name, steps }
}

/**
 * A set distance, cut into whole units with a remainder step.
 *
 * A 5K in miles is three whole miles and a bit; the bit gets its own step so the
 * HUD counts down to the finish rather than to the last full mile. Distance comes
 * from HealthKit, so this works on a treadmill.
 */
export function distancePlan(name: string, totalMetres: number, units: Units): Plan {
  const unit = units === 'mi' ? METRES_PER_MILE : 1000
  const word = units === 'mi' ? 'Mile' : 'Km'
  const steps: PlanStep[] = []

  const whole = Math.floor(totalMetres / unit)
  for (let i = 1; i <= whole; i++) {
    steps.push({ label: `${word} ${i}`, target: { by: 'distance', metres: unit } })
  }

  // Anything under 20 m is rounding, not a split.
  const remainder = totalMetres - whole * unit
  if (remainder > 20) steps.push({ label: 'Finish', target: { by: 'distance', metres: remainder } })
  if (steps.length === 0) steps.push({ label: name, target: { by: 'distance', metres: totalMetres } })

  return { name, steps }
}

/** A set time, as one step. The HUD counts it down. */
export function timePlan(name: string, seconds: number): Plan {
  return { name, steps: [{ label: name, target: { by: 'time', seconds } }] }
}

export type ZoneBlock = {
  /** 0-based, matching HealthKit. Z1 on the display is zone 0 here. */
  zone: number
  minutes: number
  label?: string
}

/**
 * Time in heart-rate zones: `5 min in Z1, 20 in Z2, 3 in Z4, 2 in Z5`.
 *
 * Each block is a timed step with a zone to hold, which is how structured
 * workouts work everywhere else — the clock runs whether or not you are in the
 * zone, and the HUD tells you to ease or push. Holding the step open until you
 * had *accumulated* the time in zone would be the stricter reading, and it makes
 * a session that can never end if you are having a bad day.
 */
export function zonePlan(name: string, blocks: ZoneBlock[]): Plan {
  return {
    name,
    steps: blocks.map(block => ({
      label: block.label ?? `Z${block.zone + 1} · ${block.minutes} min`,
      target: { by: 'time', seconds: Math.round(block.minutes * 60) },
      holdZone: block.zone,
      easy: block.zone <= 1,
    })),
  }
}

/** No plan: one open-ended step, so the HUD still shows elapsed and pace. */
export function openPlan(): Plan {
  return {
    name: 'Open run',
    steps: [{ label: 'Run', target: { by: 'time', seconds: 24 * 3600 } }],
  }
}
