import type { Env } from './platform.ts'
import { emailPayload, mailBrand, sendFrozenEmail, type EmailMessage } from './email.ts'

const LEASE_MS = 60_000
// The provider deduplicates for 24h; leave a safety margin for ambiguous responses.
const RETRY_WINDOW_MS = 23 * 3_600_000
type Kind = 'payment' | 'recharge_success' | 'recharge_failed' | 'refund'
type Notification = {
  id:string; order_id:string; event_id:string; refund_case_id:string|null; attempt_id:string|null; kind:Kind
  event_created_at:number; first_attempt_at:number|null; attempt_count:number; payload_json:string|null; lock_token:string
}
type Context = {
  customer_email:string|null; plan_name:string; price_cents:number; mode:string; is_test:number
  payment_status:string; status:string; refunded_cents:number; refund_hold:number; created_at:number
  supplier_id:string|null; supplier_payment:string|null; supplier_refunded:number|null; financial_hold:number|null; verified_at:number|null
  payment_state:string|null; trade_no:string|null; payment_amount:number|null
  latest_attempt_id:string|null; attempt_status:string|null; attempt_remote_id:string|null; attempt_created_at:number|null
  action:string|null; event_status:string|null; event_version:number|null; submit_version:number|null
  refund_status:string|null; refund_amount:number|null; refund_reference:string|null; refund_event_status:string|null
}
function activation(env:Env) {
  const value = env.ORDER_EMAIL_NOTIFICATIONS_SINCE ?? ''
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
async function discover(env:Env, since:number, now:number) {
  // Persist a tombstone even for superseded events, so later scans cannot
  // resurrect them. Filtering order creation also prevents historical backfill.
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`INSERT OR IGNORE INTO order_email_notifications(id,order_id,event_id,attempt_id,kind,event_created_at,next_attempt_at)
      SELECT 'order/'||e.id,o.id,e.id,
        CASE WHEN e.action='recharge-status' THEN (SELECT a.id FROM recharge_redemptions a WHERE a.order_id=o.id AND a.created_at<=e.created_at ORDER BY a.attempt_no DESC LIMIT 1) ELSE NULL END,
        CASE WHEN e.action='payment-confirmed' THEN 'payment' WHEN e.to_status='success' THEN 'recharge_success' ELSE 'recharge_failed' END,e.created_at,?
      FROM order_events e JOIN orders o ON o.id=e.order_id
      WHERE e.created_at>=? AND e.created_at<=? AND o.created_at>=? AND o.mode='live' AND o.is_test=0
        AND o.customer_email IS NOT NULL AND o.customer_email<>''
        AND (e.action='payment-confirmed' OR (e.action='recharge-status' AND e.to_status IN ('success','failed')) OR (e.action='platform-fulfillment-completed' AND e.to_status='success'))
        AND NOT EXISTS(SELECT 1 FROM order_email_notifications n WHERE n.id='order/'||e.id)
      ORDER BY e.created_at,e.id LIMIT 100`).bind(now,since,now,since),
    env.INTEREST_DB.prepare(`INSERT OR IGNORE INTO order_email_notifications(id,order_id,event_id,refund_case_id,kind,event_created_at,next_attempt_at)
      SELECT 'refund/'||r.id,o.id,e.id,r.id,'refund',e.created_at,?
      FROM refund_events e JOIN refund_cases r ON r.id=e.case_id JOIN orders o ON o.id=r.order_id
      WHERE e.status='refunded' AND e.created_at>=? AND e.created_at<=? AND o.created_at>=? AND o.mode='live' AND o.is_test=0
        AND o.customer_email IS NOT NULL AND o.customer_email<>''
        AND NOT EXISTS(SELECT 1 FROM order_email_notifications n WHERE n.id='refund/'||r.id)
      ORDER BY e.created_at,e.id LIMIT 100`).bind(now,since,now,since),
  ])
}
async function context(env:Env, row:Notification) {
  return env.INTEREST_DB.prepare(`SELECT o.customer_email,o.plan_name,o.price_cents,o.mode,o.is_test,o.payment_status,o.status,o.refunded_cents,o.refund_hold,o.created_at,
    t.remote_id supplier_id,t.payment_status supplier_payment,t.refunded_cents supplier_refunded,t.financial_hold,t.verified_at,
    p.state payment_state,p.trade_no,p.amount_cents payment_amount,
    a.id latest_attempt_id,a.status attempt_status,a.remote_id attempt_remote_id,a.created_at attempt_created_at,
    e.action,e.to_status event_status,e.order_version event_version,
    (SELECT MAX(order_version) FROM order_events WHERE order_id=o.id AND action='recharge-submit') submit_version,
    r.status refund_status,r.approved_cents refund_amount,r.reference refund_reference,re.status refund_event_status
    FROM orders o LEFT JOIN recharge_orders t ON t.order_id=o.id LEFT JOIN payments p ON p.order_id=o.id
    LEFT JOIN recharge_redemptions a ON a.id=(SELECT id FROM recharge_redemptions WHERE order_id=o.id ORDER BY attempt_no DESC LIMIT 1)
    LEFT JOIN order_events e ON e.id=? AND e.order_id=o.id
    LEFT JOIN refund_cases r ON r.id=? AND r.order_id=o.id
    LEFT JOIN refund_events re ON re.id=? AND re.case_id=r.id
    WHERE o.id=?`).bind(row.event_id,row.refund_case_id,row.event_id,row.order_id).first<Context>()
}
function eligibility(row:Notification, value:Context|null, since:number):'ready'|'wait'|'cancel' {
  if (!value || value.mode!=='live' || value.is_test || value.created_at<since || row.event_created_at<since || value.payment_status!=='paid') return 'cancel'
  if (!value.customer_email || value.customer_email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.customer_email)) return 'cancel'
  if (row.kind==='refund') {
    if (value.refund_status!=='refunded' || value.refund_event_status!=='refunded' || !value.refund_reference || !value.refund_amount || value.refund_amount>value.refunded_cents) return 'wait'
    if (value.supplier_id && (!value.verified_at || value.financial_hold || value.supplier_refunded!==value.refunded_cents || !['partially_refunded','refunded'].includes(value.supplier_payment ?? ''))) return 'wait'
    return 'ready'
  }
  // Superseded payment/failure messages would contradict the current order page.
  if (value.refunded_cents>0 || (row.kind==='payment' && !['session','processing'].includes(value.status))) return 'cancel'
  if (row.kind==='recharge_success' && value.status!=='success') return 'cancel'
  if (row.kind==='recharge_failed' && value.status!=='failed') return 'cancel'
  if (row.kind==='payment' && value.action!=='payment-confirmed') return 'cancel'
  if (row.kind!=='payment') {
    if (value.action==='platform-fulfillment-completed' && row.kind==='recharge_success' && value.event_status==='success') {
      // The validated original-order fulfillment can supersede an old failed task.
    } else if (value.action!=='recharge-status' || !row.attempt_id || value.latest_attempt_id!==row.attempt_id || !value.attempt_remote_id
      || (value.attempt_created_at ?? Infinity)>row.event_created_at || (value.submit_version ?? 0)>(value.event_version ?? -1)
      || (row.kind==='recharge_success' ? value.attempt_status!=='succeeded' : !['failed','cancelled'].includes(value.attempt_status ?? ''))) return 'cancel'
  }
  if (value.refund_hold || value.financial_hold) return 'wait'
  const supplierPaid = !!value.supplier_id && !!value.verified_at && value.supplier_payment==='paid' && value.supplier_refunded===0
  if (row.kind!=='payment') return supplierPaid ? 'ready' : 'wait'
  const directPaid = value.payment_state==='paid' && !!value.trade_no && value.payment_amount===value.price_cents
  return supplierPaid || (!value.supplier_id && directPaid) ? 'ready' : 'wait'
}
const escapeHtml = (text:string) => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
function message(env:Env, row:Notification, order:Context):EmailMessage {
  const brand=mailBrand(env); const ordersUrl=brand.origin+'/orders'
  const headings:Record<Kind,string>={payment:'付款已确认',recharge_success:'充值已完成',recharge_failed:'充值未完成',refund:'退款已确认'}
  const descriptions:Record<Kind,string>={payment:'我们已核验您的付款。请进入订单页面查看当前进度及下一步操作。',recharge_success:'充值服务已确认完成。请进入订单页面查看结果。',recharge_failed:'充值服务已确认本次充值未完成。请进入订单页面查看处理方式。',refund:'这笔退款已核验并记入订单，实际到账时间以支付渠道和银行为准。'}
  const heading=headings[row.kind]
  const amount=row.kind==='refund' ? order.refund_amount! : order.price_cents
  const lines=[descriptions[row.kind], '订单号：'+row.order_id, '套餐：'+order.plan_name, (row.kind==='refund'?'本次退款金额：':'订单金额：')+'¥'+(amount/100).toFixed(2)]
  const recovery='在新设备上，请使用下单邮箱接收验证码找回订单。此邮件不包含登录凭证。'
  return {
    subject:brand.name+' · '+heading,
    text:[brand.name,heading,...lines,'查看订单：'+ordersUrl,recovery].join('\n\n'),
    html:`<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f6f7fb;color:#202124;font-family:Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:16px"><p style="color:#666">${escapeHtml(brand.name)}</p><h1 style="font-size:24px">${heading}</h1>${lines.map(line=>'<p style="line-height:1.7">'+escapeHtml(line)+'</p>').join('')}<p style="margin:28px 0"><a href="${escapeHtml(ordersUrl)}" style="display:inline-block;padding:12px 20px;background:#4338ca;color:#fff;border-radius:8px;text-decoration:none">查看订单</a></p><p style="color:#666;font-size:13px;line-height:1.7">${recovery}</p></main></body></html>`,
  }
}
export async function sendDueOrderNotifications(env:Env, limit=20) {
  const since=activation(env)
  if (env.ORDER_EMAIL_NOTIFICATIONS_ENABLED!=='true' || since===null || !env.RESEND_API_KEY || !env.RESEND_FROM) return {configured:false,sent:0,failed:0}
  // Reject missing/untrusted public origins before capturing a payload or making a request.
  mailBrand(env)
  const db=env.INTEREST_DB; const now=Date.now()
  await discover(env,since,now)
  await db.prepare(`UPDATE order_email_notifications SET status='manual_review',closed_reason='idempotency_window_expired'
    WHERE status='pending' AND locked_until<=? AND first_attempt_at IS NOT NULL AND first_attempt_at<=?`).bind(now,now-RETRY_WINDOW_MS).run()
  const rows=(await db.prepare(`SELECT * FROM order_email_notifications WHERE status='pending' AND locked_until<=? AND next_attempt_at<=?
    ORDER BY next_attempt_at,event_created_at,id LIMIT ?`).bind(now,now,Math.min(100,Math.max(1,Math.floor(limit)))).all<Notification>()).results
  let sent=0; let failed=0
  for (const candidate of rows) {
    const token=crypto.randomUUID(); const claimedAt=Date.now()
    await db.prepare(`UPDATE order_email_notifications SET lock_token=?,locked_until=? WHERE id=? AND status='pending' AND locked_until<=? AND next_attempt_at<=?`)
      .bind(token,claimedAt+LEASE_MS,candidate.id,claimedAt,claimedAt).run()
    const row=await db.prepare('SELECT * FROM order_email_notifications WHERE id=?').bind(candidate.id).first<Notification>()
    if (!row || row.lock_token!==token) continue
    try {
      const current=await context(env,row); const decision=eligibility(row,current,since)
      if (decision!=='ready') {
        await db.prepare(`UPDATE order_email_notifications SET status=?,closed_reason=?,next_attempt_at=?,locked_until=0 WHERE id=? AND lock_token=?`)
          .bind(decision==='cancel'?'cancelled':'pending',decision==='cancel'?'superseded_or_ineligible':null,Date.now()+60_000,row.id,token).run()
        continue
      }
      const payload=row.payload_json ?? emailPayload(env,current!.customer_email!,message(env,row,current!))
      // Full request bytes are immutable, including sender, recipient and branding.
      await db.prepare(`UPDATE order_email_notifications SET payload_json=COALESCE(payload_json,?) WHERE id=? AND status='pending' AND lock_token=? AND locked_until>?`)
        .bind(payload,row.id,token,Date.now()).run()
      // Preparation and D1 calls can interleave with a refund or new recharge.
      const ready=await context(env,row); const recheck=eligibility(row,ready,since)
      if (recheck!=='ready') {
        await db.prepare(`UPDATE order_email_notifications SET status=?,closed_reason=?,next_attempt_at=?,locked_until=0 WHERE id=? AND lock_token=?`)
          .bind(recheck==='cancel'?'cancelled':'pending',recheck==='cancel'?'superseded_or_ineligible':null,Date.now()+60_000,row.id,token).run()
        continue
      }
      // Only start the provider's retry window once preparation and the final
      // business-state check pass. Persist before the request can become ambiguous.
      await db.prepare(`UPDATE order_email_notifications SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=? AND status='pending' AND lock_token=? AND locked_until>?`)
        .bind(Date.now(),row.id,token,Date.now()).run()
      const stored=await db.prepare(`SELECT payload_json,first_attempt_at FROM order_email_notifications WHERE id=? AND status='pending' AND lock_token=? AND locked_until>?`).bind(row.id,token,Date.now()).first<{payload_json:string|null;first_attempt_at:number|null}>()
      if (!stored?.payload_json || stored.first_attempt_at===null || stored.first_attempt_at<=Date.now()-RETRY_WINDOW_MS) continue
      const providerId=await sendFrozenEmail(env,stored.payload_json,'order-notification/'+row.id)
      await db.prepare(`UPDATE order_email_notifications SET status='sent',delivered_at=?,provider_message_id=?,attempt_count=attempt_count+1,locked_until=0 WHERE id=? AND status='pending' AND lock_token=?`)
        .bind(Date.now(),providerId,row.id,token).run()
      sent++
    } catch {
      const backoff=Math.min(3_600_000,60_000*2**Math.min(row.attempt_count,6))
      await db.prepare(`UPDATE order_email_notifications SET attempt_count=attempt_count+1,next_attempt_at=?,locked_until=0 WHERE id=? AND status='pending' AND lock_token=?`)
        .bind(Date.now()+backoff,row.id,token).run()
      failed++
    }
  }
  return {configured:true,sent,failed}
}
