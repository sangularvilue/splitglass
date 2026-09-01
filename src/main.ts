/**
 * The companion: what you set up before the run, and what you check after it.
 *
 * The glasses are the product; this is the control surface. It holds the pair
 * code the phone app needs, the plan the HUD counts down, the route to follow,
 * and a mirror of what the glasses are showing so the whole thing can be
 * debugged without putting them on.
 */

import './styles.css'
import type { GlassesScreen, PaceRailSettings, Plan, Snapshot, TransportKind, Units } from './types'
import { loadPlan, loadSettings, savePlan, updateSetting, exportState, importState, HOST_KEYS } from './settings'
import { createEngine, intervalPlan, openPlan, steadyPlan, type WorkoutView } from './workout'
import { createTransport, serverOrigin } from './transport'
import { createGlasses } from './glasses'
import { createTrack, renderMap } from './map'
import { buildScreen } from './screens'
import { zoneLabel, zoneRangeLabel } from './zones'
import {
  fmtCountdown, fmtDistance, fmtDuration, fmtPace, fmtShortDistance, paceUnitLabel, parsePace,
} from './format'

const $ = (id: string) => document.getElementById(id)
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

let settings: PaceRailSettings = loadSettings()
let plan: Plan = loadPlan()
let view: WorkoutView = { snapshot: null, staleSeconds: Infinity, zones: null, avgPaceSecPerKm: null, progress: null, splits: [], planComplete: false }
let transportKind: TransportKind = 'none'
let transportDetail = 'starting'

const logLines: string[] = []
function log(msg: string): void {
  const stamp = new Date().toLocaleTimeString([], { hour12: false })
  logLines.unshift(`${stamp}  ${msg}`)
  if (logLines.length > 200) logLines.pop()
  const el = $('log')
  if (el) el.textContent = logLines.join('\n')
}

const track = createTrack()

const engine = createEngine({
  getPlan: () => plan,
  getMaxHeartRate: () => settings.maxHeartRate,
  onSplit: (s) => log(`Split ${s.index} — ${s.label} ${fmtDuration(s.seconds)} ${fmtShortDistance(s.metres)}`),
  onStepChange: (p) => { if (p) log(`Step ${p.index + 1}/${p.total} — ${p.step.label}`) },
})

const glasses = createGlasses({
  log,
  getSettings: () => settings,
  getView: () => view,
  getTransport: () => transportKind,
  getTrack: () => track,
  onLap: () => { view = engine.lap(); paint() },
  onRestartPlan: () => { view = engine.restartPlan(); paint() },
  onToggleUnits: () => {
    settings = updateSetting('units', settings.units === 'mi' ? 'km' : 'mi')
    paint()
  },
  onScreenChange: () => paint(),
})

const transport = createTransport({
  getPairCode: () => settings.pairCode,
  preferLocal: () => settings.preferLocal,
  onSnapshot: (snap: Snapshot) => {
    view = engine.ingest(snap)
    paint()
  },
  onStatus: (kind, detail) => {
    if (kind !== transportKind) log(`Transport: ${kind} (${detail})`)
    transportKind = kind
    transportDetail = detail
    paintStatus()
  },
  log,
})

// ── Shell ──

function shell(): string {
  return `
  <header class="hd">
    <div class="hd-mark">▚▚</div>
    <div>
      <h1>Pace Rail</h1>
      <p class="hd-sub">HealthKit on your wrist, on the glass in front of you</p>
    </div>
    <div class="hd-live" id="hd-live">—</div>
  </header>

  <section class="card" id="pair-card">
    <div class="card-h">Pair the phone</div>
    <div class="pair">
      <div class="pair-code" id="pair-code">------</div>
      <div class="pair-note">
        Enter this in <b>Pace Rail</b> on the iPhone. It scopes the relay, so only
        your own workout reaches these glasses.
        <div class="pair-actions">
          <button class="btn" id="pair-copy">Copy</button>
          <button class="btn ghost" id="pair-new">New code</button>
        </div>
      </div>
    </div>
    <div class="statusline" id="statusline">—</div>
  </section>

  <section class="card">
    <div class="card-h">Live</div>
    <div class="grid" id="live-grid"></div>
    <div class="step" id="live-step"></div>
  </section>

  <section class="card">
    <div class="card-h">Heart-rate zones</div>
    <div class="zones" id="live-zones"></div>
    <p class="fine" id="zones-note"></p>
  </section>

  <section class="card">
    <div class="card-h">Plan <span class="card-h-sub" id="plan-name"></span></div>
    <div class="presets">
      <button class="btn" data-preset="open">Open run</button>
      <button class="btn" data-preset="units">Unit splits</button>
      <button class="btn" data-preset="400s">8 × 400m</button>
      <button class="btn" data-preset="mile">4 × 1 mile</button>
      <button class="btn" data-preset="tempo">20 min tempo</button>
    </div>
    <div class="builder">
      <label>Reps <input id="b-reps" type="number" min="1" max="40" value="8"></label>
      <label>Work
        <select id="b-work-by"><option value="distance">metres</option><option value="time">seconds</option></select>
        <input id="b-work" type="number" min="10" max="42195" value="400">
      </label>
      <label>Recovery
        <select id="b-rec-by"><option value="time">seconds</option><option value="distance">metres</option></select>
        <input id="b-rec" type="number" min="0" max="3600" value="90">
      </label>
      <label>Hold pace <input id="b-pace-from" placeholder="6:20" size="5"> – <input id="b-pace-to" placeholder="6:40" size="5"></label>
      <button class="btn solid" id="b-build">Build</button>
    </div>
    <ol class="steps" id="plan-steps"></ol>
  </section>

  <section class="card">
    <div class="card-h">Route <span class="card-h-sub">outdoor only</span></div>
    <div class="route">
      <label class="filebtn">Load GPX<input id="gpx" type="file" accept=".gpx,application/gpx+xml,text/xml"></label>
      <button class="btn ghost" id="route-clear">Clear route</button>
      <span class="fine" id="route-note">No route loaded</span>
    </div>
    <div class="mapwrap"><canvas id="mapview" width="384" height="192"></canvas></div>
    <p class="fine">Drawn exactly as the glasses draw it, then reduced to 16 grey levels.</p>
  </section>

  <section class="card">
    <div class="card-h">Settings</div>
    <div class="rows">
      <div class="row"><span>Units</span><span><select id="s-units">
        <option value="mi">miles</option><option value="km">kilometres</option></select></span></div>
      <div class="row"><span>Max heart rate <em>fallback only</em></span>
        <span><input id="s-maxhr" type="number" min="120" max="230"></span></div>
      <div class="row"><span>Opening screen</span><span><select id="s-home">
        <option value="run">Run</option><option value="splits">Splits</option>
        <option value="zones">Zones</option><option value="map">Map</option></select></span></div>
      <div class="row"><span>Left temple goes back</span><span><select id="s-temple">
        <option value="1">on</option><option value="0">off</option></select></span></div>
      <div class="row"><span>Draw the map</span><span><select id="s-map">
        <option value="1">on</option><option value="0">off</option></select></span></div>
      <div class="row"><span>Map redraw</span><span><input id="s-mapint" type="number" min="2" max="60"> s</span></div>
      <div class="row"><span>Try the phone first <em>no network</em></span><span><select id="s-local">
        <option value="1">on</option><option value="0">off</option></select></span></div>
    </div>
  </section>

  <section class="card">
    <div class="card-h">On the glasses <span class="card-h-sub" id="mirror-screen"></span></div>
    <div class="mirror" id="mirror"></div>
  </section>

  <section class="card">
    <div class="card-h">Log</div>
    <pre class="log" id="log"></pre>
  </section>`
}

// ── Painting ──

function paintStatus(): void {
  const el = $('statusline')
  if (el) {
    const relay = serverOrigin() || location.origin
    el.innerHTML = `<b>${esc(transportKind)}</b> · ${esc(transportDetail)} · relay <code>${esc(relay)}</code>`
    el.className = `statusline ${transportKind === 'none' ? 'bad' : 'good'}`
  }
  const live = $('hd-live')
  if (live) {
    const s = view.snapshot
    live.textContent = s ? `${s.state}${s.indoor ? ' · indoor' : ''}` : 'waiting'
    live.className = `hd-live ${s?.state === 'running' ? 'on' : ''}`
  }
}

function liveTile(label: string, value: string, unit = ''): string {
  return `<div class="tile"><span class="tl">${esc(label)}</span><span class="tv">${esc(value)}<em>${esc(unit)}</em></span></div>`
}

function paintLive(): void {
  const s = view.snapshot
  const u = settings.units
  const grid = $('live-grid')
  if (grid) {
    grid.innerHTML = [
      liveTile('Distance', fmtDistance(s?.distance ?? null, u), ` ${u}`),
      liveTile('Elapsed', fmtDuration(s?.elapsed ?? null)),
      liveTile('Heart rate', s?.heartRate != null ? String(Math.round(s.heartRate)) : '—', ' bpm'),
      liveTile('Pace', fmtPace(s?.paceSecPerKm ?? null, u), paceUnitLabel(u)),
      liveTile('Average', fmtPace(view.avgPaceSecPerKm, u), paceUnitLabel(u)),
      liveTile('Energy', s?.energy != null ? String(Math.round(s.energy)) : '—', ' kcal'),
      liveTile('Cadence', s?.cadence != null ? String(Math.round(s.cadence)) : '—', ' spm'),
      liveTile('Zone', view.zones?.currentIndex != null ? zoneLabel(view.zones.currentIndex) : '—'),
    ].join('')
  }

  const step = $('live-step')
  if (step) {
    const p = view.progress
    if (!p) {
      step.innerHTML = `<span class="fine">${view.planComplete ? 'Plan complete.' : 'No step running — start a workout on the watch.'}</span>`
    } else {
      const left = p.step.target.by === 'time'
        ? `${fmtCountdown(p.secondsLeft)} left`
        : `${fmtShortDistance(p.metresLeft)} left`
      step.innerHTML = `
        <div class="step-h"><b>${esc(p.step.label)}</b> <span class="fine">${p.index + 1} of ${p.total}</span></div>
        <div class="step-bar"><i style="width:${Math.round(p.fraction * 100)}%"></i></div>
        <div class="step-f">${esc(left)}${p.next ? ` · next ${esc(p.next.label)}` : ' · last step'}</div>`
    }
  }

  const zonesEl = $('live-zones')
  if (zonesEl) {
    const z = view.zones
    if (!z) {
      zonesEl.innerHTML = '<span class="fine">Waiting for a heart rate.</span>'
    } else {
      const longest = Math.max(1, ...z.durations)
      zonesEl.innerHTML = z.durations.map((seconds, i) => `
        <div class="zrow${i === z.currentIndex ? ' now' : ''}">
          <span class="zn">${esc(zoneLabel(i))}</span>
          <span class="zr">${esc(zoneRangeLabel(z, i))}</span>
          <span class="zb"><i style="width:${Math.round((seconds / longest) * 100)}%"></i></span>
          <span class="zt">${esc(fmtDuration(seconds))}</span>
        </div>`).join('')
    }
    const note = $('zones-note')
    if (note) {
      note.textContent = !z ? ''
        : z.source === 'apple'
          ? 'Your own zones, straight out of Health — the same boundaries and the same accumulated time the Fitness app will show for this workout.'
          : `Estimated from a maximum of ${settings.maxHeartRate} bpm. These are not Apple's zones; they appear only because HealthKit sent none (an OS without the workout-zones API, or no heart-rate source).`
    }
  }
}

function paintPlan(): void {
  const name = $('plan-name')
  if (name) name.textContent = plan.name
  const list = $('plan-steps')
  if (!list) return
  const u = settings.units
  list.innerHTML = plan.steps.slice(0, 60).map((s) => {
    const target = s.target.by === 'time' ? fmtCountdown(s.target.seconds) : fmtShortDistance(s.target.metres)
    const hold = s.holdPaceSecPerKm
      ? ` hold ${fmtPace(s.holdPaceSecPerKm.from, u)}–${fmtPace(s.holdPaceSecPerKm.to, u)}${paceUnitLabel(u)}`
      : s.easy ? ' easy' : ''
    return `<li><b>${esc(s.label)}</b> <span class="fine">${esc(target)}${esc(hold)}</span></li>`
  }).join('') + (plan.steps.length > 60 ? `<li class="fine">…and ${plan.steps.length - 60} more</li>` : '')
}

function paintMirror(): void {
  const el = $('mirror')
  if (!el) return
  const screen = glasses.screen()
  const label = $('mirror-screen')
  if (label) label.textContent = screen
  const map = glasses.lastMap()
  const spec = buildScreen(screen, view, transportKind, settings, {
    available: !!map,
    scaleMetres: map?.scaleMetres ?? null,
    offRouteMetres: track.offRouteMetres(),
    gpsMetres: track.points().length >= 2 ? track.gpsMetres() : null,
  })

  // The 576×288 canvas at half scale, with each container placed where the
  // glasses place it and shaded by its brightness level.
  const boxes = [
    ...spec.text.map(t => ({ ...t, kind: 'text' as const, body: t.content })),
    ...spec.lists.map(l => ({ ...l, kind: 'list' as const, level: 3, body: l.items.join('\n') })),
    ...spec.images.map(i => ({ ...i, kind: 'image' as const, level: 2, body: '[map]' })),
  ]
  el.innerHTML = `<div class="hud">${boxes.map(b => `
    <div class="hud-box k-${b.kind}" style="left:${b.x / 2}px;top:${b.y / 2}px;width:${b.w / 2}px;height:${b.h / 2}px;opacity:${0.35 + 0.1625 * b.level}">${esc(b.body)}</div>`).join('')}</div>`
}

function paintMapPreview(): void {
  const canvas = $('mapview') as HTMLCanvasElement | null
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#0b0f0c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const drawn = renderMap(track, { width: canvas.width / 2, height: canvas.height / 2 })
  if (!drawn) {
    ctx.fillStyle = '#4e7a4c'
    ctx.font = '12px ui-monospace, monospace'
    ctx.fillText('no track yet — outdoor workouts only', 12, 24)
    return
  }
  // Paint the reduced 4-bit data, not the source canvas: this is what the
  // glasses actually receive.
  const img = ctx.createImageData(drawn.width, drawn.height)
  for (let p = 0; p < drawn.gray8.length; p++) {
    const level = drawn.gray8[p]! >> 4          // 0–15, exactly what the display has
    const v = Math.round((level / 15) * 255)
    img.data[p * 4] = Math.round(v * 0.42)
    img.data[p * 4 + 1] = v
    img.data[p * 4 + 2] = Math.round(v * 0.40)
    img.data[p * 4 + 3] = 255
  }
  const off = document.createElement('canvas')
  off.width = drawn.width
  off.height = drawn.height
  off.getContext('2d')!.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height)

  const note = $('route-note')
  if (note) {
    const off2 = track.offRouteMetres()
    note.textContent = `${track.points().length} fixes · ${fmtDistance(track.gpsMetres(), settings.units)} ${settings.units}`
      + (track.route().length ? ` · route ${track.route().length} points${off2 != null ? ` · ${Math.round(off2)}m off` : ''}` : ' · no route')
  }
}

function paint(): void {
  paintStatus()
  paintLive()
  paintPlan()
  paintMirror()
}

// ── Wiring ──

function syncSettingsControls(): void {
  ;($('s-units') as HTMLSelectElement).value = settings.units
  ;($('s-maxhr') as HTMLInputElement).value = String(settings.maxHeartRate)
  ;($('s-home') as HTMLSelectElement).value = settings.homeScreen
  ;($('s-temple') as HTMLSelectElement).value = settings.templeNav ? '1' : '0'
  ;($('s-map') as HTMLSelectElement).value = settings.mapEnabled ? '1' : '0'
  ;($('s-mapint') as HTMLInputElement).value = String(settings.mapIntervalSec)
  ;($('s-local') as HTMLSelectElement).value = settings.preferLocal ? '1' : '0'
  const code = $('pair-code')
  if (code) code.textContent = settings.pairCode
}

function mirrorToHost(): void {
  const b = glasses.bridge()
  if (!b) return
  const state = exportState()
  void b.setLocalStorage(HOST_KEYS.settings, state.settings)
  void b.setLocalStorage(HOST_KEYS.plan, state.plan)
}

function setPlan(next: Plan): void {
  plan = next
  savePlan(next)
  settings = loadSettings()
  view = engine.restartPlan()
  log(`Plan: ${next.name} (${next.steps.length} steps)`)
  mirrorToHost()
  paint()
  void glasses.renderScreen()
}

function buildFromForm(): Plan {
  const reps = Math.max(1, Number(($('b-reps') as HTMLInputElement).value) || 8)
  const workBy = ($('b-work-by') as HTMLSelectElement).value
  const workVal = Math.max(1, Number(($('b-work') as HTMLInputElement).value) || 400)
  const recBy = ($('b-rec-by') as HTMLSelectElement).value
  const recVal = Math.max(0, Number(($('b-rec') as HTMLInputElement).value) || 0)

  const from = parsePace(($('b-pace-from') as HTMLInputElement).value, settings.units)
  const to = parsePace(($('b-pace-to') as HTMLInputElement).value, settings.units)
  const hold = from != null && to != null ? { from: Math.min(from, to), to: Math.max(from, to) } : undefined

  return intervalPlan({
    name: `${reps} × ${workBy === 'distance' ? `${workVal}m` : `${workVal}s`}`,
    reps,
    work: workBy === 'distance' ? { by: 'distance', metres: workVal } : { by: 'time', seconds: workVal },
    recovery: recVal > 0
      ? (recBy === 'distance' ? { by: 'distance', metres: recVal } : { by: 'time', seconds: recVal })
      : null,
    holdPaceSecPerKm: hold,
    warmupSeconds: 600,
    cooldownSeconds: 600,
  })
}

/** Minimal GPX reader: every trkpt / rtept / wpt, in document order. */
function parseGpx(xml: string): { lat: number; lon: number }[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return []
  const nodes = doc.querySelectorAll('trkpt, rtept, wpt')
  const out: { lat: number; lon: number }[] = []
  nodes.forEach((n) => {
    const lat = Number(n.getAttribute('lat'))
    const lon = Number(n.getAttribute('lon'))
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon })
  })
  return out
}

function wire(): void {
  $('pair-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(settings.pairCode); log('Pair code copied') }
    catch { log(`Pair code: ${settings.pairCode}`) }
  })

  $('pair-new')?.addEventListener('click', () => {
    localStorage.removeItem('pacerail.settings.v1')
    settings = loadSettings()
    syncSettingsControls()
    log(`New pair code: ${settings.pairCode} — enter it on the phone`)
    void transport.restart()
  })

  document.querySelectorAll('[data-preset]').forEach((el) => {
    el.addEventListener('click', () => {
      const which = (el as HTMLElement).dataset.preset
      const u: Units = settings.units
      if (which === 'open') setPlan(openPlan())
      else if (which === 'units') setPlan(steadyPlan(u === 'mi' ? 'Mile splits' : 'Km splits', 13, u))
      else if (which === '400s') setPlan(intervalPlan({
        name: '8 × 400m', reps: 8,
        work: { by: 'distance', metres: 400 },
        recovery: { by: 'time', seconds: 90 },
        warmupSeconds: 600, cooldownSeconds: 600,
      }))
      else if (which === 'mile') setPlan(intervalPlan({
        name: '4 × 1 mile', reps: 4,
        work: { by: 'distance', metres: 1609 },
        recovery: { by: 'time', seconds: 180 },
        warmupSeconds: 900, cooldownSeconds: 600,
      }))
      else if (which === 'tempo') setPlan({
        name: '20 min tempo',
        steps: [
          { label: 'Warm-up', target: { by: 'time', seconds: 900 }, easy: true },
          { label: 'Tempo', target: { by: 'time', seconds: 1200 } },
          { label: 'Cool-down', target: { by: 'time', seconds: 600 }, easy: true },
        ],
      })
    })
  })

  $('b-build')?.addEventListener('click', () => setPlan(buildFromForm()))

  $('gpx')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const points = parseGpx(await file.text())
    if (points.length < 2) { log(`${file.name}: no track points found`); return }
    track.setRoute(points)
    glasses.invalidateMap()
    log(`Route loaded: ${file.name} — ${points.length} points`)
    paintMapPreview()
    paint()
  })

  $('route-clear')?.addEventListener('click', () => {
    track.setRoute([])
    glasses.invalidateMap()
    log('Route cleared')
    paintMapPreview()
  })

  const bind = <K extends keyof PaceRailSettings>(id: string, key: K, read: (el: HTMLInputElement & HTMLSelectElement) => PaceRailSettings[K], after?: () => void) => {
    $(id)?.addEventListener('change', (e) => {
      settings = updateSetting(key, read(e.target as HTMLInputElement & HTMLSelectElement))
      log(`${String(key)}: ${String(settings[key])}`)
      mirrorToHost()
      after?.()
      paint()
      void glasses.renderScreen()
    })
  }

  bind('s-units', 'units', el => (el.value === 'km' ? 'km' : 'mi'))
  bind('s-maxhr', 'maxHeartRate', el => Math.max(120, Math.min(230, Number(el.value) || 185)))
  bind('s-home', 'homeScreen', el => el.value as GlassesScreen)
  bind('s-temple', 'templeNav', el => el.value === '1')
  bind('s-map', 'mapEnabled', el => el.value === '1')
  bind('s-mapint', 'mapIntervalSec', el => Math.max(2, Math.min(60, Number(el.value) || 6)))
  bind('s-local', 'preferLocal', el => el.value === '1', () => void transport.restart())
}

// ── Boot ──

async function boot(): Promise<void> {
  const app = $('app')
  if (!app) return
  app.innerHTML = shell()
  syncSettingsControls()
  wire()
  paint()
  paintMapPreview()

  log(`Pace Rail — pair code ${settings.pairCode}`)

  const connected = await glasses.connect()
  if (connected) {
    const b = glasses.bridge()!
    // The packaged WebView's localStorage does not survive a cold launch, so
    // pull the host copy back before anything else reads settings.
    const [hostSettings, hostPlan] = await Promise.all([
      b.getLocalStorage(HOST_KEYS.settings).catch(() => null),
      b.getLocalStorage(HOST_KEYS.plan).catch(() => null),
    ])
    if (hostSettings || hostPlan) {
      importState(hostSettings, hostPlan)
      settings = loadSettings()
      plan = loadPlan()
      syncSettingsControls()
      paint()
      log('Restored settings from the host')
    }
    if (settings.mapEnabled) void track.watch(b, log)
  }

  await transport.start()

  // One clock drives the HUD. Text at 1 Hz is well inside the BLE budget; the
  // map runs on its own slower timer inside the glasses controller.
  window.setInterval(() => {
    view = engine.view()
    paint()
    void glasses.refresh()
  }, 1000)

  // The preview is heavier and nobody is watching it mid-run.
  window.setInterval(paintMapPreview, 4000)
}

void boot()
