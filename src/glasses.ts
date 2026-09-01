/**
 * The glasses side: pages, page turns, gestures and the long-press menu.
 *
 * Screens differ in their container sets, so switching screens is a rebuild;
 * staying on a screen is a set of in-place text upgrades, which is what keeps a
 * once-a-second HUD inside the BLE budget. The map is the exception — an image
 * costs roughly a thousand times what a text line costs, so it goes out on its
 * own slow timer and only when the drawing actually changed.
 */

import {
  CreateStartUpPageContainer,
  EventSourceType,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

import type { GlassesScreen, SplitglassSettings, TransportKind } from './types'
import type { WorkoutView } from './workout'
import { buildScreen, flashScreen, nextScreen, type ScreenSpec, type TextBox } from './screens'
import { renderMap, type MapRender, type Track } from './map'

export const MenuAction = {
  Lap: 1,
  NextScreen: 2,
  RestartPlan: 3,
  Units: 4,
  Close: 5,
} as const
export type MenuActionId = typeof MenuAction[keyof typeof MenuAction]

const MENU_LABELS: Record<MenuActionId, string> = {
  [MenuAction.Lap]: 'Lap',
  [MenuAction.NextScreen]: 'Next screen',
  [MenuAction.RestartPlan]: 'Restart plan',
  [MenuAction.Units]: 'Miles / km',
  [MenuAction.Close]: 'Close',
}

/**
 * Which byte layout the host wants for image data. Gray8 (one byte per pixel)
 * is the safe default — the SDK's own error codes mention a host-side
 * "to gray4" conversion step, so the host is happy to do the packing. Packed
 * Gray4 halves the bytes on the wire, which on a 10–30 KB/s link is the
 * difference between a 0.6s and a 1.2s map redraw; set
 * `globalThis.__SG = { mapFormat: 'gray4' }` to try it on real hardware.
 */
type MapFormat = 'gray8' | 'gray4'
function mapFormat(): MapFormat {
  const o = (globalThis as any).__SG
  return o?.mapFormat === 'gray4' ? 'gray4' : 'gray8'
}

// Gestures repeat on some hosts (notably the R1 ring), and a doubled screen
// change is very visible.
const GESTURE_DEBOUNCE_MS = 250

export type GlassesDeps = {
  log: (msg: string) => void
  getSettings: () => SplitglassSettings
  getView: () => WorkoutView
  getTransport: () => TransportKind
  getTrack: () => Track
  onLap: () => void
  onRestartPlan: () => void
  onToggleUnits: () => void
  onScreenChange?: (screen: GlassesScreen) => void
}

export function createGlasses(deps: GlassesDeps) {
  let bridge: EvenAppBridge | null = null
  let startupDone = false
  let registered = false
  let screen: GlassesScreen = 'run'
  let rendered: ScreenSpec | null = null
  let lastGesture = 0

  // The glasses' own battery, from getDeviceInfo and then pushed updates.
  let battery: number | null = null

  // A flash owns the display until this time; refresh() stays out of its way.
  let flashUntil = 0
  let flashTimer: number | null = null

  // Map state, kept out of the render path so a slow image never delays a number.
  let lastMap: MapRender | null = null
  let lastMapSignature = ''
  let lastMapSentAt = 0
  let imageInFlight = false

  const log = deps.log

  function menuObject(): MenuContainerProperty | undefined {
    if (typeof MenuContainerProperty !== 'function') return undefined
    const ids = [MenuAction.Lap, MenuAction.NextScreen, MenuAction.RestartPlan, MenuAction.Units, MenuAction.Close] as MenuActionId[]
    return new MenuContainerProperty({
      menuItems: ids.map(id => new MenuItemProperty({ itemID: id, itemName: MENU_LABELS[id] })),
    })
  }

  function mapInfo() {
    const settings = deps.getSettings()
    const track = deps.getTrack()
    const indoor = deps.getView().snapshot?.indoor === true
    const available = settings.mapEnabled && !indoor && track.points().length >= 2
    return {
      available,
      scaleMetres: available ? (lastMap?.scaleMetres ?? null) : null,
      offRouteMetres: track.offRouteMetres(),
      gpsMetres: track.points().length >= 2 ? track.gpsMetres() : null,
    }
  }

  function spec(): ScreenSpec {
    return buildScreen(screen, deps.getView(), deps.getTransport(), deps.getSettings(), mapInfo(), battery)
  }

  async function readBattery(b: EvenAppBridge): Promise<void> {
    try {
      const info = await b.getDeviceInfo()
      const level = info?.status?.batteryLevel
      if (typeof level === 'number') battery = level
    } catch { /* not every host reports it */ }
    try {
      b.onDeviceStatusChanged((status) => {
        if (typeof status?.batteryLevel === 'number') battery = status.batteryLevel
      })
    } catch { /* older SDK */ }
  }

  function toContainers(s: ScreenSpec) {
    const textObject = s.text.map(t => new TextContainerProperty({
      containerID: t.id,
      containerName: t.name,
      content: t.content,
      xPosition: t.x,
      yPosition: t.y,
      width: t.w,
      height: t.h,
      borderWidth: 0,
      paddingLength: 0,
      textColor: t.level,
      isEventCapture: t.capture ? 1 : 0,
    }))

    const listObject = s.lists.map(l => new ListContainerProperty({
      containerID: l.id,
      containerName: l.name,
      xPosition: l.x,
      yPosition: l.y,
      width: l.w,
      height: l.h,
      itemContainer: new ListItemContainerProperty({
        itemCount: l.items.length,
        itemWidth: l.w - 12,
        isItemSelectBorderEn: 1,
        itemName: l.items,
      }),
      isEventCapture: l.capture ? 1 : 0,
    }))

    const imageObject = s.images.map(i => new ImageContainerProperty({
      containerID: i.id,
      containerName: i.name,
      xPosition: i.x,
      yPosition: i.y,
      width: i.w,
      height: i.h,
    }))

    return { textObject, listObject, imageObject }
  }

  /** Full page build — needed whenever the container set changes. */
  async function renderScreen(): Promise<void> {
    if (!bridge) return
    if (Date.now() < flashUntil) return
    const s = spec()
    const { textObject, listObject, imageObject } = toContainers(s)

    const config = {
      containerTotalNum: textObject.length + listObject.length + imageObject.length,
      textObject,
      ...(listObject.length ? { listObject } : {}),
      ...(imageObject.length ? { imageObject } : {}),
      menuObject: menuObject(),
    }

    try {
      if (!startupDone) {
        const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
        log(`createStartUpPageContainer(${screen}) → ${r}`)
        startupDone = true
      } else {
        await bridge.rebuildPageContainer(new RebuildPageContainer(config))
      }
      rendered = s
      // Image data cannot ride along with the page that declares the container,
      // so the map is pushed after the page settles.
      if (imageObject.length > 0) {
        lastMapSignature = ''
        window.setTimeout(() => void pushMap(true), 150)
      }
    } catch (err) {
      log(`renderScreen(${screen}) failed: ${err}`)
    }
  }

  /**
   * Show a few lines at full brightness for `ms`, then put the screen back. A
   * second flash while one is up replaces it. Used for step changes, the end of
   * the plan, and zone drift — the events a HUD with no haptics has to make
   * visible.
   */
  async function flash(lines: string[], ms = 3000): Promise<void> {
    if (!bridge || !startupDone) return
    if (flashTimer !== null) window.clearTimeout(flashTimer)
    flashUntil = Date.now() + ms
    const s = flashScreen(lines)
    const { textObject } = toContainers(s)
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: textObject.length,
        textObject,
        menuObject: menuObject(),
      }))
      rendered = null // force a full rebuild when the flash ends
      log(`flash: ${lines.join(' / ')}`)
    } catch (err) {
      log(`flash failed: ${err}`)
      flashUntil = 0
    }
    flashTimer = window.setTimeout(() => {
      flashTimer = null
      flashUntil = 0
      void renderScreen()
    }, ms)
  }

  /** Cheap path: same screen, so only the text that moved goes out. */
  async function refresh(): Promise<void> {
    if (!bridge) return
    if (Date.now() < flashUntil) return
    if (!rendered || rendered.screen !== screen) { await renderScreen(); return }

    const s = spec()
    // A list cannot be updated in place, and the split and zone lists genuinely
    // grow, so those screens rebuild when their items change.
    if (s.lists.length > 0) {
      const before = rendered.lists.map(l => l.items.join('')).join('')
      const after = s.lists.map(l => l.items.join('')).join('')
      if (before !== after) { await renderScreen(); return }
    }
    if (s.images.length !== rendered.images.length) { await renderScreen(); return }

    const previous = new Map(rendered.text.map(t => [t.id, t]))
    try {
      for (const box of s.text) {
        const before = previous.get(box.id)
        if (before && before.content === box.content && before.level === box.level) continue
        await upgrade(box)
      }
      rendered = s
    } catch (err) {
      log(`refresh failed: ${err}`)
    }

    if (s.images.length > 0) void pushMap(false)
  }

  async function upgrade(box: TextBox): Promise<void> {
    if (!bridge) return
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: box.id,
      containerName: box.name,
      contentOffset: 0,
      contentLength: box.content.length,
      content: box.content,
      textColor: box.level,
    }))
  }

  /**
   * Redraw and send the map, at most once every `mapIntervalSec` and only when
   * the picture actually changed. `updateImageRawData` forbids concurrent sends,
   * so a send in flight is skipped rather than queued — the next tick will catch
   * up, and a stale breadcrumb by a couple of seconds is harmless.
   */
  async function pushMap(force: boolean): Promise<void> {
    if (!bridge || imageInFlight) return
    const settings = deps.getSettings()
    const box = rendered?.images[0] ?? spec().images[0]
    if (!box) return

    const now = Date.now()
    if (!force && now - lastMapSentAt < settings.mapIntervalSec * 1000) return

    const drawn = renderMap(deps.getTrack(), { width: box.w, height: box.h })
    if (!drawn) return
    lastMap = drawn
    if (!force && drawn.signature === lastMapSignature) { lastMapSentAt = now; return }

    imageInFlight = true
    try {
      const bytes = mapFormat() === 'gray4' ? drawn.gray4 : drawn.gray8
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: box.id,
        containerName: box.name,
        imageData: bytes,
      }))
      lastMapSignature = drawn.signature
      lastMapSentAt = Date.now()
      log(`map ${box.w}×${box.h} ${mapFormat()} ${bytes.length}B → ${result}`)
    } catch (err) {
      log(`map send failed: ${err}`)
    } finally {
      imageInFlight = false
    }
  }

  // ── Gestures ──

  function debounced(): boolean {
    const now = Date.now()
    if (now - lastGesture < GESTURE_DEBOUNCE_MS) return true
    lastGesture = now
    return false
  }

  async function goToScreen(next: GlassesScreen): Promise<void> {
    if (next === screen) return
    screen = next
    deps.onScreenChange?.(screen)
    log(`Screen: ${screen}`)
    await renderScreen()
  }

  async function step(delta: number): Promise<void> {
    await goToScreen(nextScreen(screen, delta, deps.getSettings().mapEnabled))
  }

  function menuActionFrom(event: any): MenuActionId | null {
    const raw = event?.menuItemClickEvent?.itemID ?? event?.menuItemClickEvent?.Item_ID
    const id = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
    if (typeof id !== 'number' || !Number.isFinite(id) || id === 0) return null
    return (Object.values(MenuAction) as number[]).includes(id) ? (id as MenuActionId) : null
  }

  async function onMenu(action: MenuActionId): Promise<void> {
    switch (action) {
      case MenuAction.Lap:
        deps.onLap()
        log('Lap')
        await refresh()
        return
      case MenuAction.NextScreen:
        await step(1)
        return
      case MenuAction.RestartPlan:
        deps.onRestartPlan()
        log('Plan restarted')
        await renderScreen()
        return
      case MenuAction.Units:
        deps.onToggleUnits()
        log(`Units: ${deps.getSettings().units}`)
        await renderScreen()
        return
      case MenuAction.Close:
        try { await bridge?.shutDownPageContainer(1) } catch (err) { log(`shutDown failed: ${err}`) }
        return
    }
  }

  function register(b: EvenAppBridge): void {
    if (registered) return
    b.onEvenHubEvent(async (event: any) => {
      const menu = menuActionFrom(event)
      if (menu !== null) { await onMenu(menu); return }

      const rawType = event?.listEvent?.eventType ?? event?.textEvent?.eventType ?? event?.sysEvent?.eventType
      const type = typeof rawType === 'number' ? rawType : undefined
      const source: number | undefined = event?.sysEvent?.eventSource

      if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) { void renderScreen(); return }
      if (type === undefined) return

      if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        try { await b.shutDownPageContainer(1) } catch { /* dialog declined */ }
        return
      }

      if (type === OsEventTypeList.CLICK_EVENT) {
        if (debounced()) return
        // The left temple steps back through screens and the right steps
        // forward; the ring, and any host that does not report a source, just
        // advances.
        const back = deps.getSettings().templeNav && source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L
        await step(back ? -1 : 1)
        return
      }

      // Swipes move between screens too, except on the list screens where the
      // firmware is already using them to scroll.
      if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (rendered && rendered.lists.length > 0) return
        if (debounced()) return
        await step(type === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1)
      }
    })
    registered = true
  }

  return {
    async connect(timeoutMs = 6000): Promise<boolean> {
      try {
        bridge = await Promise.race([
          waitForEvenAppBridge(),
          new Promise<null>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]) as EvenAppBridge
        register(bridge)
        screen = deps.getSettings().homeScreen
        await readBattery(bridge)
        await renderScreen()
        log('Connected to glasses')
        return true
      } catch {
        bridge = null
        log('No glasses bridge — companion only')
        return false
      }
    },

    bridge: () => bridge,
    screen: () => screen,
    battery: () => battery,
    goToScreen,
    refresh,
    renderScreen,
    flash,
    /** Force the next map redraw regardless of the interval — after a route load. */
    invalidateMap() { lastMapSignature = ''; lastMapSentAt = 0 },
    lastMap: () => lastMap,
  }
}
