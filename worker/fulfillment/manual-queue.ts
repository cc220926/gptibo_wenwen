import { MANUAL_DELIVERY_STATES, type ManualDeliveryQueue, type ManualDeliveryRow, type ManualDeliveryState } from '../../shared/manual-delivery.ts'
import { ApiError, json, type Env, type Value } from '../platform.ts'

// List only paid, real manual tasks. Muse also stores kind=manual, but has its
// own immutable supplier snapshot and must never enter the human work queue.
const source = `FROM fulfillment_tasks t JOIN orders o ON o.id=t.order_id
  WHERE t.kind='manual' AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid'
  AND t.state IN ('queued','running','review','delivered')
  AND NOT EXISTS(SELECT 1 FROM muse_orders m WHERE m.order_id=o.id)`
const state = `CASE WHEN t.state='delivered' THEN 'delivered'
  WHEN o.refund_hold<>0 OR o.refunded_cents>0 OR o.redemption_blocked<>0 THEN 'held'
  WHEN t.state='review' OR o.status NOT IN ('session','processing') THEN 'review'
  ELSE t.state END`

export async function manualDeliveryQueue(env: Env, url: URL) {
  const filter = url.searchParams.get('state') ?? 'active'
  const q = url.searchParams.get('q')?.trim() ?? ''
  const page = Number(url.searchParams.get('page') ?? 1)
  if (!['active', 'all', ...Object.keys(MANUAL_DELIVERY_STATES)].includes(filter) || q.length > 320 || !Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ApiError('筛选条件无效。')
  const values: Value[] = [], clauses: string[] = []
  if (q) {
    clauses.push("(instr(o.id,?)>0 OR instr(lower(COALESCE(o.customer_email,'')),?)>0)")
    values.push(q.toUpperCase(), q.toLowerCase())
  }
  const search = clauses.length ? ' AND ' + clauses.join(' AND ') : ''
  const grouped = (await env.INTEREST_DB.prepare(`SELECT ${state} state,COUNT(*) count ${source}${search} GROUP BY ${state}`).bind(...values).all<{ state: ManualDeliveryState; count: number }>()).results
  const counts: ManualDeliveryQueue['counts'] = { queued: 0, running: 0, held: 0, review: 0, delivered: 0 }
  for (const row of grouped) counts[row.state] = row.count
  const total = filter === 'active' ? counts.queued + counts.running : filter === 'all' ? Object.values(counts).reduce((sum, count) => sum + count, 0) : counts[filter as ManualDeliveryState]
  const selected = filter === 'all' ? '' : filter === 'active' ? ` AND (${state}) IN ('queued','running')` : ` AND (${state})=?`
  const rows = (await env.INTEREST_DB.prepare(`SELECT o.id,t.product_name productName,o.plan_name planName,o.customer_email customerEmail,
    o.price_cents priceCents,o.created_at createdAt,t.updated_at updatedAt,${state} state,
    o.refund_hold refundHold,o.refunded_cents refundedCents,o.redemption_blocked redemptionBlocked
    ${source}${search}${selected} ORDER BY o.created_at,o.id LIMIT 20 OFFSET ?`)
    .bind(...values, ...(filter === 'active' || filter === 'all' ? [] : [filter]), (page - 1) * 20)
    .all<Omit<ManualDeliveryRow, 'refundHold' | 'redemptionBlocked'> & { refundHold: number; redemptionBlocked: number }>()).results
  return json({ rows: rows.map(row => ({ ...row, refundHold: Boolean(row.refundHold), redemptionBlocked: Boolean(row.redemptionBlocked) })), total, page, counts } satisfies ManualDeliveryQueue)
}
