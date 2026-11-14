import { type Env, ApiError, json, hash } from './platform.ts'
import { boundedResponseText } from './bounded-response.ts'
import { emailPayload, mailBrand, sendFrozenEmail } from './email.ts'
import { adminLoginEmail } from './admin-auth.ts'
import { sendFeishuAppText } from './payout-notifications.ts'

/*
 * Operator push alerts for paid orders and new after-sales requests.
 * Discovery is opt-in with an explicit UTC cutoff (OPS_NOTIFICATIONS_SINCE), so
 * enabling it never replays history. Each channel gets its own durable row and
 * retries independently. Messages carry only order facts an operator needs:
 * never the customer's email, account data, delivery content or credentials.
 * Nothing here can change payment, fulfillment or refund state.
 */
export type Channel = 'feishu' | 'wecom' | 'serverchan' | 'email'
type Kind = 'paid' | 'refund_requested'
type Row = { id: string; channel: Channel; kind: Kind; order_id: string; source_id: string; event_created_at: number; attempt_count: number }
type Details = { plan_name: string; price_cents: number; partner_name: string | null; product_name: string | null; task_kind: string | null; muse: number; recharge: number; refund_cents: number | null }

const MAX_ATTEMPTS = 8
const LEASE_MS = 60_000
const feishuWebhook = /^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,128}$/
const wecomWebhook = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]{8,128}$/
const serverchanKey = /^(?:SCT|sctp)[A-Za-z0-9]{8,128}$/

function feishuRecipient(env: Env) {
  const value = env.FEISHU_ORDER_RECIPIENT ?? env.FEISHU_PAYOUT_RECIPIENT ?? env.FEISHU_STOCK_RECIPIENT ?? ''
  return /^(?:ou|oc)_[a-z0-9]+$/.test(value) ? value : ''
}
/** Channels with valid configuration. A malformed value disables only that channel. */
export function opsChannels(env: Env): Channel[] {
  const channels: Channel[] = []
  if (feishuWebhook.test(env.FEISHU_WEBHOOK_URL ?? '') || (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && feishuRecipient(env))) channels.push('feishu')
  if (wecomWebhook.test(env.WECOM_WEBHOOK_URL ?? '')) channels.push('wecom')
  if (serverchanKey.test(env.SERVERCHAN_SENDKEY ?? '')) channels.push('serverchan')
  if (env.OPS_NOTIFY_EMAIL === 'true' && env.RESEND_API_KEY && env.RESEND_FROM && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL?.trim() ?? '')) channels.push('email')
  return channels
}
function activation(env: Env) {
  const value = env.OPS_NOTIFICATIONS_SINCE ?? ''
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const money = (cents: number) => '¥' + (cents / 100).toFixed(2)
const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
function adminUrl(env: Env) { try { return mailBrand(env).origin + '/admin' } catch { return '' } }

function delivery(d: Details) {
  if (d.task_kind === 'manual' && !d.muse) return '⚠️ 需人工交付：请到后台「人工交付」处理'
  if (d.muse) return 'Muse 自动采购'
  if (d.task_kind === 'stock') return '自有库存自动交付'
  if (d.recharge) return '平台代充：等待客户提交资料'
  return '自动交付'
}
export function opsMessage(env: Env, kind: Kind | 'test', orderId: string, d: Details | null, at: number) {
  const product = d ? (d.product_name && d.product_name !== d.plan_name ? d.product_name + ' · ' + d.plan_name : d.plan_name) : ''
  const lines = kind === 'test'
    ? ['【推送测试】', '订单通知渠道配置成功。新订单付款和售后申请会推送到这里。']
    : kind === 'paid'
      ? ['【新订单已付款】', '商品：' + product, '金额：' + money(d!.price_cents), '交付：' + delivery(d!), '订单号：' + orderId, '来源：' + (d!.partner_name ? '代理 ' + d!.partner_name : '平台直营')]
      : ['【新售后申请】', '商品：' + product, '申请金额：' + money(d!.refund_cents ?? 0), '订单号：' + orderId, '请到后台「退款与售后」审核']
  lines.push('时间：' + time(at))
  const admin = adminUrl(env)
  if (admin) lines.push('后台：' + admin)
  const title = lines[0].replace(/[【】]/g, '') + (kind === 'paid' && d?.task_kind === 'manual' && !d.muse ? '（需人工交付）' : '')
  return { title, text: lines.join('\n') }
}

async function post(url: string, init: RequestInit) {
  let response: Response
  try { response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), ...init }) }
  catch { throw new Error('unreachable') }
  const data = await boundedResponseText(response, 32000).then(t => JSON.parse(t) as Record<string, unknown>).catch(() => null)
  return { ok: response.ok, data }
}
async function hmacBase64(key: string, message: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)))
  return btoa(String.fromCharCode(...sig))
}
/** Deliver one message. Throws a fixed reason; never includes URLs, keys or bodies. */
export async function deliver(env: Env, channel: Channel, message: { title: string; text: string }, key: string) {
  if (channel === 'feishu') {
    const url = env.FEISHU_WEBHOOK_URL ?? ''
    if (feishuWebhook.test(url)) {
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: message.text } }
      if (env.FEISHU_WEBHOOK_SECRET) {
        // Feishu custom bot signing: HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message.
        const timestamp = String(Math.floor(Date.now() / 1000))
        body.timestamp = timestamp
        body.sign = await hmacBase64(timestamp + '\n' + env.FEISHU_WEBHOOK_SECRET, '')
      }
      const r = await post(url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok || !r.data || (r.data.code !== 0 && r.data.StatusCode !== 0)) throw new Error('feishu rejected')
      return
    }
    await sendFeishuAppText(env, feishuRecipient(env), message.text, 'ymx-ops-' + (await hash(key)).slice(0, 40))
    return
  }
  if (channel === 'wecom') {
    const url = env.WECOM_WEBHOOK_URL ?? ''
    if (!wecomWebhook.test(url)) throw new Error('wecom unconfigured')
    const r = await post(url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: message.text } }) })
    if (!r.ok || r.data?.errcode !== 0) throw new Error('wecom rejected')
    return
  }
  if (channel === 'serverchan') {
    const sendkey = env.SERVERCHAN_SENDKEY ?? ''
    if (!serverchanKey.test(sendkey)) throw new Error('serverchan unconfigured')
    const uid = /^sctp(\d+)t/.exec(sendkey)?.[1]
    const url = uid ? `https://${uid}.push.ft07.com/send/${sendkey}.send` : `https://sctapi.ftqq.com/${sendkey}.send`
    const r = await post(url, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title: message.title, desp: message.text.replaceAll('\n', '\n\n') }).toString() })
    if (!r.ok || r.data?.code !== 0) throw new Error('serverchan rejected')
    return
  }
  const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const body = emailPayload(env, adminLoginEmail(env), { subject: message.title, text: message.text, html: '<pre style="font:14px/1.6 sans-serif;white-space:pre-wrap">' + escape(message.text) + '</pre>' })
  await sendFrozenEmail(env, body, 'ops/' + (await hash(key)).slice(0, 48))
}

async function discover(env: Env, channels: Channel[], since: number, now: number) {
  const list = JSON.stringify(channels)
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`INSERT OR IGNORE INTO ops_notifications(id,channel,kind,order_id,source_id,event_created_at,next_attempt_at)
      SELECT 'paid/'||e.id||'/'||c.value,c.value,'paid',o.id,e.id,e.created_at,?
      FROM order_events e JOIN orders o ON o.id=e.order_id, json_each(?) c
      WHERE e.action='payment-confirmed' AND e.created_at>=? AND e.created_at<=? AND o.mode='live' AND o.is_test=0
        AND NOT EXISTS(SELECT 1 FROM ops_notifications n WHERE n.id='paid/'||e.id||'/'||c.value)
      ORDER BY e.created_at,e.id LIMIT 200`).bind(now, list, since, now),
    env.INTEREST_DB.prepare(`INSERT OR IGNORE INTO ops_notifications(id,channel,kind,order_id,source_id,event_created_at,next_attempt_at)
      SELECT 'refund/'||r.id||'/'||c.value,c.value,'refund_requested',o.id,r.id,r.created_at,?
      FROM refund_cases r JOIN orders o ON o.id=r.order_id, json_each(?) c
      WHERE r.created_at>=? AND r.created_at<=? AND r.request_key NOT LIKE 'external-refund:%' AND o.mode='live' AND o.is_test=0
        AND NOT EXISTS(SELECT 1 FROM ops_notifications n WHERE n.id='refund/'||r.id||'/'||c.value)
      ORDER BY r.created_at,r.id LIMIT 200`).bind(now, list, since, now),
  ])
}
async function details(env: Env, row: Row) {
  return env.INTEREST_DB.prepare(`SELECT o.plan_name,o.price_cents,o.partner_name,t.product_name,t.kind task_kind,
      EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=o.id) muse,EXISTS(SELECT 1 FROM recharge_orders x WHERE x.order_id=o.id) recharge,
      (SELECT requested_cents FROM refund_cases WHERE id=? AND order_id=o.id) refund_cents
    FROM orders o LEFT JOIN fulfillment_tasks t ON t.order_id=o.id WHERE o.id=?`).bind(row.kind === 'refund_requested' ? row.source_id : '', row.order_id).first<Details>()
}

/** Cron entry: discover new events, then send due rows. Each row fails in isolation. */
export async function sendDueOpsNotifications(env: Env) {
  const since = activation(env), channels = opsChannels(env)
  if (since === null || !channels.length) return { configured: false, sent: 0, failed: 0 }
  const now = Date.now()
  // Only recent events: a channel added later must not replay older orders.
  await discover(env, channels, Math.max(since, now - 24 * 3600_000), now)
  const due = (await env.INTEREST_DB.prepare("SELECT id,channel,kind,order_id,source_id,event_created_at,attempt_count FROM ops_notifications WHERE status='pending' AND next_attempt_at<=? AND locked_until<=? ORDER BY next_attempt_at,id LIMIT 20").bind(now, now).all<Row>()).results
  let sent = 0, failed = 0
  for (const row of due) {
    if (Date.now() - now > 20_000) break // Leave the rest for the next minute.
    const token = crypto.randomUUID(), start = Date.now()
    await env.INTEREST_DB.prepare("UPDATE ops_notifications SET locked_until=?,lock_token=? WHERE id=? AND status='pending' AND locked_until<=?").bind(start + LEASE_MS, token, row.id, start).run()
    const claimed = await env.INTEREST_DB.prepare('SELECT lock_token FROM ops_notifications WHERE id=?').bind(row.id).first<{ lock_token: string }>()
    if (claimed?.lock_token !== token) continue
    try {
      // A channel removed from configuration retires its pending rows quietly.
      if (!channels.includes(row.channel)) throw new Error('channel disabled')
      const d = await details(env, row)
      if (!d) throw new Error('order missing')
      await deliver(env, row.channel, opsMessage(env, row.kind, row.order_id, d, row.event_created_at), row.id)
      await env.INTEREST_DB.prepare("UPDATE ops_notifications SET status='sent',sent_at=?,attempt_count=attempt_count+1,locked_until=0 WHERE id=? AND lock_token=?").bind(Date.now(), row.id, token).run()
      sent++
    } catch (error) {
      failed++
      const attempts = row.attempt_count + 1
      const reason = error instanceof Error && /^[a-z ]{1,40}$/.test(error.message) ? error.message : 'internal'
      const final = attempts >= MAX_ATTEMPTS || reason === 'channel disabled' || reason === 'order missing'
      await env.INTEREST_DB.prepare("UPDATE ops_notifications SET status=CASE WHEN ?=1 THEN 'failed' ELSE 'pending' END,attempt_count=?,next_attempt_at=?,last_error=?,locked_until=0 WHERE id=? AND lock_token=?")
        .bind(Number(final), attempts, Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1)), reason, row.id, token).run()
      console.warn(JSON.stringify({ event: 'ops-notification', channel: row.channel, outcome: 'failed', reason }))
    }
  }
  return { configured: true, sent, failed }
}

/** Admin-only: send one test message to every configured channel right now. */
export async function opsNotificationsAdmin(request: Request, env: Env) {
  if (request.method === 'GET') return json({ channels: opsChannels(env), active: activation(env) !== null })
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const channels = opsChannels(env)
  if (!channels.length) throw new ApiError('尚未配置任何推送渠道。', 409)
  const message = opsMessage(env, 'test', '', null, Date.now()), key = 'test/' + crypto.randomUUID()
  const results: Record<string, string> = {}
  for (const channel of channels) {
    try { await deliver(env, channel, message, key + '/' + channel); results[channel] = 'sent' }
    catch (error) { results[channel] = error instanceof Error && /^[a-z ]{1,40}$/.test(error.message) ? error.message : 'failed' }
  }
  return json({ results, active: activation(env) !== null })
}
