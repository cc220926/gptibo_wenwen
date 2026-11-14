import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { customerFixture } from './customer-fixture.ts'
import { applyPaymentResult, findPayment } from '../worker/payments/service.ts'
import { sendDueOpsNotifications } from '../worker/ops-notifications.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const feishu = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook-0001'
const wecom = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-0001'

async function setup(t: Context, kind = 'manual') {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, { ORDER_TESTING_ENABLED: 'false', SERVICE_CHECKOUT_ENABLED: 'true', CDK_ENCRYPTION_KEY: Buffer.alloc(32, 37).toString('base64'), MAIL_PUBLIC_ORIGIN: 'https://mail-store.example.test', RESEND_API_KEY: 'test-mail-key', RESEND_FROM: 'Store <delivery@example.test>', PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid', ALIPAY_APP_ID: '2026000000000000', ALIPAY_SELLER_ID: '2088000000000000', ALIPAY_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), ALIPAY_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  const product = await s.request('/api/admin/inventory/products', { name: 'Plus 成品号', category: 'AI 订阅', description: '人工交付' }, s.admin)
  const productId = (await product.json()).id
  const created = await s.request('/api/admin/inventory/plans', { productId, name: '1 个月', priceCents: 8500, kind, enabled: true, purchaseNote: '付款后人工交付', instructions: '请查收。' }, s.admin)
  assert.equal(created.status, 200, await created.clone().text())
  const plan = (await created.json()).id
  if (kind === 'stock') assert.equal((await s.request(`/api/admin/inventory/${plan}/stock`, { action: 'import', values: 'PRIVATE-CODE-1\nPRIVATE-CODE-2', costCents: 1 }, s.admin)).status, 201)
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const order = async () => { const r = await s.request('/api/orders', { plan, key: crypto.randomUUID(), expectedPrice: 8500, email: 'member@example.test' }, buyer); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).order }
  const pay = async (id: string) => {
    const now = Date.now()
    s.db.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,state,expires_at,created_at,updated_at) VALUES(?,'alipay',?,8500,'pending',?,?,?)").run(id, s.env.ALIPAY_APP_ID + ':' + s.env.ALIPAY_SELLER_ID, now + 900000, now, now)
    await applyPaymentResult(s.env, (await findPayment(s.env, id))!, { orderId: id, amountCents: 8500, status: 'paid', tradeNo: 'trade_' + id })
  }
  const read = async (id: string) => (await (await s.request('/api/orders/' + id, undefined, buyer)).json()).order
  return { ...s, buyer, order, pay, read }
}
function mockPush(t: Context, replies: { wecom?: () => unknown } = {}) {
  const calls: { url: string; body: string; headers: Headers }[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input), body = String(init.body ?? ''), headers = new Headers(init.headers)
    calls.push({ url, body, headers })
    if (url.startsWith(feishu)) return Response.json({ code: 0, msg: 'success' })
    if (url.startsWith('https://qyapi.weixin.qq.com/')) return Response.json(replies.wecom?.() ?? { errcode: 0, errmsg: 'ok' })
    if (url.includes('sctapi.ftqq.com') || url.includes('push.ft07.com')) return Response.json({ code: 0, message: '' })
    if (url === 'https://api.resend.com/emails') return Response.json({ id: 'mail_ops_test' })
    return Response.json({ code: -1 }, { status: 500 })
  })
  return calls
}

test('admin alert bar: manual queue and refund versions grow with new work; tickets are reported unavailable on Workers', async t => {
  const s = await setup(t)
  assert.deepEqual(await (await s.request('/api/admin/tickets/notifications', undefined, s.admin)).json(), { version: 0, pending: 0, available: false })
  assert.equal((await s.request('/api/admin/inventory/manual/notifications')).status, 401)
  const manual = async () => (await s.request('/api/admin/inventory/manual/notifications', undefined, s.admin)).json()
  const refunds = async () => (await s.request('/api/admin/refunds/notifications', undefined, s.admin)).json()
  assert.deepEqual(await manual(), { version: 0, pending: 0 })
  const order = await s.order()
  assert.deepEqual(await manual(), { version: 0, pending: 0 }, 'unpaid orders are not work yet')
  await s.pay(order.id)
  assert.deepEqual(await manual(), { version: 1, pending: 1 })
  const current = await s.read(order.id)
  assert.equal((await s.request(`/api/admin/inventory/orders/${order.id}`, { action: 'complete', version: current.version, value: 'ACCOUNT-DATA', note: '已交付' }, s.admin)).status, 200)
  assert.deepEqual(await manual(), { version: 1, pending: 0 })
  assert.deepEqual(await refunds(), { version: 0, pending: 0 })
  const done = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), reason: '无法登录', version: done.version }, s.buyer)).status, 201)
  assert.deepEqual(await refunds(), { version: 1, pending: 1 })
})

test('paid orders and refund requests push once to every configured channel, flag manual delivery, and carry no customer data', async t => {
  const s = await setup(t)
  const calls = mockPush(t)
  Object.assign(s.env, { OPS_NOTIFICATIONS_SINCE: new Date(Date.now() - 3600_000).toISOString(), FEISHU_WEBHOOK_URL: feishu, FEISHU_WEBHOOK_SECRET: 'feishu-sign-secret', WECOM_WEBHOOK_URL: wecom, SERVERCHAN_SENDKEY: 'SCT1234567890abc', OPS_NOTIFY_EMAIL: 'true' })
  const order = await s.order(); await s.pay(order.id)
  const before = calls.length
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 4, failed: 0 })
  const sent = calls.slice(before)
  const toFeishu = sent.find(c => c.url === feishu)!, toWecom = sent.find(c => c.url === wecom)!, toServerchan = sent.find(c => c.url === 'https://sctapi.ftqq.com/SCT1234567890abc.send')!, toMail = sent.find(c => c.url === 'https://api.resend.com/emails')!
  for (const call of [toFeishu, toWecom, toServerchan, toMail]) {
    assert.ok(call, 'every channel is called')
    const text = call.url === 'https://sctapi.ftqq.com/SCT1234567890abc.send' ? new URLSearchParams(call.body).get('desp')! : call.body
    assert.match(text, new RegExp(order.id))
    assert.match(text, /需人工交付/)
    assert.match(text, /¥85\.00/)
    assert.doesNotMatch(text, /member@example\.test|ACCOUNT-DATA|trade_/)
  }
  // Feishu custom bot signature: HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message.
  const feishuBody = JSON.parse(toFeishu.body)
  assert.equal(feishuBody.sign, createHmac('sha256', feishuBody.timestamp + '\nfeishu-sign-secret').update('').digest('base64'))
  assert.equal(JSON.parse(toWecom.body).msgtype, 'text')
  assert.match(new URLSearchParams(toServerchan.body).get('title')!, /新订单已付款（需人工交付）/)
  assert.deepEqual(JSON.parse(toMail.body).to, ['admin@example.invalid'])
  // Already-sent alerts are never repeated.
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 0, failed: 0 })
  // A customer refund request is pushed as its own alert.
  const current = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), reason: '暂不需要', version: current.version }, s.buyer)).status, 201)
  const mark = calls.length
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 4, failed: 0 })
  assert.match(calls.slice(mark).find(c => c.url === feishu)!.body, /新售后申请/)
})

test('push alerts never replay history, retry failures with backoff, and retire rows of removed channels', async t => {
  const s = await setup(t, 'stock')
  let wecomFails = true
  const calls = mockPush(t, { wecom: () => wecomFails ? { errcode: 93000, errmsg: 'invalid webhook' } : { errcode: 0 } })
  Object.assign(s.env, { WECOM_WEBHOOK_URL: wecom, FEISHU_WEBHOOK_URL: feishu })
  const early = await s.order(); await s.pay(early.id)
  // Not activated: nothing is discovered or sent.
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: false, sent: 0, failed: 0 })
  // Activated after that payment: the earlier event is history and stays silent.
  s.env.OPS_NOTIFICATIONS_SINCE = new Date(Date.now() + 1000).toISOString()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 0, failed: 0 })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM ops_notifications').get()!.n, 0)
  // A newly paid stock order: Feishu succeeds, WeCom fails and is retried later.
  const order = await s.order(); await s.pay(order.id)
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 1, failed: 1 })
  assert.match(calls.find(c => c.url === feishu)!.body, /自有库存自动交付/)
  const retry = s.db.prepare("SELECT status,attempt_count,next_attempt_at,last_error FROM ops_notifications WHERE channel='wecom'").get()!
  assert.equal(retry.status, 'pending'); assert.equal(retry.attempt_count, 1); assert.equal(retry.last_error, 'wecom rejected')
  assert.ok(Number(retry.next_attempt_at) > Date.now() + 50_000)
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 0, failed: 0 }, 'backoff is respected')
  wecomFails = false
  s.db.exec("UPDATE ops_notifications SET next_attempt_at=0 WHERE channel='wecom'")
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 1, failed: 0 })
  // Removing a channel retires its pending rows instead of retrying forever.
  const another = s.db.prepare("SELECT id FROM ops_notifications WHERE channel='wecom'").get()!.id as string
  s.db.prepare("UPDATE ops_notifications SET status='pending',next_attempt_at=0 WHERE id=?").run(another)
  delete s.env.WECOM_WEBHOOK_URL
  await sendDueOpsNotifications(s.env)
  assert.deepEqual({ ...s.db.prepare('SELECT status,last_error FROM ops_notifications WHERE id=?').get(another) }, { status: 'failed', last_error: 'channel disabled' })
})

test('admin test push reports each configured channel and malformed settings stay disabled', async t => {
  const s = await setup(t)
  mockPush(t)
  assert.equal((await s.request('/api/admin/ops-notifications', {}, s.admin)).status, 409)
  Object.assign(s.env, { FEISHU_WEBHOOK_URL: 'https://evil.example.test/open-apis/bot/v2/hook/abcdefgh', WECOM_WEBHOOK_URL: wecom, SERVERCHAN_SENDKEY: 'sctp123t' + 'a'.repeat(20) })
  assert.deepEqual(await (await s.request('/api/admin/ops-notifications', undefined, s.admin)).json(), { channels: ['wecom', 'serverchan'], active: false })
  assert.deepEqual(await (await s.request('/api/admin/ops-notifications', {}, s.admin)).json(), { results: { wecom: 'sent', serverchan: 'sent' }, active: false })
  assert.equal((await s.request('/api/admin/ops-notifications', {})).status, 401)
})

test('without a webhook, Feishu alerts reuse the existing app bot with an idempotent uuid', async t => {
  const s = await setup(t)
  const calls: { url: string; body: string }[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, body: String(init.body ?? '') })
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't-test' })
    if (url.includes('/im/v1/messages')) return Response.json({ code: 0 })
    return Response.json({}, { status: 500 })
  })
  Object.assign(s.env, { OPS_NOTIFICATIONS_SINCE: new Date(Date.now() - 60_000).toISOString(), FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'app-secret', FEISHU_PAYOUT_RECIPIENT: 'ou_payoutowner', FEISHU_ORDER_RECIPIENT: 'oc_ordergroup' })
  const order = await s.order(); await s.pay(order.id)
  assert.deepEqual(await sendDueOpsNotifications(s.env), { configured: true, sent: 1, failed: 0 })
  const message = calls.find(c => c.url.includes('/im/v1/messages'))!
  assert.match(message.url, /receive_id_type=chat_id/)
  const body = JSON.parse(message.body)
  assert.equal(body.receive_id, 'oc_ordergroup')
  assert.ok(body.uuid.startsWith('ymx-ops-') && body.uuid.length <= 50)
  assert.match(JSON.parse(body.content).text, /需人工交付/)
})
