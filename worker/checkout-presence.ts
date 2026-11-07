import { ApiError, body, hash, json, owner, type Env } from './platform.ts'
import { resolvePartner } from './partners.ts'

export const CHECKOUT_PRESENCE_WINDOW_MS = 10 * 60_000
// A closed activity ID is never reused by the browser. Keep its tombstone beyond
// the fetch timeout so a heartbeat arriving after a leave cannot revive it.
const CLOSED_RETENTION_MS = 5 * 60_000
const activityId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

export async function checkoutPresence(request: Request, env: Env) {
  if (request.method !== 'GET' && request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const ownerHash = await owner(request)
  const url = new URL(request.url)
  const data = request.method === 'POST' ? await body(request, 512) : null
  const product = data ? data.product : url.searchParams.get('product')
  if (product !== 'chatgpt') throw new ApiError('商品无效。')
  if (data && (typeof data.tabId !== 'string' || !activityId.test(data.tabId) || typeof data.active !== 'boolean')) throw new ApiError('页面活动信息无效。')
  if (data && !(await env.INTEREST_LIMITER.limit({ key: 'checkout-presence:' + await hash(request.headers.get('CF-Connecting-IP') ?? ownerHash) })).success) throw new ApiError('更新过于频繁，请稍后重试。', 429)
  const partner = await resolvePartner(env, data ? data.partner : url.searchParams.get('partner'))
  const shopId = partner?.id ?? 'platform'
  const now = Date.now()
  if (data) {
    const tabId = (data.tabId as string).toLowerCase()
    if (data.active) {
      await env.INTEREST_DB.prepare(`INSERT INTO checkout_presence(shop_id,product_id,owner_hash,tab_id,last_seen_at) VALUES (?,?,?,?,?)
        ON CONFLICT(shop_id,product_id,owner_hash,tab_id) DO UPDATE SET last_seen_at=MAX(checkout_presence.last_seen_at,excluded.last_seen_at) WHERE checkout_presence.closed_at IS NULL`)
        .bind(shopId, product, ownerHash, tabId, now).run()
    } else {
      // Insert even when no heartbeat has arrived yet. Only this browser's
      // activity ID is closed; another tab or buyer remains independent.
      await env.INTEREST_DB.prepare(`INSERT INTO checkout_presence(shop_id,product_id,owner_hash,tab_id,last_seen_at,closed_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(shop_id,product_id,owner_hash,tab_id) DO UPDATE SET closed_at=COALESCE(checkout_presence.closed_at,excluded.closed_at)`)
        .bind(shopId, product, ownerHash, tabId, now, now).run()
    }
  }
  const result = await env.INTEREST_DB.prepare(`SELECT COUNT(DISTINCT owner_hash) others FROM checkout_presence
    WHERE shop_id=? AND product_id=? AND closed_at IS NULL AND last_seen_at>? AND owner_hash<>?`)
    .bind(shopId, product, now - CHECKOUT_PRESENCE_WINDOW_MS, ownerHash).first<{ others: number }>()
  // The aggregate must exist; a failed/unexpected database response is not zero.
  if (!result || !Number.isSafeInteger(result.others) || result.others < 0) throw new ApiError('下单活动统计暂不可用。', 503)
  return json({ others: result.others, windowSeconds: CHECKOUT_PRESENCE_WINDOW_MS / 1000 })
}

export async function expireCheckoutPresence(env: Env, now = Date.now()) {
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare('DELETE FROM checkout_presence WHERE closed_at IS NULL AND last_seen_at<=?').bind(now - CHECKOUT_PRESENCE_WINDOW_MS),
    env.INTEREST_DB.prepare('DELETE FROM checkout_presence WHERE closed_at<=?').bind(now - CLOSED_RETENTION_MS),
  ])
}
