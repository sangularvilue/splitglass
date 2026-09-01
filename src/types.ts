/**
 * The wire contract between the watch, the relay and the glasses.
 *
 * Everything on the HUD that describes your body or your effort comes from
 * HealthKit, so it is identical on a treadmill and on a road: heart rate, zone,
 * time in zone, distance, active energy and elapsed time all originate in an
 * HKLiveWorkoutBuilder on the watch. Only the map is GPS, and only the map is
 * outdoor-only.
 *
 * Keep this file in step with ios/Shared/Snapshot.swift — the JSON keys are
 * deliberately short because they cross a cellular link once a second.
 */

export type WorkoutState = 'idle' | 'running' | 'paused' | 'ended'

export type ActivityKind = 'running' | 'walking' | 'cycling' | 'hiking' | 'other'

/**
 * Heart-rate zones as HealthKit reports them.
 *
 * `source: 'apple'` means these are the user's own zones out of Health
 * Settings — the same boundaries and the same accumulated time the Fitness app
 * shows — read from HKWorkoutZoneConfiguration and HKLiveWorkoutZoneUpdate.
 * `source: 'computed'` is our fallback for an OS without the zones API: zones
 * derived from a max-heart-rate setting, clearly labelled as ours.
 */
export type ZoneState = {
  source: 'apple' | 'computed'
  /** Number of zones. Apple's default is 5; HealthKit permits 3–9. */
  count: number
  /** Which zone the last sample fell in, 0-based, or null before the first sample. */
  currentIndex: number | null
  /**
   * Upper bounds in bpm, `count - 1` of them: zone 0 has no lower bound and the
   * last zone no upper bound, so the whole range is always covered.
   */
  boundaries: number[]
  /** Seconds accumulated in each zone, `count` of them. */
  durations: number[]
}

/** One reading of the workout, produced by the watch about once a second. */
export type Snapshot = {
  v: 1
  /** Monotonic per-workout counter, so a late packet can be dropped. */
  seq: number
  /** When the watch produced this, ms since epoch. */
  at: number
  /** Stable id for this workout, so the plugin can tell a new run from a resume. */
  workoutId: string
  state: WorkoutState
  activity: ActivityKind
  /** True for an indoor session — the HUD hides the map and pace-per-GPS. */
  indoor: boolean
  /** Seconds of active workout time, pauses excluded. */
  elapsed: number
  /** Metres, from HealthKit — present on a treadmill too. */
  distance: number | null
  heartRate: number | null
  /** Active energy, kcal. */
  energy: number | null
  /** Seconds per kilometre, from HealthKit's own speed when it has one. */
  paceSecPerKm: number | null
  /** Steps per minute. */
  cadence: number | null
  zones: ZoneState | null
}

// ── The plan ──

/**
 * A workout plan is a list of steps the plugin times off HealthKit's own
 * distance and elapsed clock. Distance-based steps work indoors because the
 * distance comes from the watch, not from GPS.
 */
export type StepTarget =
  | { by: 'distance'; metres: number }
  | { by: 'time'; seconds: number }

export type PlanStep = {
  label: string
  target: StepTarget
  /** Optional pace band to hold, in seconds per kilometre. */
  holdPaceSecPerKm?: { from: number; to: number }
  /** Optional heart-rate zone to hold, 0-based. */
  holdZone?: number
  /** Marks a recovery step, so the HUD can say "easy" rather than shout a band. */
  easy?: boolean
}

export type Plan = {
  name: string
  steps: PlanStep[]
}

// ── Derived, computed on the phone ──

/** Where we are in the plan right now. */
export type StepProgress = {
  index: number
  total: number
  step: PlanStep
  /** Seconds remaining for a time step, or the projection for a distance step. */
  secondsLeft: number | null
  /** Metres remaining for a distance step. */
  metresLeft: number | null
  /** 0–1 through the current step. */
  fraction: number
  next: PlanStep | null
}

/** One completed split, as the plugin recorded it. */
export type Split = {
  index: number
  label: string
  seconds: number
  metres: number
  /** Seconds per kilometre over the split. */
  paceSecPerKm: number | null
  avgHeartRate: number | null
}

export type Units = 'mi' | 'km'

export type GlassesScreen = 'run' | 'splits' | 'zones' | 'map'

export type SplitglassSettings = {
  /** Six-character code shared with the phone app, so a relay only feeds you. */
  pairCode: string
  units: Units
  /** Fallback only — ignored whenever HealthKit reports Apple's own zones. */
  maxHeartRate: number
  /** Which screen the glasses open on. */
  homeScreen: GlassesScreen
  /** Left temple steps back through screens, right steps forward. */
  templeNav: boolean
  /** Draw the breadcrumb map for outdoor workouts. */
  mapEnabled: boolean
  /** Seconds between map redraws — an image costs far more BLE than text. */
  mapIntervalSec: number
  /** Try http://127.0.0.1 before the relay (works with no signal at all). */
  preferLocal: boolean
  planName: string
}

/** Where a snapshot came from, for the companion's status line. */
export type TransportKind = 'local' | 'stream' | 'poll' | 'none'
