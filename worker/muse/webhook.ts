import { constantEqual, hmac } from '../../shared/xgift-signature.ts'
import { boundedResponseText } from '../bounded-response.ts'
import { hash, json, type Env } from '../platform.ts'

/** Notifications only wake the durable queue. Signed GET remains authoritative. */
export async function museWebhook(request: Request, env: Env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!env.MUSE_WEBHOOK_SECRET || env.MUSE_WEBHOOK_SECRET.length < 32) return json({ error: 'Webhook unavailable' }, 503)
  const id = request.headers.get('X-Event-Id') ?? '', timestamp = request.headers.get('X-Timestamp') ?? '', sig = request.headers.get('X-Signature') ?? ''
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(sig)) return json({ error: 'Invalid notification' }, 400)
  let raw: string
  try { raw = await boundedResponseText(new Response(request.body), 64000) } catch { return json({ error: 'Invalid notification' }, 400) }
  if (!constantEqual(sig, await hmac(env.MUSE_WEBHOOK_SECRET, timestamp + '.' + id + '.' + raw))) return json({ error: 'Invalid notification' }, 401)
  let event: { id: string; type: string; data: { id: string; merchant_order_no: string; status: string } }
  try { event = JSON.parse(raw) } catch { return json({ error: 'Invalid notification' }, 400) }
  if (!event || event.id !== id || !['order.running','order.unknown','order.succeeded','order.failed'].includes(event.type) || !event.data || event.type !== 'order.' + event.data.status || !/^YMX-[A-F0-9]{32}$/.test(event.data.merchant_order_no) || !/^ord_[A-Za-z0-9_-]{1,120}$/.test(event.data.id)) return json({ error: 'Invalid notification' }, 400)
  const digest = await hash(raw), db = env.INTEREST_DB
  const previous = await db.prepare('SELECT body_hash FROM muse_events WHERE id=?').bind(id).first<{ body_hash: string }>()
  if (previous) return previous.body_hash === digest ? json({ ok: true }) : json({ error: 'Notification conflict' }, 409)
  const token = crypto.randomUUID()
  await db.batch([
    db.prepare(`INSERT INTO muse_events(id,order_id,body_hash,wake_token,received_at) SELECT ?,order_id,?,?,? FROM muse_orders WHERE order_id=? AND (remote_id IS NULL OR remote_id=?) ON CONFLICT DO NOTHING`)
      .bind(id, digest, token, Date.now(), event.data.merchant_order_no, event.data.id),
    db.prepare("UPDATE muse_orders SET next_attempt_at=0 WHERE order_id=? AND state NOT IN ('succeeded','failed') AND EXISTS(SELECT 1 FROM muse_events e WHERE e.id=? AND e.wake_token=?)").bind(event.data.merchant_order_no, id, token),
  ])
  const stored = await db.prepare('SELECT body_hash FROM muse_events WHERE id=?').bind(id).first<{ body_hash: string }>()
  if (stored && stored.body_hash !== digest) return json({ error: 'Notification conflict' }, 409)
  // Foreign/legacy orders may share the channel webhook; acknowledge and ignore.
  return json({ ok: true })
}
