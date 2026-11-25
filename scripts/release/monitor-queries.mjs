import assert from 'node:assert/strict'

// This module only constructs SELECT statements and sanitizes observations. It
// has no database/network client, credentials, mutation, or deployment action.
// Epoch values are milliseconds. Window reports use [startMs, endMs); queue
// reports are current-state snapshots at asOfMs, not historical queue lengths.
export function buildMonitoringQueries({ startMs, endMs, asOfMs = endMs, staleAfterMs = 600_000 }) {
  for (const value of [startMs, endMs, asOfMs, staleAfterMs]) assert.ok(Number.isSafeInteger(value) && value >= 0)
  assert.ok(startMs < endMs && endMs <= asOfMs && staleAfterMs > 0)
  assert.ok(endMs - startMs <= 86400_000, 'Use a bounded observation window of at most one day')
  const staleBefore = asOfMs - staleAfterMs
  const query = (name, sql, params) => ({ name, sql: sql.trim(), params })
  return [
    query('orders_created_window', `SELECT status,payment_status,COUNT(*) AS count
      FROM orders WHERE mode='live' AND is_test=0 AND created_at>=? AND created_at<?
      GROUP BY status,payment_status ORDER BY status,payment_status`, [startMs, endMs]),
    query('order_transitions_window', `SELECT
      CASE WHEN e.action IN ('payment-confirmed','payment-closed','service-dispatch','muse-delivered','muse-failed','recharge-submit','recharge-rejected') THEN e.action ELSE 'other' END AS action_class,
      CASE WHEN e.to_status IN ('pending','session','processing','success','failed','cancelled') THEN e.to_status ELSE 'other' END AS to_status,
      COUNT(*) AS count FROM order_events e JOIN orders o ON o.id=e.order_id
      WHERE o.mode='live' AND o.is_test=0 AND e.created_at>=? AND e.created_at<?
      GROUP BY action_class,to_status ORDER BY action_class,to_status`, [startMs, endMs]),
    query('payment_receipts_window', `SELECT
      CASE WHEN p.provider IN ('alipay','zpay','mapay') THEN p.provider ELSE 'other' END AS provider,
      p.state,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN p.notified_at>=? AND p.notified_at<? THEN 1 ELSE 0 END),0) AS first_callback_receipts_in_window
      FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE o.mode='live' AND o.is_test=0 AND (p.updated_at>=? AND p.updated_at<? OR p.notified_at>=? AND p.notified_at<?)
      GROUP BY provider,p.state ORDER BY provider,p.state`, [startMs, endMs, startMs, endMs, startMs, endMs]),
    query('paid_order_queue', `SELECT status,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN updated_at<? THEN 1 ELSE 0 END),0) AS old_local_update_count,
      CAST(MAX(MAX(0,?-updated_at))/1000 AS INTEGER) AS oldest_local_update_seconds
      FROM orders WHERE mode='live' AND is_test=0 AND payment_status='paid'
      AND status IN ('session','processing','failed') AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0
      GROUP BY status ORDER BY status`, [staleBefore, asOfMs]),
    query('recharge_notification_backlog', `SELECT COUNT(*) AS recharge_records,
      COALESCE(SUM(CASE WHEN r.notify_version>r.checked_notify_version THEN 1 ELSE 0 END),0) AS pending_notification_records,
      COALESCE(SUM(CASE WHEN r.notify_version>r.order_checked_notify_version THEN 1 ELSE 0 END),0) AS pending_order_verification,
      COALESCE(SUM(CASE WHEN r.notify_version>r.redemption_checked_notify_version THEN 1 ELSE 0 END),0) AS pending_task_verification,
      COALESCE(SUM(CASE WHEN r.lease_until>? THEN 1 ELSE 0 END),0) AS active_leases,
      COALESCE(SUM(CASE WHEN r.financial_hold=1 AND o.payment_status='paid' THEN 1 ELSE 0 END),0) AS paid_financial_hold_records
      FROM recharge_orders r JOIN orders o ON o.id=r.order_id WHERE o.mode='live' AND o.is_test=0`, [asOfMs]),
    query('recharge_attempts_window', `SELECT r.status,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN r.finished_at>=? AND r.finished_at<? THEN 1 ELSE 0 END),0) AS finished_in_window
      FROM recharge_redemptions r JOIN orders o ON o.id=r.order_id
      WHERE o.mode='live' AND o.is_test=0 AND (r.created_at>=? AND r.created_at<? OR r.finished_at>=? AND r.finished_at<?)
      GROUP BY r.status ORDER BY r.status`, [startMs, endMs, startMs, endMs, startMs, endMs]),
    query('supplier_procurement_queue', `SELECT m.state,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN m.next_attempt_at<=? AND m.lease_until<=? THEN 1 ELSE 0 END),0) AS currently_due,
      COALESCE(SUM(CASE WHEN m.updated_at<? THEN 1 ELSE 0 END),0) AS old_local_update_count,
      COALESCE(SUM(CASE WHEN m.failure_count>0 THEN 1 ELSE 0 END),0) AS records_with_retries
      FROM muse_orders m JOIN orders o ON o.id=m.order_id
      WHERE o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0
      AND m.state NOT IN ('succeeded','failed') GROUP BY m.state ORDER BY m.state`, [asOfMs, asOfMs, staleBefore]),
    query('service_delivery_queue', `SELECT
      CASE WHEN m.order_id IS NOT NULL THEN 'supplier' WHEN f.kind='stock' THEN 'stock' ELSE 'manual' END AS delivery_class,
      f.state,f.mail_state,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN f.updated_at<? THEN 1 ELSE 0 END),0) AS old_local_update_count
      FROM fulfillment_tasks f JOIN orders o ON o.id=f.order_id LEFT JOIN muse_orders m ON m.order_id=f.order_id
      WHERE o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0
      AND (f.state NOT IN ('delivered','expired') OR f.mail_state<>'sent')
      GROUP BY delivery_class,f.state,f.mail_state ORDER BY delivery_class,f.state,f.mail_state`, [staleBefore]),
    query('verified_webhooks_window', `SELECT 'recharge' AS channel,COUNT(*) AS count
      FROM recharge_webhooks WHERE received_at>=? AND received_at<?
      UNION ALL SELECT 'supplier' AS channel,COUNT(*) AS count
      FROM muse_events WHERE received_at>=? AND received_at<?`, [startMs, endMs, startMs, endMs]),
    query('payment_order_consistency', `SELECT
      COUNT(*) AS paid_receipts,
      COALESCE(SUM(CASE WHEN o.payment_status<>'paid' THEN 1 ELSE 0 END),0) AS paid_receipt_without_paid_order,
      COALESCE(SUM(CASE WHEN p.amount_cents<>o.price_cents THEN 1 ELSE 0 END),0) AS payment_amount_mismatch
      FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.mode='live' AND o.is_test=0 AND p.state='paid'` , []),
  ]
}

export const monitoringCautions = [
  'A zero-activity window does not prove that payment callbacks or fulfillment worked.',
  'session means waiting for customer credentials; manual fulfillment and old existing failures are not automatic rollback signals.',
  'notified_at records only the first accepted payment notification. Callback retry volume must come from sanitized tail events.',
  'Recharge webhook acknowledgements only queue signed verification; compare watermarks and later order transitions.',
  'A task-verification watermark may lag while an order has no submitted task; do not treat that count alone as failed fulfillment.',
  'A 10-minute age is a monitoring heuristic, not a supplier SLA. Compare with the pre-release snapshot and queue progress.',
  'Queue snapshots include old active records. Growth alone is not proof that the new release caused an error.',
  'Run aggregate queries sparsely: before release, after release and across a five-minute reconciliation boundary; do not poll D1 continuously.',
]

const oneOf = (value, allowed) => allowed.includes(value) ? value : 'other'
const queueNames = ['Saved credential expiry','Telegram invitation queue','Order notification queue','Muse procurement queue','Overdue reservation payments','Service delivery queue','Checkout activity cleanup','Recharge refund queue','External recharge refund queue','Payment reconciliation queue','Recharge reconciliation queue','Payout notification queue','Invoice payment reconciliation queue','Recharge reminder queue','Gmail fulfillment queue','Delivery supplier queue','X gift fulfillment queue','Operator alert queue']
function routeClass(raw) {
  let path
  try { path = new URL(raw).pathname } catch { return 'other' }
  if (['/', '/robots.txt', '/sitemap.xml', '/api/catalog', '/api/orders', '/api/orders/client', '/api/orders/verification', '/api/orders/recovery/send', '/api/orders/recovery/verify', '/api/orders/recovery/session', '/api/recharge/webhook', '/api/muse/webhook'].includes(path)) return path
  if (/^\/api\/payments\/notify\/(alipay|zpay|mapay)$/.test(path)) return path
  if (/^\/api\/orders\/[^/]+\/(payment|fulfillment)$/.test(path)) return '/api/orders/:id/' + path.split('/').at(-1)
  if (/^\/api\/orders\/[^/]+$/.test(path)) return '/api/orders/:id'
  if (path.startsWith('/assets/')) return '/assets/*'
  if (path.startsWith('/help/')) return '/help/*'
  if (path.startsWith('/product/')) return '/product/*'
  if (path.startsWith('/api/')) return '/api/other'
  return 'other'
}

// Consume raw tail JSON in memory and persist ONLY this return value. Never
// persist the raw event: it can contain callback signatures, cookies and IDs.
export function sanitizeTailEvent(input) {
  const event = input && typeof input === 'object' ? input : {}
  const safe = {
    timestamp: typeof event.eventTimestamp === 'number' ? event.eventTimestamp : null,
    kind: event.event?.request ? 'http' : event.event?.scheduledTime !== undefined ? 'scheduled' : 'other',
    route: routeClass(event.event?.request?.url),
    method: oneOf(event.event?.request?.method, ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']),
    status: Number.isInteger(event.event?.response?.status) && event.event.response.status >= 100 && event.event.response.status <= 599 ? event.event.response.status : null,
    outcome: oneOf(event.outcome, ['ok','exception','exceededCpu','exceededMemory','canceled','unknown']),
    exceptions: Array.isArray(event.exceptions) ? event.exceptions.length : 0,
    paymentNotifications: [], queueFailures: [],
  }
  for (const log of Array.isArray(event.logs) ? event.logs : []) {
    for (const message of Array.isArray(log.message) ? log.message : [log.message]) {
      if (typeof message !== 'string' || message.length > 2048) continue
      const queue = queueNames.find(name => message === name + ' temporarily unavailable')
      if (queue) safe.queueFailures.push(queue)
      let parsed
      try { parsed = JSON.parse(message) } catch { continue }
      if (parsed?.event !== 'payment-notification') continue
      safe.paymentNotifications.push({
        provider: oneOf(parsed.provider, ['alipay','zpay','mapay','unknown']),
        outcome: oneOf(parsed.outcome, ['received','rejected','applied']),
        stage: oneOf(parsed.stage, ['provider','verification','lookup','apply','receipt']),
        reason: parsed.reason === undefined ? null : oneOf(parsed.reason, ['invalid_signature','invalid_format','invalid_trade','gateway_unavailable','gateway_malformed','gateway_mismatch','gateway_not_confirmed','provider_unavailable','payment_not_matched','internal']),
      })
    }
  }
  return safe
}
