import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { customerFixture } from './customer-fixture.ts'
import { applyPaymentResult, findPayment } from '../worker/payments/service.ts'
import { fulfillMuse, reconcileMuse } from '../worker/muse/service.ts'
import { fulfillService, reconcileServices, sendServiceMail, expireReservations } from '../worker/fulfillment/service.ts'
import { museProducts } from '../worker/muse/client.ts'
import { signZpayParams } from '../worker/payments/zpay-protocol.ts'
import worker from '../worker/index.ts'
import { refundThroughProvider } from '../worker/payments/service.ts'
import { museWebhook } from '../worker/muse/webhook.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const content = 'private-muse@example.test----PRIVATE-PASSWORD----https://code.example.test/secret'
async function setup(t: Context, paymentProvider = 'zpay', options: { productCode?: string; deliveryContent?: string; instructions?: string } = {}) {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, { ORDER_TESTING_ENABLED: 'false', SERVICE_CHECKOUT_ENABLED: 'true', SERVICE_PAYMENT_PROVIDER: paymentProvider,
    MAPAY_PID: '10101', MAPAY_KEY: 'private-mapay-test-secret', ZPAY_PID: '2026110800000000', ZPAY_KEY: 'fixture-payment-secret', CDK_ENCRYPTION_KEY: Buffer.alloc(32, 37).toString('base64'),
    MAIL_PUBLIC_ORIGIN: 'https://shop.example.test', RESEND_API_KEY: 'mail-test-key', RESEND_FROM: 'Store <delivery@example.test>', PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid',
    MUSE_KEY_ID: 'fixture-key', MUSE_API_SECRET: 'fixture-muse-secret', MUSE_CHECKOUT_ENABLED: 'true', MUSE_ACCOUNT_PAYMENT_APPROVED: 'true' })
  const productCode = options.productCode ?? (paymentProvider === 'mapay' ? 'muse-account-31b' : 'muse_1b_pro')
  const sale = productCode === 'muse-account-31b' ? 6900 : 3500, cost = productCode === 'muse-account-31b' ? 4900 : 800
  const products = [{ code: productCode, name: 'Muse 供应商品', supply_minor: cost, enabled: true, available: true, fulfillment_type: 'account_delivery' }]
  const calls: { path: string; raw: string; headers: Headers }[] = []
  const emails: { html: string; text: string }[] = []
  let remote: Record<string, unknown> | null = null
  let remoteStatus = 'succeeded', loseCreate = false, deliveryFails = false, mismatch = false, reject = ''
  let posted = 0, assigned = 0, mapayStatus = 0
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/v1/, ''), headers = new Headers(init?.headers), raw = String(init?.body ?? '')
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(raw), { secret: 'fixture-turnstile-secret', response: 'fixture-turnstile-token' })
      return Response.json({ success: true, hostname: 'shop.example.invalid', action: 'order_create', challenge_ts: new Date().toISOString() })
    }
    if (url.hostname === 'mzf.mapay.cn') {
      assert.equal(init?.redirect,'manual')
      if (url.pathname === '/xpay/epay/mapi.php') {
        const params = new URLSearchParams(raw)
        assert.equal(init?.method, 'POST')
        assert.equal(params.get('money'), (sale / 100).toFixed(2))
        assert.equal(params.get('pid'), s.env.MAPAY_PID)
        assert.equal(params.get('sign'), signZpayParams(params, s.env.MAPAY_KEY!))
        assert.equal(params.get('notify_url'), 'https://shop.example.invalid/api/payments/notify/mapay')
        return Response.json({ code: 1, trade_no: 'mapay-fixture-trade', money: (sale / 100).toFixed(2), qrcode: 'https://qr.alipay.com/mapayfixturepayment' })
      }
      assert.equal(url.pathname,'/xpay/epay/api.php')
      return Response.json({code:1,pid:Number(s.env.MAPAY_PID),type:'alipay',out_trade_no:url.searchParams.get('out_trade_no'),money:(sale / 100).toFixed(2),status:mapayStatus,trade_no:'mapay-fixture-trade'})
    }
    if (url.hostname === 'api.resend.com') { emails.push(JSON.parse(raw)); return Response.json({ id: 'muse-mail' }) }
    assert.equal(url.origin, 'https://api.gptibo.com'); assert.equal(init?.redirect, 'manual')
    const canonical = [init?.method, url.pathname, '', headers.get('X-Timestamp'), headers.get('X-Nonce'), headers.get('X-Key-Id'), headers.get('Idempotency-Key') ?? '', createHash('sha256').update(raw).digest('hex')].join('\n')
    assert.equal(headers.get('X-Signature'), createHmac('sha256', s.env.MUSE_API_SECRET!).update(canonical).digest('hex'))
    calls.push({ path, raw, headers })
    if (path === '/products') return Response.json({ data: products })
    if (path === '/balance') return Response.json({ data: { currency: 'CNY', available_minor: 8000, frozen_minor: 0 } })
    if (path === '/preflight') return Response.json({ data: { ready: true, fulfillment_type: 'account_delivery', quantity: 1 } })
    if (path === '/orders') {
      posted++
      if (reject) return Response.json({ error: { code: reject, message: 'DO-NOT-LOG-SUPPLIER-PROSE' } }, { status: 409 })
      if (!remote) {
        const saved = JSON.parse(raw)
        remote = { id: 'ord_' + 'a'.repeat(32), merchant_order_no: saved.merchant_order_no, product_code: saved.product_code, supply_minor: saved.expected_supply_minor, fulfillment_type: 'account_delivery', status: remoteStatus }
        assigned++
      }
      if (loseCreate) throw new Error('lost create response')
      return Response.json({ data: { ...remote, status: remoteStatus } }, { status: 201 })
    }
    if (path.endsWith('/delivery')) {
      if (deliveryFails) return Response.json({ error: { code: 'delivery_unavailable' } }, { status: 503 })
      return Response.json({ data: { order_id: remote!.id, product_code: remote!.product_code, fulfillment_type: 'account_delivery', quantity: 1, content: options.deliveryContent ?? content } })
    }
    if (path.startsWith('/orders/')) {
      if (!remote) return Response.json({ error: { code: 'order_missing' } }, { status: 404 })
      return Response.json({ data: { ...remote, status: remoteStatus, ...(mismatch ? { supply_minor: 999 } : {}) } })
    }
    throw new Error('unexpected path')
  })
  const p = await s.request('/api/admin/inventory/products', { name: 'Muse', category: '账密交付', description: '交付账号资料' }, s.admin)
  const productId = (await p.json()).id
  const spec = { productId, name: 'Muse 精品手搓（API）', priceCents: sale, kind: 'muse', enabled: true, purchaseNote: '按商品说明交付。', instructions: options.instructions ?? '请妥善保存账号。', supplierCode: productCode, maxCostCents: cost }
  const r = await s.request('/api/admin/inventory/plans', spec, s.admin)
  assert.equal(r.status, 200, await r.clone().text())
  const plan = (await r.json()).id
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const create = async (key = crypto.randomUUID()) => s.request('/api/orders', { plan, key, expectedPrice: sale, email: 'buyer@example.test' }, buyer)
  const order = async () => { const r = await create(); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).order }
  const pay = async (id: string) => {
    const now = Date.now()
    s.db.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?)").run(id, paymentProvider, paymentProvider === 'mapay' ? s.env.MAPAY_PID : s.env.ZPAY_PID, sale, now + 900000, now, now)
    await applyPaymentResult(s.env, (await findPayment(s.env, id))!, { orderId: id, amountCents: sale, status: 'paid', tradeNo: 'trade_' + id })
  }
  const read = async (id: string) => (await (await s.request('/api/orders/' + id, undefined, buyer)).json()).order
  const due = (id: string) => s.db.prepare('UPDATE muse_orders SET next_attempt_at=0 WHERE order_id=?').run(id)
  const state = (id: string) => s.db.prepare('SELECT * FROM muse_orders WHERE order_id=?').get(id)!
  return { ...s, products, plan, spec, productId, calls, emails, buyer, create, order, pay, read, due, state,
    get posted() { return posted }, get assigned() { return assigned },
    controls: { paymentStatus: (v: number) => { mapayStatus = v }, lose: (v: boolean) => { loseCreate = v }, deliveryFail: (v: boolean) => { deliveryFails = v }, mismatch: (v: boolean) => { mismatch = v }, status: (v: string) => { remoteStatus = v }, reject: (v: string) => { reject = v }, forget: () => { remote = null } } }
}

test('Muse native discovery accepts actual underscore codes; checkout preflight does not purchase or send customer email', async t => {
  const s = await setup(t)
  assert.equal((await museProducts(s.env))[0].code, 'muse_1b_pro')
  const key = crypto.randomUUID(), first = await s.create(key), repeat = await s.create(key)
  assert.equal(first.status, 201); assert.equal(repeat.status, 200)
  assert.equal((await first.json()).order.id, (await repeat.json()).order.id)
  assert.equal(s.posted, 0)
  assert.doesNotMatch(JSON.stringify(s.calls), /buyer@example/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM muse_orders').get()!.n, 1)
  assert.throws(() => s.db.prepare("UPDATE muse_orders SET raw_body='{}'").run())
})

test('the two store Muse bindings are sale-ready behind the Muse gate without a purchase during checkout preparation', async t => {
  const shop = await setup(t, 'mapay')
  Object.assign(shop.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', MUSE_PAYMENT_PROVIDER: 'mapay' })
  const artisan = { code: 'muse_1b_pro', name: 'Muse 精品手搓', supply_minor: 800, enabled: true, available: true, fulfillment_type: 'account_delivery' }
  shop.products.push(artisan)
  const second = await shop.request('/api/admin/inventory/plans', { ...shop.spec, name: artisan.name, priceCents: 3500, supplierCode: artisan.code, maxCostCents: artisan.supply_minor }, shop.admin)
  assert.equal(second.status, 200)
  const artisanPlan = (await second.json()).id
  const catalog = async () => (await (await shop.request('/api/catalog')).json()).plans.filter((plan: { product_id: string }) => plan.product_id === shop.productId)
  shop.env.MUSE_CHECKOUT_ENABLED = 'false'
  assert.deepEqual((await catalog()).map((plan: { enabled: number }) => plan.enabled), [0, 0])
  assert.equal((await shop.create()).status, 409)
  assert.equal(shop.calls.length, 0)

  shop.env.MUSE_CHECKOUT_ENABLED = 'true'
  const visible = await catalog()
  assert.deepEqual(visible.map((plan: { enabled: number }) => plan.enabled), [1, 1])
  assert.doesNotMatch(JSON.stringify(visible), /muse_product_code|muse_max_cost_cents|muse_1b_pro|muse-account-31b/)
  for (const [plan, price, code, cost] of [[artisanPlan, 3500, 'muse_1b_pro', 800], [shop.plan, 6900, 'muse-account-31b', 4900]] as const) {
    const result = await shop.request('/api/orders', { plan, expectedPrice: price, key: crypto.randomUUID(), email: 'buyer@example.test' }, shop.buyer)
    assert.equal(result.status, 201, await result.clone().text())
    const created = (await result.json()).order
    assert.equal(shop.state(created.id).product_code, code)
    assert.equal(shop.state(created.id).expected_cost_cents, cost)
    assert.equal(shop.state(created.id).attempted, 0)
    const options = await shop.request(`/api/orders/${created.id}/payment`, { action: 'options' }, shop.buyer)
    assert.equal(options.status, 200)
    assert.deepEqual(await options.json(), { payment: null, methods: [{ method: 'alipay', name: '支付宝', feeBps: 0 }] })
  }
  assert.deepEqual(shop.calls.map(call => call.path), ['/products', '/balance', '/preflight', '/products', '/balance', '/preflight'])
  assert.equal(shop.posted, 0)
  assert.equal(shop.db.prepare('SELECT COUNT(*) AS count FROM payments').get()!.count, 0)
  assert.equal(shop.emails.length, 0)
})

test('confirmed payment buys once, encrypts original delivery, records actual cost and respects buyer access', async t => {
  const s = await setup(t), o = await s.order()
  await s.pay(o.id)
  await Promise.all([fulfillMuse(s.env, o.id), fulfillService(s.env, o.id)])
  await applyPaymentResult(s.env, (await findPayment(s.env, o.id))!, { orderId: o.id, amountCents: 3500, status: 'paid', tradeNo: 'trade_' + o.id })
  const result = await s.read(o.id)
  assert.equal(result.status, 'success'); assert.equal(result.delivery.value, content)
  assert.equal(result.serviceDelivery.provider, 'muse'); assert.equal(result.delivery.automatic, true)
  assert.equal(result.delivery.redemptionUrl, undefined)
  assert.equal(s.posted, 1); assert.equal(s.assigned, 1)
  assert.equal(s.db.prepare('SELECT cost_cents FROM accounting_candidates WHERE order_id=?').get(o.id)!.cost_cents, 800)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM fulfillment_tasks').all()), /PRIVATE-PASSWORD/)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM order_events').all()), /PRIVATE-PASSWORD/)
  assert.doesNotMatch(await (await s.request('/api/admin/orders', undefined, s.admin)).text(), /PRIVATE-PASSWORD/)
  const stranger = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/orders/' + o.id, undefined, stranger)).status, 404)
  await sendServiceMail(s.env, o.id)
  assert.equal((await s.read(o.id)).serviceDelivery.mailState, 'sent')
  assert.equal(s.emails.length, 1)
  assert.doesNotMatch(s.emails[0].text + s.emails[0].html, /ai\.aikm\.workers\.dev/)
})

test('lost POST result recovers by original merchant order without another purchase', async t => {
  const s = await setup(t), o = await s.order(); s.controls.lose(true)
  await s.pay(o.id)
  assert.equal(s.state(o.id).state, 'unknown'); assert.equal(s.assigned, 1)
  s.due(o.id); s.controls.lose(false)
  await fulfillMuse(s.env, o.id)
  assert.equal((await s.read(o.id)).status, 'success'); assert.equal(s.posted, 1)
  assert.ok(s.calls.some(c => c.path === '/orders/by-merchant/' + o.id))
})

test('missing original request only resubmits saved body/key; each HTTP attempt uses a fresh nonce', async t => {
  const s = await setup(t), o = await s.order()
  s.controls.lose(true); await s.pay(o.id); s.controls.forget(); s.controls.lose(false); s.due(o.id)
  await fulfillMuse(s.env, o.id)
  const posts = s.calls.filter(c => c.path === '/orders')
  assert.equal(posts.length, 2); assert.equal(posts[0].raw, posts[1].raw)
  assert.equal(posts[0].headers.get('Idempotency-Key'), posts[1].headers.get('Idempotency-Key'))
  assert.notEqual(posts[0].headers.get('X-Nonce'), posts[1].headers.get('X-Nonce'))
})

test('delivery failure, bad remote amount, supplier unknown and key rotation do not purchase again or expose data', async t => {
  const s = await setup(t), o = await s.order(); s.controls.deliveryFail(true)
  await s.pay(o.id)
  assert.equal(s.state(o.id).state, 'unknown'); assert.equal((await s.read(o.id)).delivery.value, undefined)
  s.due(o.id); s.controls.mismatch(true); await fulfillMuse(s.env, o.id)
  assert.equal(s.state(o.id).state, 'unknown'); assert.equal(s.posted, 1)
  s.controls.mismatch(false); s.controls.deliveryFail(false); s.controls.status('unknown'); s.due(o.id)
  await fulfillMuse(s.env, o.id); assert.equal(s.state(o.id).state, 'unknown')
  s.env.MUSE_KEY_ID = 'rotated-key'; s.due(o.id); const count = s.calls.length
  await fulfillMuse(s.env, o.id); assert.equal(s.calls.length, count)
  s.env.MUSE_KEY_ID = 'fixture-key'; s.controls.status('succeeded'); s.due(o.id)
  await fulfillMuse(s.env, o.id); assert.equal((await s.read(o.id)).delivery.value, content); assert.equal(s.posted, 1)
})

test('uncertain purchases block refunds and redemption stop even after the short lease expired', async t => {
  const s = await setup(t), o = await s.order(); s.controls.lose(true); await s.pay(o.id)
  const current = await s.read(o.id)
  const refund = await s.request('/api/orders/' + o.id + '/refunds', { reason: '请核对原采购单', key: crypto.randomUUID(), version: current.version }, s.buyer)
  assert.equal(refund.status, 409)
  const block = await s.request('/api/admin/orders/' + o.id + '/actions', { action: 'redemption-control', blocked: true, note: '核对采购', version: current.version }, s.admin)
  assert.equal(block.status, 409)
  assert.equal(s.db.prepare('SELECT refund_hold FROM orders WHERE id=?').get(o.id)!.refund_hold, 0)
})

test('definite supplier rejection allows original-order aftercare and never automatically buys again', async t => {
  const s = await setup(t), o = await s.order(); s.controls.reject('out_of_stock'); await s.pay(o.id)
  assert.equal(s.state(o.id).state, 'failed'); assert.equal((await s.read(o.id)).status, 'failed')
  s.due(o.id); await reconcileMuse(s.env); assert.equal(s.posted, 1)
  const current = await s.read(o.id)
  const refund = await s.request('/api/orders/' + o.id + '/refunds', { reason: '供货失败退款', key: crypto.randomUUID(), version: current.version }, s.buyer)
  assert.equal(refund.status, 201, await refund.clone().text())
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM muse_orders').all()), /DO-NOT-LOG/)
})

test('disabled gates, insufficient margin, stock and changed purchase cost fail before collecting payment', async t => {
  const s = await setup(t)
  s.env.MUSE_ACCOUNT_PAYMENT_APPROVED = 'false'; assert.equal((await s.create()).status, 409)
  s.env.MUSE_ACCOUNT_PAYMENT_APPROVED = 'true'; s.products[0].supply_minor = 801; assert.equal((await s.create()).status, 409)
  s.products[0].supply_minor = 800; s.products[0].available = false; assert.equal((await s.create()).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0); assert.equal(s.posted, 0)
})

test('refund wins before dispatch; expired unpaid order and late payment never trigger procurement', async t => {
  const s = await setup(t), o = await s.order()
  s.env.MUSE_CHECKOUT_ENABLED = 'false'; await s.pay(o.id); assert.equal(s.posted, 0)
  const current = await s.read(o.id)
  assert.equal((await s.request('/api/orders/' + o.id + '/refunds', { reason: '暂停采购退款', key: crypto.randomUUID(), version: current.version }, s.buyer)).status, 201)
  s.env.MUSE_CHECKOUT_ENABLED = 'true'; s.due(o.id); await fulfillMuse(s.env, o.id); assert.equal(s.posted, 0)
  const late = await s.order(); s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(late.id)
  await expireReservations(s.env); await s.pay(late.id); assert.equal(s.posted, 0)
})

test('supplier tasks reject manual replacement; existing mapping and old snapshots cannot be rerouted', async t => {
  const s = await setup(t), o = await s.order(); s.controls.status('running'); await s.pay(o.id)
  assert.equal((await s.request('/api/admin/inventory/orders/' + o.id, { action: 'complete', value: 'REPLACEMENT', note: 'manual', version: (await s.read(o.id)).version }, s.admin)).status, 409)
  assert.equal((await s.request('/api/admin/inventory/plans', { ...s.spec, id: s.plan, version: 0, supplierCode: 'muse-account' }, s.admin)).status, 409)
  assert.equal(s.state(o.id).product_code, 'muse_1b_pro')
})

test('delivery transaction rollback retries original receipt, never purchases another account', async t => {
  const s = await setup(t), o = await s.order()
  s.db.exec("CREATE TRIGGER fail_muse_event BEFORE INSERT ON order_events WHEN NEW.action='muse-delivered' BEGIN SELECT RAISE(ABORT,'stop'); END")
  await s.pay(o.id)
  assert.equal(s.state(o.id).state, 'unknown')
  assert.notEqual(s.db.prepare('SELECT state FROM fulfillment_tasks WHERE order_id=?').get(o.id)!.state, 'delivered')
  s.db.exec('DROP TRIGGER fail_muse_event'); s.due(o.id); await fulfillMuse(s.env, o.id)
  assert.equal((await s.read(o.id)).delivery.value, content); assert.equal(s.posted, 1)
})

test('native webhook rejects tampering and stale signatures, deduplicates and only wakes a signed original-order query', async t => {
  const s = await setup(t), o = await s.order(); s.controls.status('running'); await s.pay(o.id)
  s.env.MUSE_WEBHOOK_SECRET = 'fixture-independent-webhook-secret-32-chars'
  const id = 'evt_fixture', timestamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify({ id, type: 'order.succeeded', data: { id: s.state(o.id).remote_id, merchant_order_no: o.id, status: 'succeeded' } })
  const signature = createHmac('sha256', s.env.MUSE_WEBHOOK_SECRET).update(timestamp + '.' + id + '.' + raw).digest('hex')
  const request = (body = raw, sig = signature, ts = timestamp) => new Request('https://shop.example.invalid/api/muse/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Event-Id': id, 'X-Timestamp': ts, 'X-Signature': sig } })
  assert.equal((await museWebhook(request(raw + ' '), s.env)).status, 401)
  assert.equal((await museWebhook(request(raw, signature, '1'), s.env)).status, 400)
  assert.equal((await museWebhook(request(), s.env)).status, 200)
  assert.equal((await museWebhook(request(), s.env)).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM muse_events').get()!.n, 1)
  assert.equal(s.state(o.id).state, 'pending'); assert.equal(s.state(o.id).next_attempt_at, 0)
  assert.equal((await s.read(o.id)).status, 'processing') // Signed GET still says running.
  s.controls.status('succeeded'); s.due(o.id); await reconcileMuse(s.env)
  assert.equal((await s.read(o.id)).status, 'success'); assert.equal(s.posted, 1)
  assert.equal((await museWebhook(request(), s.env)).status, 200)
  assert.equal((await s.read(o.id)).status, 'success')
})

test('admin supplier discovery is private and the public catalog omits procurement cost and code', async t => {
  const s = await setup(t)
  assert.equal((await s.request('/api/admin/inventory/muse')).status, 401)
  const admin = await s.request('/api/admin/inventory/muse', undefined, s.admin)
  assert.equal(admin.status, 200); assert.equal((await admin.json()).products[0].supply_minor, 800)
  const catalog = await (await s.request('/api/catalog')).json()
  const plan = catalog.plans.find((p: { id: string }) => p.id === s.plan)
  assert.equal(plan.delivery_provider, 'muse'); assert.equal(plan.enabled, 1)
  assert.equal(plan.muse_product_code, undefined); assert.equal(plan.muse_max_cost_cents, undefined)
})

test('changed supplier price blocks QR creation; shared channel budget prevents excess requests', async t => {
  const s = await setup(t), o = await s.order()
  s.products[0].supply_minor = 801
  const payment = await s.request('/api/orders/' + o.id + '/payment', { action: 'create' }, s.buyer)
  assert.equal(payment.status, 409)
  assert.equal(s.db.prepare('SELECT qr FROM payments WHERE order_id=?').get(o.id)!.qr, null)
  const count = s.calls.length
  s.db.prepare("UPDATE muse_rate_limits SET used=240 WHERE bucket='all'").run()
  await assert.rejects(() => museProducts(s.env), { status: 429 })
  assert.equal(s.calls.length, count); assert.equal(s.posted, 0)
})

test('admin health reports only a safe error code and HTTP status, never upstream HTML or credentials', async t => {
  const s = await setup(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>PRIVATE-UPSTREAM-ERROR-CONTENT</html>', { status: 403 }))
  const result = await s.request('/api/admin/inventory/muse', undefined, s.admin)
  assert.equal(result.status, 503)
  const text = await result.text()
  assert.match(text, /invalid_response.*403/); assert.doesNotMatch(text, /PRIVATE-UPSTREAM|fixture-muse-secret/)
})

test('supplier redirects are refused without forwarding signed headers to another origin', async t => {
  const s = await setup(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; assert.equal(init?.redirect, 'manual')
    return new Response(null, { status: 302, headers: { Location: 'https://other.example.test/collect' } })
  })
  await assert.rejects(() => museProducts(s.env), { code: 'redirect_refused', status: 302 })
  assert.equal(calls, 1)
})


test('rotated Muse keys cannot starve current-key paid recovery behind old-key tasks', async t => {
  const s=await setup(t)
  for(let i=0;i<10;i++) {
    s.env.MUSE_CHECKOUT_ENABLED='true';const o=await s.order()
    s.env.MUSE_CHECKOUT_ENABLED='false';await s.pay(o.id);s.due(o.id)
    s.db.prepare('UPDATE muse_orders SET updated_at=1 WHERE order_id=?').run(o.id)
  }
  s.env.MUSE_CHECKOUT_ENABLED='true';s.env.MUSE_KEY_ID='rotated-fixture-key'
  s.controls.status('queued');const o=await s.order();await s.pay(o.id);s.due(o.id)
  s.db.prepare('UPDATE muse_orders SET updated_at=2 WHERE order_id=?').run(o.id)
  s.controls.status('succeeded')
  for(let i=0;i<3;i++) {await reconcileMuse(s.env);await reconcileServices(s.env)}
  const current=s.db.prepare('SELECT status FROM orders WHERE id=?').get(o.id)!
  assert.equal(current.status,'success')
  assert.equal(s.posted,1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM muse_orders WHERE key_id='fixture-key' AND attempted=0").get()!.n,10)
})


for (const [code, price, cost, asynchronous] of [['muse_1b_pro', 3500, 800, true], ['muse-account-31b', 6900, 4900, false]] as const) {
  test(`Muse ${price / 100} CNY with Mapay: checkout, confirmed payment, one purchase and private delivery`, async t => {
    const shop = await setup(t, 'mapay', { productCode: code })
    Object.assign(shop.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', MUSE_PAYMENT_PROVIDER: 'mapay', TURNSTILE_ENABLED: 'true', TURNSTILE_HOSTNAMES: 'shop.example.invalid', TURNSTILE_SITE_KEY: 'fixture-turnstile-site', TURNSTILE_SECRET_KEY: 'fixture-turnstile-secret' })
    const draft = { plan: shop.plan, key: crypto.randomUUID(), expectedPrice: price, email: 'buyer@example.test' }
    assert.equal((await shop.request('/api/orders', draft, shop.buyer)).status, 400)
    assert.equal(shop.calls.length, 0)
    const created = await shop.request('/api/orders', { ...draft, turnstileToken: 'fixture-turnstile-token' }, shop.buyer)
    assert.equal(created.status, 201, await created.clone().text())
    const { order } = await created.json()
    assert.equal(shop.state(order.id).attempted, 0)
    assert.equal(shop.state(order.id).expected_cost_cents, cost)
    const payment = await shop.request(`/api/orders/${order.id}/payment`, { action: 'create' }, shop.buyer)
    assert.equal(payment.status, 200, await payment.clone().text())
    const { payment: entry } = await payment.json()
    assert.equal(entry.provider, 'mapay')
    assert.equal(entry.qr, 'https://qr.alipay.com/mapayfixturepayment')
    assert.ok(entry.expiresAt <= Date.now() + 300000)
    assert.equal(shop.posted, 0)
    assert.equal(shop.state(order.id).attempted, 0)

    const url = 'https://shop.example.invalid/api/payments/notify/mapay'
    const amount = (price / 100).toFixed(2)
    const notify = (money = amount, signValid = true) => {
      const params = new URLSearchParams({ pid: shop.env.MAPAY_PID!, type: 'alipay', out_trade_no: order.id.slice(4), trade_no: 'mapay-fixture-trade', money, trade_status: 'TRADE_SUCCESS', sign_type: 'MD5' })
      params.set('sign', signValid ? signZpayParams(params, shop.env.MAPAY_KEY!) : '0'.repeat(32))
      return worker.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }), shop.env)
    }
    assert.equal((await notify()).status, 400)
    shop.controls.paymentStatus(1)
    assert.equal((await notify(amount, false)).status, 400)
    assert.equal((await notify('1.00')).status, 400)
    assert.equal(shop.posted, 0)
    assert.equal(shop.state(order.id).attempted, 0)
    if (asynchronous) shop.controls.status('queued')
    const replies = await Promise.all([notify(), notify()])
    assert.deepEqual(replies.map(reply => reply.status), [200, 200])
    assert.equal(shop.posted, 1)
    assert.deepEqual(JSON.parse(shop.calls.find(call => call.path === '/orders')!.raw), { merchant_order_no: order.id, product_code: code, expected_supply_minor: cost })

    if (asynchronous) {
      assert.ok(!shop.calls.some(call => call.path.endsWith('/delivery')))
      shop.controls.status('succeeded')
      shop.due(order.id)
      await reconcileMuse(shop.env)
      assert.ok(shop.calls.some(call => call.path === '/orders/' + shop.state(order.id).remote_id))
    }
    assert.equal(shop.posted, 1)
    assert.equal(shop.assigned, 1)
    assert.equal(shop.state(order.id).actual_cost_cents, cost)
    const delivered = await shop.read(order.id)
    assert.equal(delivered.status, 'success')
    assert.equal(delivered.serviceDelivery.provider, 'muse')
    assert.equal(delivered.delivery.value, content)
    assert.doesNotMatch(JSON.stringify(shop.db.prepare('SELECT encrypted_value FROM fulfillment_tasks WHERE order_id=?').get(order.id)), /PRIVATE-PASSWORD/)
    await sendServiceMail(shop.env, order.id)
    assert.equal((await shop.read(order.id)).serviceDelivery.mailState, 'sent')
    assert.equal(shop.emails.length, 1)
    shop.env.MUSE_PAYMENT_PROVIDER = 'zpay'
    assert.equal((await notify()).status, 200)
    assert.equal(shop.posted, 1)
    const current = shop.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id) as any
    current.refund_hold = 1
    assert.equal(await refundThroughProvider(shop.env, current, 'fixture-refund', price), null)
  })
}

test('extra GPTibo SKUs (接码 / ChatGPT 成品号) open only by exact code and never by the Muse gate', async t => {
  const s = await setup(t, 'zpay', { productCode: 'gpt-plus-account' })
  s.products.push({ code: 'grok-us-plus-monthly', name: '未开放', supply_minor: 1, enabled: true, available: true, fulfillment_type: 'account_delivery' },
    { code: 'codex-sms-once', name: '接码', supply_minor: 200, enabled: true, available: true, fulfillment_type: 'account_delivery' })
  assert.deepEqual((await museProducts(s.env)).map(p => p.code), ['gpt-plus-account', 'codex-sms-once'])
  const catalogEnabled = async () => (await (await s.request('/api/catalog')).json()).plans.find((p: { id: string }) => p.id === s.plan)?.enabled
  // Muse switches alone do not open a non-Muse SKU.
  assert.equal((await s.create()).status, 409); assert.equal(await catalogEnabled(), 0)
  s.env.GPTIBO_SUPPLY_ENABLED = 'codex-sms-once'; assert.equal((await s.create()).status, 409)
  s.env.GPTIBO_SUPPLY_ENABLED = 'codex-sms-once, gpt-plus-account'; s.env.MUSE_CHECKOUT_ENABLED = 'false'
  assert.equal(await catalogEnabled(), 1)
  const listed = (await (await s.request('/api/catalog')).json()).plans.find((p: { id: string }) => p.id === s.plan)
  assert.equal(listed.supply_kind, 'gpt-account'); assert.equal(listed.muse_product_code, undefined); assert.equal(listed.muse_max_cost_cents, undefined)
  const o = await s.order()
  // Uses the normal service payment route, not the Muse route (whose credentials are missing here).
  Object.assign(s.env, { MUSE_PAYMENT_PROVIDER: 'mapay', MAPAY_KEY: undefined })
  const options = await (await s.request(`/api/orders/${o.id}/payment`, { action: 'options' }, s.buyer)).json()
  assert.ok(options.methods.length > 0)
  await s.pay(o.id)
  const result = await s.read(o.id)
  assert.equal(result.status, 'success'); assert.equal(result.delivery.value, content); assert.equal(s.posted, 1)
  assert.equal(s.db.prepare("SELECT note FROM order_events WHERE order_id=? AND action='service-dispatch'").get(o.id)!.note, '付款已确认，等待原订单自动采购')
  assert.equal(JSON.parse(s.calls.find(c => c.path === '/orders')!.raw).product_code, 'gpt-plus-account')
  // Closing the SKU stops new purchases without touching delivered orders.
  s.env.GPTIBO_SUPPLY_ENABLED = 'codex-sms-once'; assert.equal((await s.create()).status, 409)
  assert.equal((await s.read(o.id)).delivery.value, content)
})

test('admin refuses supplier codes outside Muse and the explicit GPTibo allow-list', async t => {
  const s = await setup(t)
  for (const supplierCode of ['grok-us-plus-monthly', 'gpt-plus', 'codex-sms-once-x', '']) {
    const r = await s.request('/api/admin/inventory/plans', { ...s.spec, supplierCode }, s.admin)
    assert.equal(r.status, 400, supplierCode)
  }
  const ok = await s.request('/api/admin/inventory/plans', { ...s.spec, supplierCode: 'codex-sms-once', maxCostCents: 300 }, s.admin)
  assert.equal(ok.status, 200, await ok.clone().text())
})

test('Codex SMS delivery mail uses the new redemption site with or without a legacy address', async t => {
  for (const withLegacyAddress of [true, false]) {
    await t.test(withLegacyAddress ? 'replace old address in the email' : 'add missing redemption link', async t => {
      const cdk = 'CODEX-SMS-FIXTURE'
      const deliveryContent = withLegacyAddress ? cdk + '\n兑换：https://sms.llvi.de/' : cdk + '\n辅助说明：https://ai.aikm.workers.dev/guide'
      const instructions = withLegacyAddress ? '前往sms.llvi.de兑换。' : '请妥善保管兑换码。'
      const s = await setup(t, 'zpay', { productCode: 'codex-sms-once', deliveryContent, instructions })
      s.env.GPTIBO_SUPPLY_ENABLED = 'codex-sms-once'
      const order = await s.order()
      assert.equal((await s.read(order.id)).delivery.redemptionUrl, undefined)
      await s.pay(order.id)
      await sendServiceMail(s.env, order.id)
      assert.equal(s.posted, 1)
      assert.equal(s.emails.length, 1)
      assert.match(s.emails[0].text, /https:\/\/ai\.aikm\.workers\.dev\//)
      assert.match(s.emails[0].html, /href="https:\/\/ai\.aikm\.workers\.dev\/"/)
      assert.match(s.emails[0].text, /CODEX-SMS-FIXTURE/)
      if (!withLegacyAddress) {
        assert.match(s.emails[0].text, /接码兑换：https:\/\/ai\.aikm\.workers\.dev\/\n/)
        assert.match(s.emails[0].html, /辅助说明：https:\/\/ai\.aikm\.workers\.dev\/guide/)
      }
      assert.match(s.emails[0].text, /订单查询：https:\/\/shop\.example\.test\/orders/)
      assert.doesNotMatch(s.emails[0].text + s.emails[0].html, /sms\.llvi\.de/)
      const delivered = await s.read(order.id)
      assert.equal(delivered.delivery.value, deliveryContent)
      assert.equal(delivered.delivery.instructions, instructions)
      assert.equal(delivered.delivery.redemptionUrl, 'https://ai.aikm.workers.dev/')
    })
  }
})
