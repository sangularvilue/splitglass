/**
 * The companion: what you set up before the run, and what you check after it.
 *
 * The glasses are the product; this is the control surface. It holds the pair
 * code the phone app needs, the plan the HUD counts down, the route to follow,
 * and a mirror of what the glasses are showing so the whole thing can be
 * debugged without putting them on.
 */

import './styles.css'
import type { GlassesScreen, SplitglassSettings, Plan, Snapshot, TransportKind } from './types'
import { loadPlan, loadSettings, savePlan, updateSetting, exportState, importState, HOST_KEYS } from './settings'
import { createEngine, intervalPlan, zonePlan, type WorkoutView } from './workout'
import {
  BUILT_INS, GROUP_LABELS, ZONE_GUIDE, ZONE_GUIDE_NOTE,
  builtIn, deleteWorkout, loadSaved, parseZoneBlocks, saveWorkout,
  type LibraryGroup,
} from './library'
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

let settings: SplitglassSettings = loadSettings()
let plan: Plan = loadPlan()
let view: WorkoutView = { snapshot: null, staleSeconds: Infinity, zones: null, paceSecPerKm: null, stepPaceSecPerKm: null, avgPaceSecPerKm: null, zoneDriftSeconds: 0, progress: null, splits: [], planComplete: false }
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

/** One line saying what to hold for a step, for the flash and the summary. */
function holdText(step: Plan['steps'][number]): string {
  const u = settings.units
  if (step.holdPaceSecPerKm) return `hold ${fmtPace(step.holdPaceSecPerKm.from, u)}–${fmtPace(step.holdPaceSecPerKm.to, u)}${paceUnitLabel(u)}`
  if (step.holdZone != null) return `hold ${zoneLabel(Math.min(step.holdZone, (view.zones?.count ?? 5) - 1))}`
  return step.easy ? 'easy' : ''
}

const engine = createEngine({
  getPlan: () => plan,
  getMaxHeartRate: () => settings.maxHeartRate,
  onSplit: (s) => log(`Split ${s.index} — ${s.label} ${fmtDuration(s.seconds)} ${fmtShortDistance(s.metres)}`),
  onStepChange: (p) => {
    // A step change is the event a HUD with no haptics most needs to make
    // visible, so it gets three seconds of the whole display.
    if (p) {
      log(`Step ${p.index + 1}/${p.total} — ${p.step.label}`)
      void glasses.flash([p.step.label, holdText(p.step), `${p.index + 1} / ${p.total}`])
    } else {
      void glasses.flash(['Plan complete'])
    }
  },
})

// Zone drift: after 30 s out of the target zone, say so once, then again only
// after you have been back in it.
let driftFlashed = false
function checkDrift(): void {
  if (view.zoneDriftSeconds === 0) { driftFlashed = false; return }
  if (view.zoneDriftSeconds < 30 || driftFlashed) return
  const p = view.progress
  const z = view.zones
  if (!p || p.step.holdZone == null || !z || z.currentIndex == null) return
  const target = Math.min(p.step.holdZone, z.count - 1)
  const verb = z.currentIndex > target ? 'ease' : 'push'
  driftFlashed = true
  void glasses.flash([`${zoneLabel(target)} · ${verb}`, `${Math.round(view.zoneDriftSeconds)}s out of zone`], 2500)
}

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
      <h1>Splitglass</h1>
    </div>
    <div class="hd-live" id="hd-live">—</div>
  </header>

  <section class="card" id="pair-card">
    <div class="card-h">Pair the phone</div>
    <div class="pair">
      <div class="pair-code" id="pair-code">------</div>
      <div class="pair-note">
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

  <section class="card" id="summary" hidden>
    <div class="card-h">Summary <span class="card-h-sub" id="sum-name"></span></div>
    <div class="grid" id="sum-grid"></div>
    <div class="zones" id="sum-zones"></div>
    <div class="tablewrap"><table class="st" id="sum-splits"></table></div>
  </section>

  <section class="card">
    <div class="card-h row-h">
      <span>Plan <span class="card-h-sub" id="plan-name"></span></span>
      <button class="btn mini" id="zone-info" aria-expanded="false" aria-controls="guide" title="Heart-rate zones">i</button>
    </div>

    <div class="guide" id="guide" hidden></div>
    <div class="lib" id="lib"></div>
    <div class="saved" id="saved"></div>

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
      <button class="btn solid" id="b-build">Intervals</button>
    </div>

    <div class="builder">
      <label>Zone blocks <input id="b-zones" placeholder="5@1 20@2 3@4 2@5" size="16"></label>
      <button class="btn solid" id="b-zbuild">Blocks</button>
    </div>

    <div class="builder">
      <label>Name <input id="b-name" placeholder="My session" size="14"></label>
      <button class="btn" id="b-save">Save to library</button>
    </div>

    <ol class="steps" id="plan-steps"></ol>
  </section>

  <section class="card">
    <div class="card-h">Route <span class="card-h-sub">outdoor only</span></div>
    <div class="route">
      <label class="filebtn">Load GPX<input id="gpx" type="file" accept=".gpx,application/gpx+xml,text/xml"></label>
      <button class="btn ghost" id="route-clear">Clear route</button>
      <span class="fine" id="route-note">No route</span>
    </div>
    <div class="mapwrap"><canvas id="mapview" width="384" height="192"></canvas></div>
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
      liveTile('Pace', fmtPace(view.paceSecPerKm, u), paceUnitLabel(u)),
      liveTile('Step pace', fmtPace(view.stepPaceSecPerKm, u), paceUnitLabel(u)),
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
      step.innerHTML = `<span class="fine">${view.planComplete ? 'Plan complete' : 'No step'}</span>`
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
      zonesEl.innerHTML = '<span class="fine">No heart rate</span>'
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
        : z.source === 'apple' ? 'Health'
          : `Estimated · max ${settings.maxHeartRate}`
    }
  }
}

function paintLibrary(): void {
  const el = $('lib')
  if (!el) return
  const groups: LibraryGroup[] = ['distance', 'time', 'intervals', 'zones']
  el.innerHTML = groups.map(group => `
    <div class="lib-row">
      <span class="lib-g">${esc(GROUP_LABELS[group])}</span>
      <div class="lib-b">${BUILT_INS.filter(b => b.group === group)
        .map(b => `<button class="btn" data-builtin="${esc(b.id)}">${esc(b.label)}</button>`)
        .join('')}</div>
    </div>`).join('')
}

function paintSaved(): void {
  const el = $('saved')
  if (!el) return
  const saved = loadSaved()
  if (saved.length === 0) { el.innerHTML = ''; return }
  el.innerHTML = `
    <div class="lib-row">
      <span class="lib-g">Yours</span>
      <div class="lib-b">${saved.map(s => `
        <span class="chip">
          <button class="btn chip-load" data-load="${esc(s.id)}">${esc(s.plan.name)}</button>
          <button class="btn chip-del" data-del="${esc(s.id)}" title="Delete">×</button>
        </span>`).join('')}</div>
    </div>`
}

function paintGuide(): void {
  const el = $('guide')
  if (!el) return
  el.innerHTML = `
    <table class="gt">
      <thead><tr><th>Zone</th><th>Feel</th><th>Purpose</th><th>Week</th></tr></thead>
      <tbody>${ZONE_GUIDE.map(r => `
        <tr>
          <td class="gz">Z${r.zone}<span>${esc(r.name)}</span></td>
          <td>${esc(r.feel)}</td>
          <td>${esc(r.purpose)}</td>
          <td class="gw">${esc(r.week)}</td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="fine">${esc(ZONE_GUIDE_NOTE)}</p>`
}

/**
 * Shown once the watch reports the workout ended, until a new one starts. The
 * same numbers as the live view, frozen, plus every split and the zone totals.
 */
function paintSummary(): void {
  const card = $('summary')
  if (!card) return
  const s = view.snapshot
  const ended = s?.state === 'ended'
  card.hidden = !ended
  if (!ended || !s) return

  const u = settings.units
  const name = $('sum-name')
  if (name) name.textContent = settings.planName

  const hrWeighted = view.splits.reduce((acc, sp) => sp.avgHeartRate != null
    ? { sum: acc.sum + sp.avgHeartRate * sp.seconds, sec: acc.sec + sp.seconds }
    : acc, { sum: 0, sec: 0 })
  const avgHr = hrWeighted.sec > 0 ? Math.round(hrWeighted.sum / hrWeighted.sec) : null

  const grid = $('sum-grid')
  if (grid) {
    grid.innerHTML = [
      liveTile('Distance', fmtDistance(s.distance, u), ` ${u}`),
      liveTile('Time', fmtDuration(s.elapsed)),
      liveTile('Avg pace', fmtPace(view.avgPaceSecPerKm, u), paceUnitLabel(u)),
      liveTile('Avg HR', avgHr != null ? String(avgHr) : '—', ' bpm'),
      liveTile('Energy', s.energy != null ? String(Math.round(s.energy)) : '—', ' kcal'),
      liveTile('Splits', String(view.splits.length)),
    ].join('')
  }

  const zonesEl = $('sum-zones')
  if (zonesEl) {
    const z = view.zones
    if (!z) {
      zonesEl.innerHTML = ''
    } else {
      const total = Math.max(1, z.durations.reduce((a, b) => a + b, 0))
      const longest = Math.max(1, ...z.durations)
      zonesEl.innerHTML = z.durations.map((seconds, i) => `
        <div class="zrow">
          <span class="zn">${esc(zoneLabel(i))}</span>
          <span class="zr">${esc(zoneRangeLabel(z, i))}</span>
          <span class="zb"><i style="width:${Math.round((seconds / longest) * 100)}%"></i></span>
          <span class="zt">${esc(fmtDuration(seconds))} <em>${Math.round((seconds / total) * 100)}%</em></span>
        </div>`).join('')
    }
  }

  const table = $('sum-splits')
  if (table) {
    table.innerHTML = view.splits.length === 0 ? '' : `
      <thead><tr><th>#</th><th>Step</th><th>Time</th><th>Dist</th><th>Pace</th><th>HR</th></tr></thead>
      <tbody>${view.splits.map(sp => `
        <tr>
          <td>${sp.index}</td>
          <td>${esc(sp.label)}</td>
          <td>${esc(fmtDuration(sp.seconds))}</td>
          <td>${esc(fmtShortDistance(sp.metres))}</td>
          <td>${esc(fmtPace(sp.paceSecPerKm, u))}</td>
          <td>${sp.avgHeartRate ?? '—'}</td>
        </tr>`).join('')}</tbody>`
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
    ctx.fillText('no track', 12, 24)
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
      + (track.route().length ? ` · route ${track.route().length}${off2 != null ? ` · ${Math.round(off2)}m off` : ''}` : '')
  }
}

function paint(): void {
  paintStatus()
  paintLive()
  paintSummary()
  paintPlan()
  paintSaved()
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
  void b.setLocalStorage(HOST_KEYS.library, state.library)
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
    localStorage.removeItem('splitglass.settings.v1')
    settings = loadSettings()
    syncSettingsControls()
    log(`New pair code: ${settings.pairCode} — enter it on the phone`)
    void transport.restart()
  })

  // Delegated, because both grids are re-rendered whenever the library changes.
  $('lib')?.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement)?.closest('[data-builtin]')?.getAttribute('data-builtin')
    if (!id) return
    const entry = builtIn(id)
    if (entry) setPlan(entry.build(settings.units))
  })

  $('saved')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const loadId = target.closest('[data-load]')?.getAttribute('data-load')
    if (loadId) {
      const found = loadSaved().find(s => s.id === loadId)
      if (found) setPlan(found.plan)
      return
    }
    const delId = target.closest('[data-del]')?.getAttribute('data-del')
    if (delId) {
      const found = loadSaved().find(s => s.id === delId)
      deleteWorkout(delId)
      log(`Deleted ${found?.plan.name ?? delId}`)
      mirrorToHost()
      paintSaved()
    }
  })

  $('zone-info')?.addEventListener('click', () => {
    const guide = $('guide')
    const button = $('zone-info')
    if (!guide || !button) return
    const showing = guide.hidden
    guide.hidden = !showing
    button.setAttribute('aria-expanded', String(showing))
  })

  $('b-build')?.addEventListener('click', () => setPlan(buildFromForm()))

  $('b-zbuild')?.addEventListener('click', () => {
    const field = $('b-zones') as HTMLInputElement | null
    const text = field?.value ?? ''
    const zoneCount = view.zones?.count ?? 5
    const blocks = parseZoneBlocks(text, zoneCount)
    if (blocks.length === 0) {
      log(`Could not read "${text}" — write it as minutes@zone, e.g. 5@1 20@2 3@4 2@5`)
      return
    }
    const name = (($('b-name') as HTMLInputElement | null)?.value || '').trim()
    setPlan(zonePlan(name || `Zones ${blocks.map(b => `${b.minutes}@${b.zone + 1}`).join(' ')}`, blocks))
  })

  $('b-save')?.addEventListener('click', () => {
    const named = (($('b-name') as HTMLInputElement | null)?.value || '').trim()
    const toSave: Plan = named ? { ...plan, name: named } : plan
    saveWorkout(toSave)
    plan = toSave
    savePlan(toSave)
    settings = loadSettings()
    log(`Saved ${toSave.name}`)
    mirrorToHost()
    paintSaved()
    paintPlan()
  })

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

  const bind = <K extends keyof SplitglassSettings>(id: string, key: K, read: (el: HTMLInputElement & HTMLSelectElement) => SplitglassSettings[K], after?: () => void) => {
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
  paintLibrary()
  paintGuide()
  wire()
  paint()
  paintMapPreview()

  log(`Splitglass — pair code ${settings.pairCode}`)

  const connected = await glasses.connect()
  if (connected) {
    const b = glasses.bridge()!
    // The packaged WebView's localStorage does not survive a cold launch, so
    // pull the host copy back before anything else reads settings.
    const [hostSettings, hostPlan, hostLibrary] = await Promise.all([
      b.getLocalStorage(HOST_KEYS.settings).catch(() => null),
      b.getLocalStorage(HOST_KEYS.plan).catch(() => null),
      b.getLocalStorage(HOST_KEYS.library).catch(() => null),
    ])
    if (hostSettings || hostPlan || hostLibrary) {
      importState(hostSettings, hostPlan, hostLibrary)
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
    checkDrift()
    paint()
    void glasses.refresh()
  }, 1000)

  // The preview is heavier and nobody is watching it mid-run.
  window.setInterval(paintMapPreview, 4000)
}

void boot()
