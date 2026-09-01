import type { PaceRailSettings, Plan, GlassesScreen, Units } from './types'
import { openPlan } from './workout'

const KEY = 'pacerail.settings.v1'
const PLAN_KEY = 'pacerail.plan.v1'

function randomCode(): string {
  // Ambiguous glyphs left out: this gets typed into a phone by a person who has
  // just finished running.
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679'
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

const DEFAULTS: PaceRailSettings = {
  pairCode: '',
  units: 'mi',
  maxHeartRate: 185,
  homeScreen: 'run',
  templeNav: true,
  mapEnabled: true,
  mapIntervalSec: 6,
  preferLocal: true,
  planName: 'Open run',
}

export function loadSettings(): PaceRailSettings {
  let parsed: Record<string, unknown> = {}
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) parsed = JSON.parse(raw) as Record<string, unknown>
  } catch { /* fall through to defaults */ }

  const screens: GlassesScreen[] = ['run', 'splits', 'zones', 'map']
  const settings: PaceRailSettings = {
    pairCode: typeof parsed.pairCode === 'string' && /^[A-Z0-9]{6}$/.test(parsed.pairCode)
      ? parsed.pairCode : randomCode(),
    units: parsed.units === 'km' ? 'km' : 'mi',
    maxHeartRate: typeof parsed.maxHeartRate === 'number' && parsed.maxHeartRate >= 120 && parsed.maxHeartRate <= 230
      ? parsed.maxHeartRate : DEFAULTS.maxHeartRate,
    homeScreen: screens.includes(parsed.homeScreen as GlassesScreen)
      ? parsed.homeScreen as GlassesScreen : DEFAULTS.homeScreen,
    templeNav: typeof parsed.templeNav === 'boolean' ? parsed.templeNav : DEFAULTS.templeNav,
    mapEnabled: typeof parsed.mapEnabled === 'boolean' ? parsed.mapEnabled : DEFAULTS.mapEnabled,
    mapIntervalSec: typeof parsed.mapIntervalSec === 'number' && parsed.mapIntervalSec >= 2 && parsed.mapIntervalSec <= 60
      ? parsed.mapIntervalSec : DEFAULTS.mapIntervalSec,
    preferLocal: typeof parsed.preferLocal === 'boolean' ? parsed.preferLocal : DEFAULTS.preferLocal,
    planName: typeof parsed.planName === 'string' ? parsed.planName : DEFAULTS.planName,
  }

  // A freshly generated pair code has to survive the next load, or the phone
  // would be told a different code every time the page is opened.
  if (parsed.pairCode !== settings.pairCode) saveSettings(settings)
  return settings
}

export function saveSettings(settings: PaceRailSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode */ }
}

export function updateSetting<K extends keyof PaceRailSettings>(key: K, value: PaceRailSettings[K]): PaceRailSettings {
  const settings = loadSettings()
  settings[key] = value
  saveSettings(settings)
  return settings
}

export function loadPlan(): Plan {
  try {
    const raw = localStorage.getItem(PLAN_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Plan
      if (p && typeof p.name === 'string' && Array.isArray(p.steps) && p.steps.length > 0) return p
    }
  } catch { /* fall through */ }
  return openPlan()
}

export function savePlan(plan: Plan): void {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)) } catch { /* private mode */ }
  updateSetting('planName', plan.name)
}

export function unitsLabel(units: Units): string {
  return units === 'mi' ? 'miles' : 'kilometres'
}

// The packaged WebView's own localStorage does not survive a cold launch, so the
// host's storage is mirrored alongside it. Same trick as LotH.
export const HOST_KEYS = { settings: 'pacerail.settings', plan: 'pacerail.plan' } as const

export function exportState(): { settings: string; plan: string } {
  return { settings: JSON.stringify(loadSettings()), plan: JSON.stringify(loadPlan()) }
}

export function importState(settings: string | null, plan: string | null): void {
  try { if (settings) localStorage.setItem(KEY, settings) } catch { /* ignore */ }
  try { if (plan) localStorage.setItem(PLAN_KEY, plan) } catch { /* ignore */ }
}
