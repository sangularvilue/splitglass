import { redis, cors } from './_relay.js'

export default async function handler(req, res) {
  cors(res)
  res.setHeader('Cache-Control', 'no-store')
  let relay = 'down'
  try {
    await redis.ping()
    relay = 'up'
  } catch { /* reported as down */ }
  return res.status(200).json({ ok: relay === 'up', relay })
}
