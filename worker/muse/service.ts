import { ApiError, type Env } from '../platform.ts'
import { seal } from '../fulfillment/vault.ts'
import { museBalance, museConfigured, MuseError, museProducts, museRequest } from './client.ts'

export type MuseMapping = { product_code: string; max_cost_cents: number }
type Purchase = { order_id: string; key_id: string; product_code: string; expected_cost_cents: number; raw_body: string; idempotency_key: string; remote_id: string | null; state: string; attempted: number; lease_token: string | null; lease_until: number; next_attempt_at: number; failure_count: number }
const eligible = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0"
export const museCheckoutEnabled = (env: Env) => museConfigured(env) && env.MUSE_CHECKOUT_ENABLED === 'true' && env.MUSE_ACCOUNT_PAYMENT_APPROVED === 'true'
export const museMapping = (env: Env, plan: string) => env.INTEREST_DB.prepare('SELECT product_code,max_cost_cents FROM muse_plans WHERE plan=?').bind(plan).first<MuseMapping>()
export const musePurchase = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM muse_orders WHERE order_id=?').bind(id).first<Purchase>()

// No wallet freeze or purchase here. Price is pinned before the buyer pays.
export async function prepareMuse(env: Env, mapping: MuseMapping, sale: number) {
  if (!museCheckoutEnabled(env)) throw new ApiError('Muse 自动交付暂未开放。', 409)
  const products = await museProducts(env), product = products.find(p => p.code === mapping.product_code)
  if (!product?.enabled || !product.available) throw new ApiError('Muse 供货暂不可用，请稍后再试。', 409)
  if (product.supply_minor > mapping.max_cost_cents || product.supply_minor >= sale) throw new ApiError('Muse 供货价格已变化，请联系商家核对。', 409)
  const balance = await museBalance(env)
  if (balance.available_minor < product.supply_minor) throw new ApiError('Muse 暂时无法供货，请联系商家。', 409)
  const check = await museRequest<{ ready: boolean; fulfillment_type: string; quantity: number }>(env, '/preflight', JSON.stringify({ product_code: product.code }))
  if (check?.ready !== true || check.fulfillment_type !== 'account_delivery' || check.quantity !== 1) throw new ApiError('Muse 暂未通过供货检查。', 409)
  return product.supply_minor
}
export function museSnapshot(env: Env, id: string, mapping: MuseMapping, cost: number) {
  const raw = JSON.stringify({ merchant_order_no: id, product_code: mapping.product_code, expected_supply_minor: cost })
  return env.INTEREST_DB.prepare(`INSERT INTO muse_orders(order_id,key_id,product_code,expected_cost_cents,raw_body,idempotency_key,updated_at)
    SELECT id,?,?,?,?,?,? FROM orders WHERE id=?`)
    .bind(env.MUSE_KEY_ID!, mapping.product_code, cost, raw, 'muse:' + id, Date.now(), id)
}
export async function musePaymentReady(env: Env, id: string) {
  const p = await musePurchase(env, id)
  if (!p) return
  if (!museCheckoutEnabled(env) || p.key_id !== env.MUSE_KEY_ID) throw new ApiError('Muse 收款暂未开放，请联系商家。', 409)
  const product = (await museProducts(env)).find(row => row.code === p.product_code)
  if (!product?.enabled || !product.available || product.supply_minor !== p.expected_cost_cents || (await museBalance(env)).available_minor < p.expected_cost_cents) throw new ApiError('Muse 供货已变化，当前不能付款，请联系商家或重新确认商品。', 409)
}
type Remote = { id: string; merchant_order_no: string; product_code: string; supply_minor: number; status: string; fulfillment_type?: string }
function validate(remote: Remote, p: Purchase) {
  if (!remote || !/^ord_[A-Za-z0-9_-]{1,120}$/.test(remote.id) || (p.remote_id && remote.id !== p.remote_id)
    || remote.merchant_order_no !== p.order_id || remote.product_code !== p.product_code
    || remote.supply_minor !== p.expected_cost_cents || (remote.fulfillment_type !== undefined && remote.fulfillment_type !== 'account_delivery')
    || !['queued', 'running', 'unknown', 'succeeded', 'failed'].includes(remote.status)) throw new MuseError('order_mismatch')
  return remote
}
const rejections = new Set(['price_changed', 'out_of_stock', 'insufficient_balance', 'product_disabled', 'execution_paused'])
async function failed(env: Env, id: string, lease: string, code: string) {
  const db = env.INTEREST_DB, now = Date.now(), event = crypto.randomUUID()
  await db.batch([
    db.prepare("UPDATE muse_orders SET state='failed',failure_code=?,updated_at=? WHERE order_id=? AND lease_token=? AND state<>'succeeded'").bind(code, now, id, lease),
    db.prepare("UPDATE fulfillment_tasks SET state='review',updated_at=? WHERE order_id=? AND state<>'delivered' AND EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=fulfillment_tasks.order_id AND m.state='failed' AND m.lease_token=?)").bind(now, id, lease),
    db.prepare(`UPDATE orders SET status='failed',version=version+1,updated_at=?,last_event_id=? WHERE id=? AND ${eligible} AND EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=orders.id AND m.state='failed' AND m.lease_token=?)`).bind(now, event, id, lease),
    db.prepare("INSERT INTO order_events(id,order_id,actor,action,to_status,note,order_version,created_at) SELECT ?,id,'system','muse-failed',status,'供货已明确失败，未重复采购；请从原订单申请售后',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, now, id, event),
  ])
}

/** One durable purchase per paid local order. Unknown results retain refund hold. */
export async function fulfillMuse(env: Env, id: string) {
  let p = await musePurchase(env, id)
  if (!p || ['succeeded', 'failed'].includes(p.state) || p.next_attempt_at > Date.now() || p.lease_until > Date.now()) return
  // The original key participates in idempotency. Rotation must never silently
  // submit an old request under a new key. Restore it or reconcile with support.
  if (!museConfigured(env) || p.key_id !== env.MUSE_KEY_ID) return
  const now = Date.now(), lease = crypto.randomUUID(), db = env.INTEREST_DB
  await db.prepare(`UPDATE muse_orders SET lease_token=?,lease_until=? WHERE order_id=? AND lease_until<=? AND next_attempt_at<=?
    AND state NOT IN ('succeeded','failed') AND EXISTS(SELECT 1 FROM orders WHERE id=order_id AND ${eligible})
    AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=muse_orders.order_id AND t.state IN ('reserved','queued','running'))`)
    .bind(lease, now + 90000, id, now, now).run()
  p = (await musePurchase(env, id))!
  if (p.lease_token !== lease) return
  let delay = 20000
  try {
    if (!p.attempted && !museCheckoutEnabled(env)) return // New dispatch kill switch; recovery continues.
    let remote: Remote | null = null
    if (p.attempted || p.remote_id) {
      try { remote = validate(await museRequest<Remote>(env, p.remote_id ? '/orders/' + p.remote_id : '/orders/by-merchant/' + id), p) }
      catch (error) {
        if (!(error instanceof MuseError && error.status === 404 && error.code === 'order_missing' && !p.remote_id)) throw error
        // A missing order is not permission for a NEW purchase. Recover only the
        // saved body, key and idempotency key, exactly as the native docs require.
      }
    }
    if (!remote) {
      // Persist attempted BEFORE the network request; a crash must query first.
      await db.batch([
        db.prepare("UPDATE muse_orders SET attempted=1,state='creating',updated_at=? WHERE order_id=? AND lease_token=?").bind(now, id, lease),
        db.prepare(`UPDATE orders SET status='processing',started_at=COALESCE(started_at,?),version=version+1,updated_at=? WHERE id=? AND status='session' AND ${eligible}`).bind(now, now, id),
        db.prepare("UPDATE fulfillment_tasks SET state='running',updated_at=? WHERE order_id=? AND state IN ('reserved','queued')").bind(now, id),
      ])
      try { remote = validate(await museRequest<Remote>(env, '/orders', p.raw_body, p.idempotency_key), p) }
      catch (error) {
        if (!p.attempted && error instanceof MuseError && error.status === 409 && rejections.has(error.code)) { await failed(env, id, lease, error.code); return }
        throw error
      }
    }
    await db.prepare("UPDATE muse_orders SET remote_id=?,state=?,actual_cost_cents=?,failure_count=0,updated_at=? WHERE order_id=? AND lease_token=?")
      .bind(remote.id, remote.status === 'unknown' ? 'unknown' : 'pending', remote.supply_minor, Date.now(), id, lease).run()
    if (remote.status === 'failed') { await failed(env, id, lease, 'supplier_failed'); return }
    if (remote.status !== 'succeeded') return
    const delivery = await museRequest<{ order_id: string; product_code: string; fulfillment_type: string; quantity: number; content: string }>(env, '/orders/' + remote.id + '/delivery')
    if (!delivery || delivery.order_id !== remote.id || delivery.product_code !== p.product_code || delivery.fulfillment_type !== 'account_delivery' || delivery.quantity !== 1 || typeof delivery.content !== 'string' || !delivery.content.trim() || delivery.content.length > 8192) throw new MuseError('delivery_mismatch')
    const encrypted = await seal(env, delivery.content, 'task:' + id), event = crypto.randomUUID(), done = Date.now()
    await db.batch([
      db.prepare(`UPDATE fulfillment_tasks SET encrypted_value=?,state='delivered',delivered_at=?,updated_at=? WHERE order_id=? AND state IN ('reserved','queued','running') AND EXISTS(SELECT 1 FROM muse_orders m JOIN orders o ON o.id=m.order_id WHERE m.order_id=fulfillment_tasks.order_id AND m.lease_token=? AND ${eligible})`).bind(encrypted, done, done, id, lease),
      db.prepare("UPDATE muse_orders SET state='succeeded',failure_code='',updated_at=? WHERE order_id=? AND lease_token=? AND EXISTS(SELECT 1 FROM fulfillment_tasks WHERE order_id=? AND state='delivered')").bind(done, id, lease, id),
      db.prepare(`UPDATE orders SET status='success',version=version+1,updated_at=?,last_event_id=? WHERE id=? AND ${eligible} AND EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=orders.id AND m.state='succeeded' AND m.lease_token=?)`).bind(done, event, id, lease),
      db.prepare("INSERT INTO order_events(id,order_id,actor,action,to_status,note,order_version,created_at) SELECT ?,id,'system','muse-delivered',status,'Muse 原采购单已交付，可在原订单领取',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, done, id, event),
    ])
  } catch (error) {
    delay = Math.min(300000, 20000 * 2 ** Math.min(p.failure_count, 4))
    if (error instanceof MuseError && error.status === 429) delay = Math.max(60000, delay)
    // Never persist supplier prose, response bodies, credentials or delivery data
    // in errors/audits. A delivery/read failure only rechecks the original order.
    await db.prepare("UPDATE muse_orders SET state='unknown',failure_code='unconfirmed',failure_count=failure_count+1,updated_at=? WHERE order_id=? AND lease_token=? AND state NOT IN ('succeeded','failed')").bind(Date.now(), id, lease).run()
  } finally {
    await db.prepare('UPDATE muse_orders SET next_attempt_at=?,lease_until=0,lease_token=NULL WHERE order_id=? AND lease_token=?').bind(Date.now() + delay, id, lease).run()
  }
}
export async function reconcileMuse(env: Env) {
  if (!museConfigured(env)) return
  // Old-key intents need their original key. Keep them durable without allowing
  // ten blocked rows to occupy every recovery batch for current-key purchases.
  const rows = (await env.INTEREST_DB.prepare("SELECT m.order_id FROM muse_orders m JOIN orders o ON o.id=m.order_id WHERE m.key_id=? AND m.state NOT IN ('succeeded','failed') AND m.lease_until<=? AND m.next_attempt_at<=? AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0 ORDER BY m.updated_at LIMIT 10").bind(env.MUSE_KEY_ID!, Date.now(), Date.now()).all<{ order_id: string }>()).results
  for (const row of rows) { try { await fulfillMuse(env, row.order_id) } catch { /* Keep the original intent; isolate other orders. */ } }
}
