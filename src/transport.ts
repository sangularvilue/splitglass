/**
 * Getting snapshots from the wrist to the glasses.
 *
 * Three routes, tried in this order:
 *
 *  1. **Local** — `http://127.0.0.1:8734`, served by the iPhone app itself.
 *     Nothing leaves the phone, latency is a few milliseconds, and it works in a
 *     basement with no signal at all. Whether the Even WebView is allowed to
 *     reach it depends on the origin the plugin is served from: a page loaded
 *     over https cannot open a plain-http connection, so this route is probed
 *     rather than assumed, and simply loses the race when it is blocked.
 *  2. **Stream** — server-sent events from the relay. One long-lived connection,
 *     pushed as the watch produces readings.
 *  3. **Poll** — the same relay once a second, for a host without EventSource
 *     or a connection that keeps dropping.
 *
 * The pair code scopes everything: the iPhone posts under it and the plugin
 * reads under it, so a shared relay never crosses two people's runs.
 */

import type { Snapshot, TransportKind } from './types'
import { parseSnapshot } from './wire'

const LOCAL_ORIGIN = 'http://127.0.0.1:8734'
const POLL_MS = 1000
const LOCAL_PROBE_MS = 900
const STREAM_STALL_MS = 12_000

/**
 * A packaged .ehpk has no backend of its own, so API calls need an absolute
 * origin; served from the deployment they can stay relative. Computed on demand
 * rather than at module scope, so this file can be imported outside a browser.
 */
export function serverOrigin(): string {
  const packaged = window.location.protocol === 'file:' || !window.location.host.includes('grannis')
  return packaged ? 'https://splitglass.grannis.xyz' : ''
}

export type Transport = ReturnType<typeof createTransport>

export function createTransport(opts: {
  getPairCode: () => string
  preferLocal: () => boolean
  onSnapshot: (snap: Snapshot) => void
  onStatus: (kind: TransportKind, detail: string) => void
  log?: (msg: string) => void
}) {
  let stopped = true
  let pollTimer: number | null = null
  let source: EventSource | null = null
  let stallTimer: number | null = null
  let kind: TransportKind = 'none'
  let lastSeq = -1
  let lastWorkoutId = ''

  const log = (m: string) => opts.log?.(m)

  function deliver(raw: unknown): void {
    const snap = parseSnapshot(raw)
    if (!snap) return
    // Drop replays: the relay hands out the latest value, and a poll will see
    // the same reading several times over.
    if (snap.workoutId === lastWorkoutId && snap.seq <= lastSeq) return
    lastWorkoutId = snap.workoutId
    lastSeq = snap.seq
    opts.onSnapshot(snap)
  }

  function setKind(next: TransportKind, detail: string): void {
    kind = next
    opts.onStatus(next, detail)
  }

  // ── Local ──

  async function probeLocal(): Promise<boolean> {
    if (!opts.preferLocal()) return false
    try {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), LOCAL_PROBE_MS)
      const res = await fetch(`${LOCAL_ORIGIN}/health`, { signal: controller.signal, cache: 'no-store' })
      window.clearTimeout(timer)
      if (!res.ok) return false
      log('Local relay on the phone answered — staying off the network')
      return true
    } catch {
      // Blocked by the page's origin, or the phone app is not running. Either
      // way the relay is next; this is not worth reporting as an error.
      return false
    }
  }

  // ── Poll ──

  function startPolling(origin: string, as: TransportKind): void {
    stopPolling()
    const url = origin === LOCAL_ORIGIN
      ? `${LOCAL_ORIGIN}/state`
      : `${serverOrigin()}/api/state?code=${encodeURIComponent(opts.getPairCode())}`

    const tick = async () => {
      if (stopped) return
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const body = await res.json()
          if (body && body.snapshot) deliver(body.snapshot)
          else if (body && body.v === 1) deliver(body)
          if (kind !== as) setKind(as, as === 'local' ? 'phone, on-device' : 'relay, polling')
        }
      } catch (err) {
        setKind('none', `unreachable (${String(err).slice(0, 40)})`)
      }
    }

    void tick()
    pollTimer = window.setInterval(tick, POLL_MS)
  }

  function stopPolling(): void {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
  }

  // ── Stream ──

  function armStall(): void {
    if (stallTimer !== null) window.clearTimeout(stallTimer)
    stallTimer = window.setTimeout(() => {
      log('Stream went quiet — falling back to polling')
      closeStream()
      startPolling(serverOrigin(), 'poll')
    }, STREAM_STALL_MS)
  }

  function closeStream(): void {
    if (stallTimer !== null) { window.clearTimeout(stallTimer); stallTimer = null }
    if (source) { source.close(); source = null }
  }

  function startStream(): void {
    if (typeof EventSource === 'undefined') { startPolling(serverOrigin(), 'poll'); return }
    closeStream()
    const url = `${serverOrigin()}/api/stream?code=${encodeURIComponent(opts.getPairCode())}`
    try {
      source = new EventSource(url)
    } catch {
      startPolling(serverOrigin(), 'poll')
      return
    }
    source.onopen = () => { setKind('stream', 'relay, streaming'); armStall() }
    source.onmessage = (ev) => {
      armStall()
      try { deliver(JSON.parse(ev.data)) } catch { /* keep-alive comment or partial frame */ }
    }
    source.onerror = () => {
      // EventSource retries on its own; the stall timer decides when to give up
      // and start polling instead, so a flaky tunnel does not blank the HUD.
      setKind('none', 'reconnecting')
    }
    armStall()
  }

  return {
    async start(): Promise<void> {
      stopped = false
      lastSeq = -1
      lastWorkoutId = ''
      if (await probeLocal()) { startPolling(LOCAL_ORIGIN, 'local'); return }
      startStream()
    },

    stop(): void {
      stopped = true
      stopPolling()
      closeStream()
      setKind('none', 'stopped')
    },

    /** Re-probe from scratch — used when the pair code or the local preference changes. */
    async restart(): Promise<void> {
      this.stop()
      await this.start()
    },

    kind: () => kind,
  }
}

