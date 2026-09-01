import { redis, snapshotKey, normalizeCode, cors } from './_relay.js'

/** The polling route: whatever the phone last posted under this pair code. */
export default async function handler(req, res) {
  cors(res)
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const code = normalizeCode(req.query?.code)
  if (!code) return res.status(400).json({ error: 'bad or missing pair code' })

  try {
    const raw = await redis.get(snapshotKey(code))
    if (!raw) return res.status(200).json({ snapshot: null })
    return res.status(200).json({ snapshot: typeof raw === 'string' ? JSON.parse(raw) : raw })
  } catch (err) {
    return res.status(502).json({ error: 'relay unavailable', detail: String(err).slice(0, 120) })
  }
}
