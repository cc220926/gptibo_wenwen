import { fulfillMuse, museMapping, musePurchase, museSnapshot, prepareMuse } from '../muse/service.ts'
import { isMuseCode, supplyKind } from '../muse/client.ts'
import { ApiError, type Env, type Statement } from '../platform.ts'
import { getOrder, type Order } from '../order-state.ts'
import { deliveryMailReady } from '../email-delivery.ts'
import { servicePaymentConfigured } from '../payments/providers.ts'
import { emailPayload, mailBrand, sendFrozenEmail } from '../email.ts'
import { isServicePlan, type DeliveryKind, type ServiceTask } from '../../shared/fulfillment.ts'
import { CODEX_SMS_REDEEM_URL, updateCodexSmsRedeemAddress } from '../../shared/codex-sms-redemption.ts'
import { seal, unseal, vaultReady } from './vault.ts'

export type Task = { order_id: string; kind: DeliveryKind; state: string; product_id: string; product_name: string; instructions: string; stock_id: string | null; encrypted_value: string | null; expires_at: number; delivered_at: number | null; mail_state: string; encrypted_mail: string | null; mail_first_attempt_at: number | null; mail_next_attempt_at: number; lease_token: string | null; lease_until: number }
export const taskFor = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM fulfillment_tasks WHERE order_id=?').bind(id).first<Task>()
const isCodexSmsDelivery = (productId: string, supplierCode?: string) => productId === 'codex-sms' || supplyKind(supplierCode ?? null) === 'codex-sms'
const eligible = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0"
// A completed, partly refunded delivery remains the buyer's property. New
// dispatches still require zero refunds, but its pending notice may be sent.
const deliveredEligible = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents<price_cents AND redemption_blocked=0"
export async function serviceCheckoutEnabled(env: Env, muse = false) {
  return env.SERVICE_CHECKOUT_ENABLED === 'true' && servicePaymentConfigured(env, muse) && deliveryMailReady(env) && await vaultReady(env)
}
export async function serviceCatalog(env: Env) {
  return (await env.INTEREST_DB.prepare(`SELECT c.*,p.name product_name,p.category,p.description,p.hidden,m.product_code muse_product_code,m.max_cost_cents muse_max_cost_cents,CASE WHEN m.plan IS NOT NULL THEN 'muse' ELSE NULL END delivery_provider,
    (SELECT COUNT(*) FROM cdk_stock s WHERE s.plan=c.id AND s.state='available') stock_available
    FROM catalog_plans c JOIN service_products p ON p.id=c.product_id LEFT JOIN muse_plans m ON m.plan=c.id WHERE c.delivery_type<>'legacy' ORDER BY p.category,p.name,c.rowid`).all()).results
}

// Keep a few simultaneous checkouts available, without letting one buyer reserve
// an entire SKU. Email supplements the browser identity; neither is a verified
// identity by itself. Count unresolved payment reservations even after expiry.
const MAX_UNPAID_RESERVATIONS = 3
const pendingReservations = `SELECT COUNT(*) total FROM orders o JOIN fulfillment_tasks t ON t.order_id=o.id
  WHERE o.plan=? AND (o.owner_hash=? OR o.customer_email=?) AND o.payment_status='unpaid' AND t.state='reserved'`
const reservationLimitMessage = '该商品已有 3 笔待付款订单，请到“我的订单”继续支付，或等待未付款订单关闭后重试。'

/** Order + immutable delivery snapshot + reservation commit in one transaction. */
export async function createServiceOrder(env: Env, ownerHash: string, email: string, data: Record<string, unknown>) {
  if (data.partner) throw new ApiError('该商品暂仅支持平台直营购买。', 409)
  if (env.SERVICE_CHECKOUT_ENABLED !== 'true') throw new ApiError('自有商品暂未开放购买。', 409)
  await expireReservations(env)
  const plan = await env.INTEREST_DB.prepare(`SELECT c.*,p.name product_name FROM catalog_plans c JOIN service_products p ON p.id=c.product_id WHERE c.id=? AND c.enabled=1 AND c.delisted=0 AND p.hidden=0 AND c.delivery_type IN ('stock','manual')`).bind(String(data.plan)).first<{ id: string; product_id: string; product_name: string; name: string; price_cents: number; version: number; delivery_type: DeliveryKind; purchase_note: string; delivery_instructions: string }>()
  if (!plan) throw new ApiError('该商品已暂停销售。', 409)
  const mapping = await museMapping(env, plan.id)
  if (!await serviceCheckoutEnabled(env, Boolean(mapping && isMuseCode(mapping.product_code)))) throw new ApiError('该商品的支付服务暂未配置，请联系商家。', 409)
  if (data.expectedPrice !== plan.price_cents) throw new ApiError('价格已更新，请刷新后重新确认。', 409)
  const pending = await env.INTEREST_DB.prepare(pendingReservations).bind(plan.id, ownerHash, email).first<{ total: number }>()
  if (pending && pending.total >= MAX_UNPAID_RESERVATIONS) throw new ApiError(reservationLimitMessage, 409)
  const cost = mapping ? await prepareMuse(env, mapping, plan.price_cents) : 0
  const now = Date.now(), id = 'YMX-' + crypto.randomUUID().replaceAll('-', '').toUpperCase(), event = crypto.randomUUID()
  const statements: Statement[] = [
    env.INTEREST_DB.prepare(`INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,status,created_at,updated_at,last_event_id,customer_email,purchase_note)
      SELECT ?,?,?,c.id,c.name,c.price_cents,'live','pending',?,?,?,?,c.purchase_note FROM catalog_plans c
      WHERE c.id=? AND c.version=? AND c.enabled=1 AND c.delisted=0 AND EXISTS(SELECT 1 FROM service_products p WHERE p.id=c.product_id AND p.hidden=0) AND (c.delivery_type='manual' OR EXISTS(SELECT 1 FROM cdk_stock s WHERE s.plan=c.id AND s.state='available'))
      AND (${pendingReservations}) < ${MAX_UNPAID_RESERVATIONS}
      ON CONFLICT(owner_hash,idempotency_key) DO NOTHING`).bind(id, ownerHash, String(data.key), now, now, event, email, plan.id, plan.version, plan.id, ownerHash, email),
  ]
  // Bind the first still-available unit while the order transaction owns the write lock.
  statements.push(env.INTEREST_DB.prepare(`INSERT INTO fulfillment_tasks(order_id,kind,state,product_id,product_name,instructions,stock_id,expires_at,updated_at)
    SELECT o.id,?,'reserved',?,?,?,CASE WHEN ?='stock' THEN (SELECT id FROM cdk_stock WHERE plan=o.plan AND state='available' ORDER BY created_at,id LIMIT 1) ELSE NULL END,?,? FROM orders o WHERE o.id=?`)
    .bind(plan.delivery_type, plan.product_id, plan.product_name, plan.delivery_instructions, plan.delivery_type, now + 15 * 60000, now, id))
  statements.push(
    env.INTEREST_DB.prepare("UPDATE cdk_stock SET state='reserved',order_id=? WHERE id=(SELECT stock_id FROM fulfillment_tasks WHERE order_id=?) AND state='available'").bind(id, id),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,to_status,note,order_version,created_at) SELECT ?,id,'customer','create','pending','创建订单，等待付款；交付方式已保存',0,? FROM orders WHERE id=?").bind(event, now, id),
  )
  if (mapping) statements.push(museSnapshot(env, id, mapping, cost))
  await env.INTEREST_DB.batch(statements)
  const created = await env.INTEREST_DB.prepare('SELECT * FROM orders WHERE owner_hash=? AND idempotency_key=?').bind(ownerHash, String(data.key)).first<Order>()
  if (!created) {
    const pending = await env.INTEREST_DB.prepare(pendingReservations).bind(plan.id, ownerHash, email).first<{ total: number }>()
    if (pending && pending.total >= MAX_UNPAID_RESERVATIONS) throw new ApiError(reservationLimitMessage, 409)
    throw new ApiError('库存不足或商品已更新，请刷新后重试。', 409)
  }
  if (created.plan !== plan.id || created.customer_email !== email || created.partner_id) throw new ApiError('请求编号已被其他订单使用。', 409)
  return created
}

/** Expiry never frees a unit while a payable or uncertain gateway trade exists. */
export async function expireReservations(env: Env) {
  const now = Date.now()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE cdk_stock SET state='quarantined' WHERE state IN ('reserved','delivered') AND EXISTS(SELECT 1 FROM orders o WHERE o.id=cdk_stock.order_id AND o.refunded_cents>0)"),
    env.INTEREST_DB.prepare(`UPDATE fulfillment_tasks SET state='expired',updated_at=? WHERE state='reserved' AND expires_at<=?
      AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_id AND o.payment_status='unpaid')
      AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=fulfillment_tasks.order_id AND p.state<>'closed')`).bind(now, now),
    env.INTEREST_DB.prepare("UPDATE cdk_stock SET state='available',order_id=NULL WHERE state='reserved' AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=cdk_stock.order_id AND t.state='expired')"),
    env.INTEREST_DB.prepare("UPDATE orders SET status='cancelled',updated_at=?,version=version+1,last_event_id='expired-'||id WHERE status='pending' AND payment_status='unpaid' AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=orders.id AND t.state='expired')").bind(now),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT last_event_id,id,'system','reservation-expired','pending',status,'未付款库存预留已到期',version,? FROM orders WHERE last_event_id='expired-'||id ON CONFLICT DO NOTHING").bind(now),
  ])
}

export async function fulfillService(env: Env, id: string) {
  const task = await taskFor(env, id)
  if (!task || task.state === 'delivered') return
  const now = Date.now(), event = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    // A late receipt for stock (or Muse) goes to review: its unit may be resold.
    // Plain manual delivery holds no unit, so it simply joins the human queue.
    env.INTEREST_DB.prepare(`UPDATE fulfillment_tasks SET state=CASE WHEN kind='manual' AND NOT EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=fulfillment_tasks.order_id) THEN 'queued' ELSE 'review' END,updated_at=? WHERE order_id=? AND state='expired' AND EXISTS(SELECT 1 FROM orders WHERE id=order_id AND ${eligible})`).bind(now, id),
    env.INTEREST_DB.prepare(`UPDATE cdk_stock SET state='delivered',delivered_at=? WHERE order_id=? AND state='reserved'
      AND EXISTS(SELECT 1 FROM fulfillment_tasks t JOIN orders o ON o.id=t.order_id WHERE t.order_id=cdk_stock.order_id AND t.stock_id=cdk_stock.id AND t.state='reserved' AND ${eligible})`).bind(now, id),
    env.INTEREST_DB.prepare(`UPDATE fulfillment_tasks SET state=CASE WHEN kind='stock' THEN 'delivered' ELSE 'queued' END,
      encrypted_value=CASE WHEN kind='stock' THEN (SELECT encrypted_value FROM cdk_stock WHERE id=stock_id AND order_id=fulfillment_tasks.order_id AND state='delivered') ELSE encrypted_value END,
      delivered_at=CASE WHEN kind='stock' THEN ? ELSE NULL END,updated_at=? WHERE order_id=? AND state='reserved'
      AND EXISTS(SELECT 1 FROM orders WHERE id=order_id AND ${eligible})
      AND (kind='manual' OR EXISTS(SELECT 1 FROM cdk_stock s WHERE s.id=stock_id AND s.order_id=fulfillment_tasks.order_id AND s.state='delivered'))`).bind(now, now, id),
    env.INTEREST_DB.prepare(`UPDATE orders SET status=CASE WHEN t.state='delivered' THEN 'success' WHEN t.state='review' THEN 'failed' ELSE 'processing' END,
      started_at=COALESCE(started_at,?),updated_at=?,version=version+1,last_event_id=? FROM fulfillment_tasks t
      WHERE orders.id=? AND t.order_id=orders.id AND ${eligible} AND orders.status IN ('session','pending','cancelled') AND t.state IN ('delivered','queued','review')`).bind(now, now, event, id),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','service-dispatch','session',status,CASE WHEN status='success' THEN '自有库存已交付，可在原订单领取' WHEN status='failed' THEN '到期后确认收款，请人工核对原订单，未重复分配库存' WHEN EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=orders.id) THEN '付款已确认，等待原订单自动采购' ELSE '付款已确认，等待人工交付' END,version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, now, id, event),
  ])
  if (await musePurchase(env, id)) await fulfillMuse(env, id)
}

export async function serviceOrderSummary(env: Env, order: Order, reveal = true) {
  if (!isServicePlan(order.plan)) return {}
  const task = await taskFor(env, order.id)
  if (!task) return {}
  const supplier = await musePurchase(env, order.id)
  const serviceDelivery: ServiceTask = { ...(supplier ? { provider: 'muse' as const, supplierState: supplier.state } : {}), kind: task.kind, state: task.state, productId: task.product_id, productName: task.product_name, expiresAt: task.expires_at, mailState: task.mail_state }
  const visible = reveal && task.state === 'delivered' && order.mode === 'live' && !order.is_test && order.payment_status === 'paid' && !order.refund_hold && order.refunded_cents < order.price_cents && !order.redemption_blocked
  const value = visible && task.encrypted_value ? await unseal(env, task.encrypted_value, task.stock_id ? 'stock:' + task.stock_id : 'task:' + order.id) : undefined
  const redemptionUrl = value && isCodexSmsDelivery(task.product_id, supplier?.product_code) ? CODEX_SMS_REDEEM_URL : undefined
  return { serviceDelivery, manualFulfillment: true, delivery: { kind: 'cdk' as const, automatic: task.kind === 'stock' || Boolean(supplier), status: task.mail_state === 'sent' ? 'sent' as const : task.mail_state === 'sending' ? 'sending' as const : 'waiting' as const, sentAt: null, ...(visible ? { value, instructions: task.instructions, redemptionUrl } : {}) } }
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
/** Notification failure never reallocates inventory or undoes a visible delivery. */
export async function sendServiceMail(env: Env, id: string) {
  let task = await taskFor(env, id)
  if (!task || task.state !== 'delivered' || task.mail_state === 'sent' || task.mail_state === 'review' || task.lease_until > Date.now()) return
  const now = Date.now(), lease = crypto.randomUUID()
  await env.INTEREST_DB.prepare(`UPDATE fulfillment_tasks SET mail_state='sending',lease_token=?,lease_until=? WHERE order_id=? AND state='delivered' AND mail_state IN ('pending','sending') AND lease_until<=? AND EXISTS(SELECT 1 FROM orders WHERE id=order_id AND ${deliveredEligible})`).bind(lease, now + 60000, id, now).run()
  task = (await taskFor(env, id))!
  if (task.lease_token !== lease) return
  try {
    if (task.mail_first_attempt_at !== null && now - task.mail_first_attempt_at >= 23 * 3600000) {
      await env.INTEREST_DB.prepare("UPDATE fulfillment_tasks SET mail_state='review' WHERE order_id=? AND lease_token=?").bind(id, lease).run(); return
    }
    const order = await getOrder(env, id)
    if (!task.encrypted_mail) {
      const value = await unseal(env, task.encrypted_value!, task.stock_id ? 'stock:' + task.stock_id : 'task:' + id), brand = mailBrand(env)
      const codexSms = isCodexSmsDelivery(task.product_id, (await musePurchase(env, id))?.product_code)
      const delivery = `${value}\n\n${task.instructions}`
      const introduction = `${brand.name} · ${task.product_name} · ${order.plan_name}\n订单号：${id}\n\n交付内容\n${codexSms ? updateCodexSmsRedeemAddress(delivery) : delivery}\n\n`
      const footer = `请妥善保管。已交付不代表已激活或兑换。\n订单查询：${brand.origin}/orders`
      const redeemText = codexSms ? `接码兑换：${CODEX_SMS_REDEEM_URL}\n\n` : ''
      const redeemLink = codexSms ? `接码兑换：<a href="${CODEX_SMS_REDEEM_URL}">${CODEX_SMS_REDEEM_URL}</a>\n\n` : ''
      const text = introduction + redeemText + footer
      const htmlBody = escape(introduction) + redeemLink + escape(footer)
      const payload = emailPayload(env, order.customer_email!, { subject: `${brand.name} · ${task.product_name}已交付`, text, html: `<div style="font-family:system-ui;max-width:600px;margin:auto"><h1>商品已交付</h1><p>${escape(task.product_name)} · ${escape(order.plan_name)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlBody}</pre></div>` })
      const encrypted = await seal(env, payload, 'mail:' + id)
      await env.INTEREST_DB.prepare('UPDATE fulfillment_tasks SET encrypted_mail=? WHERE order_id=? AND lease_token=? AND encrypted_mail IS NULL').bind(encrypted, id, lease).run()
      task = (await taskFor(env, id))!
    }
    await env.INTEREST_DB.prepare('UPDATE fulfillment_tasks SET mail_first_attempt_at=COALESCE(mail_first_attempt_at,?),mail_attempts=mail_attempts+1 WHERE order_id=? AND lease_token=?').bind(now, id, lease).run()
    const providerId = await sendFrozenEmail(env, await unseal(env, task.encrypted_mail!, 'mail:' + id), 'service-delivery/' + id)
    await env.INTEREST_DB.prepare("UPDATE fulfillment_tasks SET mail_state='sent',mail_provider_id=? WHERE order_id=? AND lease_token=?").bind(providerId, id, lease).run()
  } catch {
    await env.INTEREST_DB.prepare("UPDATE fulfillment_tasks SET mail_state='pending',mail_next_attempt_at=? WHERE order_id=? AND lease_token=? AND mail_state='sending'").bind(Date.now() + 60000, id, lease).run()
  } finally {
    await env.INTEREST_DB.prepare('UPDATE fulfillment_tasks SET lease_until=0 WHERE order_id=? AND lease_token=?').bind(id, lease).run()
  }
}
export async function reconcileServices(env: Env) {
  await expireReservations(env)
  const rows = (await env.INTEREST_DB.prepare(`SELECT t.order_id FROM fulfillment_tasks t JOIN orders o ON o.id=t.order_id WHERE
    ((${eligible}) AND t.state IN ('reserved','expired')) OR
    ((${deliveredEligible}) AND t.state='delivered' AND t.mail_state IN ('pending','sending') AND t.mail_next_attempt_at<=? AND t.lease_until<=?)
    ORDER BY t.updated_at LIMIT 20`).bind(Date.now(), Date.now()).all<{ order_id: string }>()).results
  for (const row of rows) { try { await fulfillService(env, row.order_id); await sendServiceMail(env, row.order_id) } catch { /* Retain the original reservation and task for reconciliation. */ } }
}
