import { redis, snapshotKey, normalizeCode } from './_relay.js'

export const config = { maxDuration: 60 }

const POLL_MS = 1000
// A serverless function cannot be held open for the length of a run, so each
// connection lives about a minute and EventSource reconnects on its own. The
// retry hint keeps that gap short.
const LIFETIME_MS = 55_000

/**
 * Server-sent events, so the glasses get one long-lived connection instead of a
 * request a second. Readings are pushed only when the sequence number moves, so
 * a paused workout costs almost nothing.
 */
export default async function handler(req, res) {
  const code = normalizeCode(req.query?.code)
  if (!code) {
    res.status(400).json({ error: 'bad or missing pair code' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('X-Accel-Buffering', 'no')
  res.write('retry: 1500\n\n')

  const key = snapshotKey(code)
  const started = Date.now()
  let lastSeq = -1
  let lastWorkout = ''
  let closed = false

  req.on('close', () => { closed = true })

  while (!closed && Date.now() - started < LIFETIME_MS) {
    try {
      const raw = await redis.get(key)
      if (raw) {
        const snap = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (snap.workoutId !== lastWorkout || snap.seq > lastSeq) {
          lastWorkout = snap.workoutId
          lastSeq = snap.seq
          res.write(`data: ${JSON.stringify(snap)}\n\n`)
        } else {
          // A comment keeps the connection from being reaped by a proxy without
          // looking like a reading to the client.
          res.write(': keep-alive\n\n')
        }
      } else {
        res.write(': waiting\n\n')
      }
    } catch (err) {
      res.write(`: relay error ${String(err).slice(0, 80)}\n\n`)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }

  res.end()
}
