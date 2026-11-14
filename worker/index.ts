import { purgeRetainedCredentials } from './recharge/saved-credentials.ts'
import { museWebhook } from './muse/webhook.ts'
import { reconcileMuse } from './muse/service.ts'
import { reconcileServices } from './fulfillment/service.ts'
import { telegramWebhook, retryTelegramInvitations } from './telegram.ts'
import { reconcileXGift } from './xgift/service.ts'
import { reconcileDeliverySupplier } from './delivery_supplier/service.ts'
import type { Env } from './platform.ts'
import { commerce } from './commerce.ts'
import { paymentNotification, reconcileOverdueReservations, reconcilePayments } from './payments/service.ts'
import { reconcileRecharge, rechargeWebhook } from './recharge/service.ts'
import { reconcileExternalRechargeRefunds, reconcileRechargeRefunds } from './refunds.ts'
import { limitApi } from './rate-limit.ts'
import { ApiError } from './platform.ts'
import { recordVisitor } from './visitors.ts'
import { retryPayoutNotifications } from './payout-notifications.ts'
import { invoiceNotification, reconcileInvoicePayments } from './invoices.ts'
import { sendDueRechargeReminders } from './recharge-reminders.ts'
import { sendDueOrderNotifications } from './order-notifications.ts'
import { reconcileGmail } from './account_supplier/service.ts'
import { requireSecureTransport, secureResponse } from './security.ts'
import { checkoutPresence, expireCheckoutPresence } from './checkout-presence.ts'
import { customerHistory } from './customer-history.ts'
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {}) },
})
const error = (message: string, status: number) => json({ error: message }, status)
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function runScheduled(name: string, operation: () => Promise<unknown>) {
  try { await operation() }
  catch { console.error(name + ' temporarily unavailable') }
}

export default {
  async scheduled(event: { scheduledTime?: number }, env: Env) {
    await runScheduled('Saved credential expiry', () => purgeRetainedCredentials(env))
    // Telegram's durable queue is independent of supplier reconciliation failures.
    await runScheduled('Telegram invitation queue', () => retryTelegramInvitations(env))
    // Durable transactional email must continue even when supplier polling fails.
    await runScheduled('Order notification queue', () => sendDueOrderNotifications(env))
    await runScheduled('Muse procurement queue', () => reconcileMuse(env))
    // Close overdue cashier trades first so this minute's expiry can free their stock.
    await runScheduled('Overdue reservation payments', () => reconcileOverdueReservations(env))
    await runScheduled('Service delivery queue', () => reconcileServices(env))
    // Cosmetic activity statistics must not interrupt financial reconciliation.
    await runScheduled('Checkout activity cleanup', () => expireCheckoutPresence(env))
    // Reminders run every minute; preserve the existing five-minute reconciliation cadence.
    if (event.scheduledTime === undefined || Math.floor(event.scheduledTime / 60_000) % 5 === 0) {
      // Refund confirmation also needs the original order snapshot. Give both
      // refund paths its read budget before ordinary polling can consume it.
      await runScheduled('Recharge refund queue', () => reconcileRechargeRefunds(env))
      await runScheduled('External recharge refund queue', () => reconcileExternalRechargeRefunds(env))
      await Promise.all([
        runScheduled('Payment reconciliation queue', () => reconcilePayments(env)),
        runScheduled('Recharge reconciliation queue', () => reconcileRecharge(env)),
        runScheduled('Payout notification queue', () => retryPayoutNotifications(env)),
        runScheduled('Invoice payment reconciliation queue', () => reconcileInvoicePayments(env)),
      ])
    }
    await Promise.all([
      runScheduled('Recharge reminder queue', () => sendDueRechargeReminders(env)),
      runScheduled('Gmail fulfillment queue', () => reconcileGmail(env)),
      runScheduled('Delivery supplier queue', () => reconcileDeliverySupplier(env)),
      runScheduled('X gift fulfillment queue', () => reconcileXGift(env)),
    ])
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const transport = requireSecureTransport(request)
      return secureResponse(request, transport ?? await route(request, env))
    } catch {
      return secureResponse(request, error('服务暂时不可用，请稍后重试。', 503))
    }
  },
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      const limited = await limitApi(request, env, url.pathname)
      if (limited) return limited
    } catch {
      return error('请求保护服务暂时不可用，请稍后重试。', 503)
    }
    if (url.pathname === '/api/telegram/webhook') return telegramWebhook(request, env)
    if (url.pathname === '/api/muse/webhook') return museWebhook(request, env)
    if (url.pathname === '/api/recharge/webhook') return rechargeWebhook(request, env)
    if (url.pathname === '/api/invoices/notify/alipay') return invoiceNotification(request, env)
    const notification = url.pathname.match(/^\/api\/payments\/notify\/([a-z0-9-]+)$/)
    if (notification) return paymentNotification(request, env, notification[1])
    if (url.pathname === '/api/visitors') {
      try { return await recordVisitor(request, env) }
      catch (caught) { return error(caught instanceof ApiError ? caught.message : '统计暂不可用。', caught instanceof ApiError ? caught.status : 503) }
    }
    if (url.pathname === '/api/checkout-presence') {
      try { return await checkoutPresence(request, env) }
      catch (caught) { return error(caught instanceof ApiError ? caught.message : '下单活动统计暂不可用。', caught instanceof ApiError ? caught.status : 503) }
    }
    if (url.pathname === '/api/customer-history') {
      try { return await customerHistory(request, env) }
      catch (caught) { return error(caught instanceof ApiError ? caught.message : '历史客户展示暂不可用。', caught instanceof ApiError ? caught.status : 503) }
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/partner/') || url.pathname.startsWith('/api/orders') || url.pathname === '/api/catalog') return commerce(request, env)
    if (!['/api/interest', '/api/interest/cancel'].includes(url.pathname)) return error('未找到接口。', 404)
    if (request.method !== 'POST') return error('请通过登记表单提交。', 405)
    if (request.headers.get('Origin') !== url.origin) return error('请从本站重新打开表单。', 403)
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return error('提交格式不正确。', 415)
    try {
      // Anonymous forms have no user identifier; keep this coarse IP guard generous
      // enough for shared networks. It is abuse mitigation, not exact accounting.
      const key = `interest:${await hash(request.headers.get('CF-Connecting-IP') ?? 'local')}`
      if (!(await env.INTEREST_LIMITER.limit({ key })).success) return error('操作较频繁，请一分钟后再试。', 429)
      const reader = request.body?.getReader()
      if (!reader) return error('请填写登记信息。', 400)
      let size = 0
      const chunks: Uint8Array[] = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2048) { await reader.cancel(); return error('提交内容过长。', 413) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let body: Record<string, unknown>
      try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return error('提交格式不正确。', 400) }
      if (!body || typeof body !== 'object') return error('提交格式不正确。', 400)
      if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return error('登记凭据无效，请重新打开表单。', 400)
      const tokenHash = await hash(body.token)
      if (url.pathname === '/api/interest/cancel') {
        // Capability-based, idempotent deletion; email alone never grants access.
        await env.INTEREST_DB.prepare('DELETE FROM launch_interest WHERE token_hash = ?').bind(tokenHash).run()
        return json({ ok: true })
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('请输入有效的邮箱地址。', 400)
      if (body.product !== 'claude' && body.product !== 'grok' && body.product !== 'gmail') return error('该商品暂不支持登记。', 400)
      if (body.consent !== true) return error('请先同意邮箱使用说明。', 400)
      await env.INTEREST_DB.prepare('INSERT INTO launch_interest (id, product, email, token_hash, consent_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(crypto.randomUUID(), body.product, email, tokenHash, 'launch-interest-v1').run()
      const own = await env.INTEREST_DB.prepare('SELECT id FROM launch_interest WHERE product = ? AND email = ? AND token_hash = ?').bind(body.product, email, tokenHash).first()
      // Never return an email, row ID, or another registrant's cancellation token.
      return json({ ok: true, manageable: Boolean(own), deliveryEnabled: false })
    } catch {
      // Do not log request bodies, email addresses or cancellation capabilities.
      return error('登记服务暂时不可用，请稍后重试。', 503)
    }
}
