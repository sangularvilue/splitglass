import { redis, snapshotKey, normalizeCode, sanitizeSnapshot, cors, SNAPSHOT_TTL } from './_relay.js'

/**
 * The iPhone posts one reading a second here while a workout is mirrored from
 * the watch. Last write wins: there is no history to keep, because the glasses
 * only ever show now.
 */
export default async function handler(req, res) {
  cors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const code = normalizeCode(body?.code ?? req.query?.code)
  if (!code) return res.status(400).json({ error: 'bad or missing pair code' })

  const snapshot = sanitizeSnapshot(body?.snapshot ?? body)
  if (!snapshot) return res.status(400).json({ error: 'bad snapshot' })

  try {
    await redis.set(snapshotKey(code), JSON.stringify(snapshot), { ex: SNAPSHOT_TTL })
  } catch (err) {
    return res.status(502).json({ error: 'relay unavailable', detail: String(err).slice(0, 120) })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ ok: true, seq: snapshot.seq })
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return null }
}
