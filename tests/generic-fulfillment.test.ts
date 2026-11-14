import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { customerFixture } from './customer-fixture.ts'
import { applyPaymentResult, findPayment, reconcileOverdueReservations } from '../worker/payments/service.ts'
import { expireReservations, fulfillService, reconcileServices, sendServiceMail } from '../worker/fulfillment/service.ts'
import { signZpayParams } from '../worker/payments/zpay-protocol.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
async function setup(t: Context, kind = 'stock', codes = ['PRIVATE-CODE-1', 'PRIVATE-CODE-2']) {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, { ORDER_TESTING_ENABLED: 'false', SERVICE_CHECKOUT_ENABLED: 'true', CDK_ENCRYPTION_KEY: Buffer.alloc(32, 37).toString('base64'), MAIL_PUBLIC_ORIGIN: 'https://mail-store.example.test', RESEND_API_KEY: 'test-mail-key', RESEND_FROM: 'Store <delivery@example.test>', PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid', ALIPAY_APP_ID: '2026000000000000', ALIPAY_SELLER_ID: '2088000000000000', ALIPAY_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), ALIPAY_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  const product = await s.request('/api/admin/inventory/products', { name: '独立软件', category: '工具服务', description: '适用范围说明' }, s.admin)
  assert.equal(product.status, 200, await product.clone().text())
  const productId = (await product.json()).id
  const spec = { productId, name: '月卡', priceCents: 1000, kind, enabled: true, purchaseNote: '购买前确认适用范围', instructions: '请按说明兑换。' }
  const created = await s.request('/api/admin/inventory/plans', spec, s.admin)
  assert.equal(created.status, 200, await created.clone().text())
  const plan = (await created.json()).id
  const stockPath = `/api/admin/inventory/${plan}/stock`
  const importCodes = (values: string[]) => s.request(stockPath, { action: 'import', values: values.join('\n'), costCents: 123 }, s.admin)
  if (kind === 'stock' && codes.length) assert.equal((await importCodes(codes)).status, 201)
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const create = async (key = crypto.randomUUID()) => s.request('/api/orders', { plan, key, expectedPrice: 1000, email: 'member@example.test' }, buyer)
  const order = async () => { const r = await create(); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).order }
  const pay = async (id: string) => {
    const now = Date.now()
    s.db.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,state,expires_at,created_at,updated_at) VALUES(?,'alipay',?,1000,'pending',?,?,?)").run(id, s.env.ALIPAY_APP_ID + ':' + s.env.ALIPAY_SELLER_ID, now + 900000, now, now)
    const payment = (await findPayment(s.env, id))!
    await applyPaymentResult(s.env, payment, { orderId: id, amountCents: 1000, status: 'paid', tradeNo: 'trade_' + id })
    return payment
  }
  const read = async (id: string, cookie = buyer) => (await (await s.request('/api/orders/' + id, undefined, cookie)).json()).order
  return { ...s, plan, productId, spec, buyer, create, order, pay, read, stockPath, importCodes }
}

test('catalog is database driven and stock import is encrypted, atomic, deduplicated and admin-only', async t => {
  const s = await setup(t)
  const catalog = await (await s.request('/api/catalog')).json()
  const plan = catalog.plans.find((p: { id: string }) => p.id === s.plan)
  assert.equal(plan.product_name, '独立软件'); assert.equal(plan.category, '工具服务'); assert.equal(plan.enabled, 1); assert.equal(plan.stock_available, 2)
  assert.equal((await s.request('/api/admin/inventory')).status, 401)
  assert.equal((await s.request(s.stockPath, { action: 'import', values: 'NEW', costCents: 0 }, s.admin, 'https://evil.test')).status, 403)
  assert.equal((await s.importCodes(['NEW-CODE', 'PRIVATE-CODE-1'])).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cdk_stock').get()!.n, 2)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM cdk_stock').all()), /PRIVATE-CODE/)
  assert.doesNotMatch(JSON.stringify(await (await s.request(s.stockPath, undefined, s.admin)).json()), /encrypted|fingerprint|PRIVATE-CODE/)
  s.env.CDK_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString('base64')
  assert.equal((await s.importCodes(['NEW-CODE'])).status, 503)
  assert.equal((await s.create()).status, 409)
})

test('hiding a self-owned product removes every plan from the storefront and blocks new orders', async t => {
  const s = await setup(t)
  const existing = await s.order()
  const path = '/api/admin/inventory/products/visibility'
  const change = (hidden: boolean, version: number, cookie = s.admin) => s.request(path, { id: s.productId, hidden, version }, cookie)
  assert.equal((await change(true, 0, s.buyer)).status, 401)
  assert.equal((await change(true, 0)).status, 200)
  assert.equal((await change(false, 0)).status, 409)
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.plans.some((plan: { id: string }) => plan.id === s.plan), false)
  assert.equal((await s.create()).status, 409)
  assert.equal((await s.read(existing.id)).id, existing.id)
  const admin = await (await s.request('/api/admin/inventory', undefined, s.admin)).json()
  assert.equal(admin.products.find((product: { id: string }) => product.id === s.productId).hidden, 1)
  assert.equal(admin.plans.some((plan: { id: string }) => plan.id === s.plan), true)
  assert.equal((await change(false, 1)).status, 200)
  const restored = await (await s.request('/api/catalog')).json()
  assert.equal(restored.plans.some((plan: { id: string }) => plan.id === s.plan), true)
  assert.equal((await s.create()).status, 201)
})

test('last unit is reserved atomically, duplicate requests reuse it, unpaid buyers cannot read it', async t => {
  const s = await setup(t, 'stock', ['LAST-PRIVATE-CODE'])
  const key = crypto.randomUUID()
  const responses = await Promise.all([s.create(key), s.create(key), s.create()])
  assert.equal(responses.filter(r => r.status === 201).length, 2)
  assert.equal(responses.filter(r => r.status === 409).length, 1)
  const successful = await Promise.all(responses.filter(r => r.status === 201).map(r => r.json()))
  assert.equal(successful[0].order.id, successful[1].order.id)
  assert.doesNotMatch(JSON.stringify(successful), /LAST-PRIVATE-CODE/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM cdk_stock WHERE state='reserved'").get()!.n, 1)
})

test('verified payment delivers exactly one code, hides it from other buyers, lists and audit logs, and preserves unit cost', async t => {
  const s = await setup(t), order = await s.order(), payment = await s.pay(order.id)
  await applyPaymentResult(s.env, payment, { orderId: order.id, amountCents: 1000, status: 'paid', tradeNo: 'trade_' + order.id })
  await Promise.all([fulfillService(s.env, order.id), fulfillService(s.env, order.id)])
  const result = await s.read(order.id)
  assert.equal(result.status, 'success'); assert.match(result.delivery.value, /PRIVATE-CODE/)
  assert.equal(result.serviceDelivery.state, 'delivered')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM cdk_stock WHERE state='delivered'").get()!.n, 1)
  const other = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/orders/' + order.id, undefined, other)).status, 404)
  assert.doesNotMatch(await (await s.request('/api/admin/orders', undefined, s.admin)).text(), /PRIVATE-CODE/)
  const detail = await (await s.request('/api/admin/orders/' + order.id, undefined, s.admin)).json()
  assert.equal(detail.order.delivery.value, result.delivery.value)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM order_events').all()), /PRIVATE-CODE/)
  assert.equal(s.db.prepare('SELECT cost_cents FROM accounting_candidates WHERE order_id=?').get(order.id)!.cost_cents, 123)
  assert.throws(() => s.db.prepare("UPDATE cdk_stock SET state='available',order_id=NULL WHERE order_id=?").run(order.id))
})

test('failed audit rolls back dispatch and original reservation is recoverable without changing payment', async t => {
  const s = await setup(t), order = await s.order()
  s.db.exec("CREATE TRIGGER fail_dispatch BEFORE INSERT ON order_events WHEN NEW.action='service-dispatch' BEGIN SELECT RAISE(ABORT,'stop'); END")
  await s.pay(order.id)
  assert.equal(s.db.prepare('SELECT payment_status FROM orders WHERE id=?').get(order.id)!.payment_status, 'paid')
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock WHERE order_id=?').get(order.id)!.state, 'reserved')
  s.db.exec('DROP TRIGGER fail_dispatch')
  await fulfillService(s.env, order.id)
  assert.equal((await s.read(order.id)).status, 'success')
})

test('expired unpayable reservations release stock; pending gateway trades retain it; late receipts enter review', async t => {
  const s = await setup(t, 'stock', ['ONLY-CODE']), first = await s.order()
  s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(first.id)
  await expireReservations(s.env)
  assert.equal((await s.read(first.id)).status, 'cancelled')
  const second = await s.order()
  await s.pay(first.id)
  assert.equal((await s.read(first.id)).serviceDelivery.state, 'review')
  assert.equal((await s.read(first.id)).delivery.value, undefined)
  assert.equal(s.db.prepare('SELECT order_id FROM cdk_stock').get()!.order_id, second.id)
  const now = Date.now()
  s.db.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,expires_at,created_at,updated_at) VALUES(?,'alipay','fixture',1000,0,?,?)").run(second.id, now, now)
  s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(second.id)
  await expireReservations(s.env)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock').get()!.state, 'reserved')
  s.db.prepare("UPDATE payments SET state='closed' WHERE order_id=?").run(second.id)
  await expireReservations(s.env)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock').get()!.state, 'available')
})

test('mail failure retries identical encrypted payload and key, concurrent sends serialize, expiry stops retries', async t => {
  const s = await setup(t), order = await s.order(); await s.pay(order.id)
  const sent: { body: string; key: string | null }[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') })
    if (sent.length === 1) throw new Error('lost response')
    return Response.json({ id: 'mail_accepted' })
  })
  await sendServiceMail(s.env, order.id)
  assert.equal((await s.read(order.id)).status, 'success')
  s.env.RESEND_FROM = 'Changed <changed@example.test>'
  await Promise.all([sendServiceMail(s.env, order.id), sendServiceMail(s.env, order.id)])
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1])
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM fulfillment_tasks').all()), /PRIVATE-CODE|member@example/)
  assert.equal((await s.read(order.id)).serviceDelivery.mailState, 'sent')
  s.db.prepare("UPDATE fulfillment_tasks SET mail_state='pending',mail_first_attempt_at=0 WHERE order_id=?").run(order.id)
  await sendServiceMail(s.env, order.id)
  assert.equal(sent.length, 2); assert.equal((await s.read(order.id)).serviceDelivery.mailState, 'review')
})

test('partial refund retains a completed stock delivery and its pending email; full refund hides it', async t => {
  const s = await setup(t, 'stock', ['PARTIAL-REFUND-CODE'])
  const order = await s.order()
  await s.pay(order.id)
  s.db.prepare('UPDATE orders SET refunded_cents=100 WHERE id=?').run(order.id)
  const partiallyRefunded = await s.read(order.id)
  assert.equal(partiallyRefunded.status, 'success')
  assert.equal(partiallyRefunded.delivery.value, 'PARTIAL-REFUND-CODE')
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  let sent = 0
  t.mock.method(globalThis, 'fetch', async () => { sent++; return Response.json({ id: 'partial_refund_mail' }) })
  await reconcileServices(s.env)
  assert.equal(sent, 1)
  s.db.prepare('UPDATE orders SET refunded_cents=1000 WHERE id=?').run(order.id)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
})

test('manual delivery uses the same order/payment/task model and cannot complete unpaid, stale or refunded orders', async t => {
  const s = await setup(t, 'manual'), order = await s.order(), path = `/api/admin/inventory/orders/${order.id}`
  const complete = (version: number) => s.request(path, { action: 'complete', version, value: 'PRIVATE-RESULT', note: '已完成约定服务' }, s.admin)
  assert.equal((await complete(order.version)).status, 409)
  await s.pay(order.id)
  assert.equal((await complete(order.version)).status, 409)
  const current = await s.read(order.id)
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  assert.equal((await complete(current.version)).status, 409)
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'manual_mail' }))
  assert.equal((await complete(current.version)).status, 200)
  assert.equal((await s.read(order.id)).delivery.value, 'PRIVATE-RESULT')
  const otherBuyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/orders/' + order.id, undefined, otherBuyer)).status, 404)
  s.db.prepare('UPDATE orders SET refunded_cents=1000 WHERE id=?').run(order.id)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
})

test('plan edits do not reroute existing tasks or mutate purchase snapshots; unknown adapters cannot be enabled', async t => {
  const s = await setup(t), order = await s.order()
  const edit = { ...s.spec, id: s.plan, version: 0, name: '年卡', instructions: '新的说明', priceCents: 2000 }
  assert.equal((await s.request('/api/admin/inventory/plans', { ...edit, kind: 'sms' }, s.admin)).status, 400)
  assert.equal((await s.request('/api/admin/inventory/plans', { ...edit, kind: 'manual' }, s.admin)).status, 409)
  assert.equal((await s.request('/api/admin/inventory/plans', edit, s.admin)).status, 200)
  await s.pay(order.id)
  const result = await s.read(order.id)
  assert.equal(result.planName, '月卡'); assert.equal(result.price, 10); assert.equal(result.delivery.instructions, '请按说明兑换。')
})

test('refund hold and redemption stop prevent dispatch; cron resumes the same unit once cleared', async t => {
  const s = await setup(t), order = await s.order()
  s.db.prepare('UPDATE orders SET redemption_blocked=1 WHERE id=?').run(order.id)
  await s.pay(order.id)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock WHERE order_id=?').get(order.id)!.state, 'reserved')
  s.db.prepare('UPDATE orders SET redemption_blocked=0,refund_hold=1 WHERE id=?').run(order.id)
  await fulfillService(s.env, order.id)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock WHERE order_id=?').get(order.id)!.state, 'reserved')
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'cron_mail' }))
  await reconcileServices(s.env)
  assert.equal((await s.read(order.id)).serviceDelivery.mailState, 'sent')
})

test('100-code imports stay below 100 bound parameters per statement and avoid per-code database reads', async t => {
  const s = await setup(t, 'stock', [])
  let queries = 0
  const original = s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB, 'prepare', (sql: string) => {
    queries++
    const statement = original(sql), bind = statement.bind.bind(statement)
    statement.bind = (...values) => { assert.ok(values.length <= 100, 'D1 parameter budget'); return bind(...values) }
    return statement
  })
  assert.equal((await s.importCodes(Array.from({ length: 100 }, (_, i) => 'BULK-' + i))).status, 201)
  assert.ok(queries < 30, `bulk import used ${queries} statements`)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cdk_stock').get()!.n, 100)
})

test('signed payment flow checks original amount and delivers after query, not QR creation', async t => {
  const s = await setup(t), order = await s.order(), path = `/api/orders/${order.id}/payment`
  let wrongAmount = true
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body))), biz = JSON.parse(params.biz_content)
    let result: Record<string, unknown>
    if (params.method === 'alipay.trade.precreate') {
      assert.equal(biz.total_amount, '10.00'); assert.doesNotMatch(biz.subject, /ChatGPT/)
      result = { code: '10000', out_trade_no: order.id, qr_code: 'https://qr.alipay.com/fixture' }
    } else result = { code: '10000', out_trade_no: order.id, total_amount: wrongAmount ? '0.01' : '10.00', seller_id: s.env.ALIPAY_SELLER_ID, trade_status: 'TRADE_SUCCESS', trade_no: 'trade_signed' }
    const raw = JSON.stringify(result)
    return new Response(`{"${params.method.replaceAll('.', '_')}_response":${raw},"sign":"${sign('RSA-SHA256', Buffer.from(raw), keys.privateKey).toString('base64')}"}`)
  })
  assert.equal((await s.request(path, { action: 'options' }, s.buyer)).status, 200)
  assert.equal((await s.request(path, { action: 'create' }, s.buyer)).status, 200)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
  assert.equal((await s.request(path, { action: 'query' }, s.buyer)).status, 503)
  assert.equal((await s.read(order.id)).paymentStatus, 'unpaid')
  wrongAmount = false
  assert.equal((await s.request(path, { action: 'query' }, s.buyer)).status, 200)
  assert.equal((await s.read(order.id)).status, 'success')
})

test('ZPAY stock checkout verifies a paid callback before releasing the reserved code', async t => {
  const s = await setup(t)
  const pid = '202600000001', key = 'local-test-key-keep-private'
  Object.assign(s.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: pid, ZPAY_KEY: key, ALIPAY_APP_ID: undefined, ALIPAY_SELLER_ID: undefined, ALIPAY_APP_PRIVATE_KEY: undefined, ALIPAY_PUBLIC_KEY: undefined })
  const order = await s.order(), path = `/api/orders/${order.id}/payment`
  const created = await s.request(path, { action: 'create' }, s.buyer)
  assert.equal(created.status, 200, await created.clone().text())
  const payment = (await created.json()).payment
  assert.equal(payment.provider, 'zpay')
  assert.equal(new URL(payment.qr).origin, 'https://zpayz.cn')
  assert.equal((await s.read(order.id)).delivery.value, undefined)
  let paid = false
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://zpayz.cn')
    assert.equal(url.searchParams.get('key'), key)
    return Response.json({ code: 1, pid, out_trade_no: order.id.slice(4), type: 'alipay', money: '10.00', status: paid ? 1 : 0, trade_no: '2026000000001' })
  })
  const params = new URLSearchParams({ pid, type: 'alipay', out_trade_no: order.id.slice(4), trade_no: '2026000000001', trade_status: 'TRADE_SUCCESS', money: '10.00', sign_type: 'MD5' })
  params.set('sign', signZpayParams(params, key))
  const notify = () => s.request(`/api/payments/notify/zpay?${params}`)
  assert.equal((await notify()).status, 400)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
  paid = true
  assert.equal((await notify()).status, 200)
  assert.equal((await notify()).status, 200)
  assert.match((await s.read(order.id)).delivery.value, /^PRIVATE-CODE-[12]$/)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM cdk_stock WHERE state='delivered'").get()!.n, 1)
  const current = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), reason: '商品不适用', version: current.version }, s.buyer)).status, 201)
  const refund = s.db.prepare('SELECT id FROM refund_cases WHERE order_id=?').get(order.id) as { id: string }
  const refundPath = `/api/admin/refunds/${refund.id}`
  assert.equal((await s.request(refundPath, { action: 'approve', version: 0, amountCents: 1000, note: '同意退款' }, s.admin)).status, 200)
  assert.equal((await s.request(refundPath, { action: 'execute-refund', version: 1, note: '后台已退款' }, s.admin)).status, 400)
  assert.equal((await s.request(refundPath, { action: 'execute-refund', version: 1, reference: 'merchant-refund-reference', note: '后台已退款' }, s.admin)).status, 200)
  assert.equal((await s.read(order.id)).delivery.value, undefined)
})

test('ZPAY manual checkout requires verified payment and human completion, replay never overwrites delivery', async t => {
  const s = await setup(t, 'manual')
  const pid = '202600000001', key = 'local-test-key-keep-private'
  Object.assign(s.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: pid, ZPAY_KEY: key, ALIPAY_APP_ID: undefined, ALIPAY_SELLER_ID: undefined, ALIPAY_APP_PRIVATE_KEY: undefined, ALIPAY_PUBLIC_KEY: undefined })
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === s.plan).enabled, 1)
  const order = await s.order(), path = `/api/admin/inventory/orders/${order.id}`
  const complete = (version: number, value = 'PRIVATE-MANUAL-RESULT') => s.request(path, { action: 'complete', version, value, note: 'INTERNAL-HUMAN-NOTE' }, s.admin)
  const payment = await s.request(`/api/orders/${order.id}/payment`, { action: 'create' }, s.buyer)
  assert.equal(payment.status, 200, await payment.clone().text())
  assert.equal((await payment.json()).payment.provider, 'zpay')
  assert.equal((await complete(order.version)).status, 409)
  let paid = false, mails = 0
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    if (url.origin === 'https://api.resend.com') { mails++; return Response.json({ id: 'manual_mail' }) }
    assert.equal(url.origin, 'https://zpayz.cn')
    return Response.json({ code: 1, pid, out_trade_no: order.id.slice(4), type: 'alipay', money: '10.00', status: paid ? 1 : 0, trade_no: '2026000000001' })
  })
  const params = new URLSearchParams({ pid, type: 'alipay', out_trade_no: order.id.slice(4), trade_no: '2026000000001', trade_status: 'TRADE_SUCCESS', money: '10.00', sign_type: 'MD5' })
  params.set('sign', signZpayParams(params, key))
  const notify = () => s.request(`/api/payments/notify/zpay?${params}`)
  assert.equal((await notify()).status, 400)
  assert.equal((await s.read(order.id)).paymentStatus, 'unpaid')
  paid = true
  assert.equal((await notify()).status, 200)
  assert.equal((await notify()).status, 200)
  const queued = await s.read(order.id)
  assert.equal(queued.serviceDelivery.state, 'queued')
  assert.equal(queued.delivery.value, undefined)
  assert.equal(mails, 0)
  assert.equal((await s.request(path, { action: 'start', version: queued.version, note: 'INTERNAL-START-NOTE' }, s.admin)).status, 200)
  const running = await s.read(order.id)
  assert.equal(running.serviceDelivery.state, 'running')
  assert.equal((await complete(queued.version)).status, 409)
  assert.equal((await complete(running.version)).status, 200)
  assert.equal((await complete(running.version, 'REPLAY-REPLACEMENT')).status, 200)
  assert.equal((await notify()).status, 200)
  const delivered = await s.read(order.id)
  assert.equal(delivered.status, 'success')
  assert.equal(delivered.delivery.value, 'PRIVATE-MANUAL-RESULT')
  assert.doesNotMatch(JSON.stringify(delivered), /INTERNAL-/)
  assert.equal(mails, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cdk_stock').get()!.n, 0)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM fulfillment_tasks').all()), /PRIVATE-MANUAL-RESULT/)
})

test('manual work queue isolates paid human tasks, keeps snapshots, and separates held orders', async t => {
  const s = await setup(t, 'manual')
  const queue = async (query = '') => {
    const response = await s.request('/api/admin/inventory/manual' + query, undefined, s.admin)
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  assert.equal((await s.request('/api/admin/inventory/manual')).status, 401)
  assert.equal((await s.request('/api/admin/inventory/manual', undefined, s.buyer)).status, 401)
  for (const query of ['?state=invalid', '?page=0', '?page=1.5', '?q=' + 'x'.repeat(321)]) assert.equal((await s.request('/api/admin/inventory/manual' + query, undefined, s.admin)).status, 400)
  const unpaid = await s.order()
  assert.equal((await queue('?state=all')).total, 0)
  const queued = await s.order(), held = await s.order(), running = await s.order(), supplier = await s.order(), review = await s.order(), delivered = await s.order()
  for (const order of [queued, held, running, supplier, review, delivered]) await s.pay(order.id)
  s.db.prepare("UPDATE orders SET created_at=1,customer_email='first-buyer@example.test' WHERE id=?").run(queued.id)
  s.db.prepare("UPDATE service_products SET name='新商品名称' WHERE id=?").run(s.productId)
  s.db.prepare("UPDATE catalog_plans SET name='新规格名称' WHERE id=?").run(s.plan)
  s.db.prepare("UPDATE orders SET refund_hold=1 WHERE id=?").run(held.id)
  s.db.prepare("UPDATE fulfillment_tasks SET state='running' WHERE order_id=?").run(running.id)
  s.db.prepare("UPDATE fulfillment_tasks SET state='review' WHERE order_id=?").run(review.id)
  s.db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(review.id)
  s.db.prepare("INSERT INTO muse_orders(order_id,key_id,product_code,expected_cost_cents,raw_body,idempotency_key,updated_at) VALUES(?,'fixture','muse-fixture',100,'{}',?,?)").run(supplier.id, supplier.id, Date.now())
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'queue_mail' }))
  const latest = await s.read(delivered.id)
  assert.equal((await s.request(`/api/admin/inventory/orders/${delivered.id}`, { action: 'complete', version: latest.version, value: 'PRIVATE-QUEUE-RESULT', note: 'PRIVATE-QUEUE-NOTE' }, s.admin)).status, 200)
  const active = await queue()
  assert.equal(active.total, 2)
  assert.equal(active.rows[0].id, queued.id)
  assert.equal(active.rows[0].productName, '独立软件')
  assert.equal(active.rows[0].planName, '月卡')
  assert.deepEqual(active.counts, { queued: 1, running: 1, held: 1, review: 1, delivered: 1 })
  const all = await queue('?state=all')
  assert.equal(all.total, 5)
  assert.ok(!all.rows.some((row: { id: string }) => row.id === unpaid.id || row.id === supplier.id))
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE-QUEUE|encrypted|instructions|lease_token/)
  assert.equal((await queue('?q=FIRST-BUYER')).total, 1)
  assert.equal((await queue('?q=' + queued.id.toLowerCase())).total, 1)
  assert.equal((await queue('?state=review')).rows[0].id, review.id)
  for (const field of ['refund_hold', 'redemption_blocked', 'refunded_cents']) {
    s.db.prepare('UPDATE orders SET refund_hold=0,redemption_blocked=0,refunded_cents=0 WHERE id=?').run(held.id)
    s.db.prepare(`UPDATE orders SET ${field}=1 WHERE id=?`).run(held.id)
    assert.equal((await queue('?state=held')).rows[0].id, held.id)
    const current = await s.read(held.id)
    assert.equal((await s.request(`/api/admin/inventory/orders/${held.id}`, { action: 'complete', version: current.version, value: 'INVALID', note: '禁止误发' }, s.admin)).status, 409)
  }
})

test('manual work queue paginates oldest orders first with stable totals', async t => {
  const s = await setup(t, 'manual')
  const ids: string[] = []
  for (let index = 0; index < 21; index++) {
    const order = await s.order(); await s.pay(order.id)
    s.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(index + 1, order.id)
    ids.push(order.id)
  }
  const first = await (await s.request('/api/admin/inventory/manual', undefined, s.admin)).json()
  const second = await (await s.request('/api/admin/inventory/manual?page=2', undefined, s.admin)).json()
  assert.equal(first.total, 21)
  assert.deepEqual(first.rows.map((row: { id: string }) => row.id), ids.slice(0, 20))
  assert.deepEqual(second.rows.map((row: { id: string }) => row.id), ids.slice(20))
})

test('late manual payments join the normal queue because no unit was held, and can be delivered once', async t => {
  const s = await setup(t, 'manual'), order = await s.order()
  s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(order.id)
  await expireReservations(s.env)
  assert.equal((await s.read(order.id)).status, 'cancelled')
  await s.pay(order.id)
  const current = await s.read(order.id)
  assert.equal(current.serviceDelivery.state, 'queued')
  assert.equal(current.status, 'processing')
  const queue = await (await s.request('/api/admin/inventory/manual?state=queued', undefined, s.admin)).json()
  assert.equal(queue.total, 1)
  assert.equal(queue.rows[0].id, order.id)
  assert.equal((await s.request(`/api/admin/inventory/orders/${order.id}`, { action: 'complete', version: current.version, value: 'LATE-BUT-PAID', note: '付款已核验，人工交付' }, s.admin)).status, 200)
  const done = await s.read(order.id)
  assert.equal(done.status, 'success')
  assert.equal(done.delivery.value, 'LATE-BUT-PAID')
})

test('mail lease excludes racing refund and redemption writes, then refunded codes stay quarantined', async t => {
  const s = await setup(t), order = await s.order(); await s.pay(order.id)
  t.mock.method(globalThis, 'fetch', async () => {
    const current = await s.read(order.id)
    assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '申请核对退款' }, s.buyer)).status, 409)
    assert.equal((await s.request(`/api/admin/orders/${order.id}/actions`, { action: 'redemption-control', blocked: true, version: current.version, note: '测试暂停交付' }, s.admin)).status, 409)
    return Response.json({ id: 'serialized_mail' })
  })
  await sendServiceMail(s.env, order.id)
  const current = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '申请核对退款' }, s.buyer)).status, 201)
  s.db.prepare('UPDATE orders SET refunded_cents=1000 WHERE id=?').run(order.id)
  await expireReservations(s.env)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock WHERE order_id=?').get(order.id)!.state, 'quarantined')
})

test('refund review warns that a delivered code cannot be taken back', async t => {
  const s = await setup(t), order = await s.order()
  const before = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), reason: '暂不需要', version: before.version }, s.buyer)).status, 409)
  await s.pay(order.id)
  const current = await s.read(order.id)
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), reason: '商品不适用', version: current.version }, s.buyer)).status, 201)
  const refund = s.db.prepare('SELECT id FROM refund_cases WHERE order_id=?').get(order.id) as { id: string }
  const detail = await (await s.request('/api/admin/refunds/' + refund.id, undefined, s.admin)).json()
  assert.match(detail.fulfillmentNotice, /已交付/)
})

test('overdue unpaid cashier trades close every minute so their stock returns to sale, while late receipts are still booked', async t => {
  const s = await setup(t, 'stock', ['ONLY-CODE'])
  const pid = '202600000001', key = 'local-test-key-keep-private'
  Object.assign(s.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: pid, ZPAY_KEY: key, ALIPAY_APP_ID: undefined, ALIPAY_SELLER_ID: undefined, ALIPAY_APP_PRIVATE_KEY: undefined, ALIPAY_PUBLIC_KEY: undefined })
  let paid = false
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input), number = url.searchParams.get('out_trade_no')
    return Response.json({ code: 1, pid, out_trade_no: number, type: 'alipay', money: '10.00', status: paid ? 1 : 0, trade_no: '2026000000009' })
  })
  const abandoned = await s.order()
  assert.equal((await s.request(`/api/orders/${abandoned.id}/payment`, { action: 'create' }, s.buyer)).status, 200)
  // The cashier and its two-minute safety allowance have passed; the reservation has too.
  s.db.prepare('UPDATE payments SET expires_at=? WHERE order_id=?').run(Date.now() - 200000, abandoned.id)
  s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(abandoned.id)
  assert.equal((await s.create()).status, 409)
  assert.deepEqual(await reconcileOverdueReservations(s.env), { checked: 1, closed: 1 })
  assert.equal((await findPayment(s.env, abandoned.id))!.state, 'closed')
  await reconcileServices(s.env)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock').get()!.state, 'available')
  // A buyer who pays at the last moment is booked, never closed.
  const late = await s.order()
  assert.equal((await s.request(`/api/orders/${late.id}/payment`, { action: 'create' }, s.buyer)).status, 200)
  s.db.prepare('UPDATE payments SET expires_at=? WHERE order_id=?').run(Date.now() - 200000, late.id)
  paid = true
  await reconcileOverdueReservations(s.env)
  assert.equal((await findPayment(s.env, late.id))!.state, 'paid')
  assert.equal(s.db.prepare('SELECT payment_status FROM orders WHERE id=?').get(late.id)!.payment_status, 'paid')
})

test('overdue trades that keep failing rotate instead of holding every slot of the minute job', async t => {
  const s = await setup(t, 'manual')
  const pid = '202600000001', key = 'local-test-key-keep-private'
  Object.assign(s.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: pid, ZPAY_KEY: key, ALIPAY_APP_ID: undefined, ALIPAY_SELLER_ID: undefined, ALIPAY_APP_PRIVATE_KEY: undefined, ALIPAY_PUBLIC_KEY: undefined })
  t.mock.method(globalThis, 'fetch', async (input: string) => Response.json({ code: 1, pid, out_trade_no: new URL(input).searchParams.get('out_trade_no'), type: 'alipay', money: '10.00', status: 0, trade_no: '2026000000009' }))
  const ids = [] as string[]
  for (let i = 0; i < 11; i++) {
    const order = await s.order(); ids.push(order.id)
    assert.equal((await s.request(`/api/orders/${order.id}/payment`, { action: 'create' }, s.buyer)).status, 200)
  }
  const target = ids.pop()!
  // Ten trades are bound to a merchant account that is no longer configured and
  // expired earliest; each attempt fails without changing their state.
  for (const id of ids) s.db.prepare("UPDATE payments SET account='earlier-merchant',expires_at=?,updated_at=? WHERE order_id=?").run(Date.now() - 900000, Date.now() - 900000, id)
  s.db.prepare('UPDATE payments SET expires_at=?,updated_at=? WHERE order_id=?').run(Date.now() - 200000, Date.now() - 200000, target)
  await reconcileOverdueReservations(s.env)
  await reconcileOverdueReservations(s.env)
  assert.equal((await findPayment(s.env, target))!.state, 'closed')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM payments WHERE account='earlier-merchant' AND state='pending'").get()!.n, 10)
})

test('a ZPAY cashier link that was never opened closes after expiry and returns its stock to sale', async t => {
  const s = await setup(t, 'stock', ['ONLY-CODE'])
  const pid = '202600000001', key = 'local-test-key-keep-private'
  Object.assign(s.env, { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: pid, ZPAY_KEY: key, ALIPAY_APP_ID: undefined, ALIPAY_SELLER_ID: undefined, ALIPAY_APP_PRIVATE_KEY: undefined, ALIPAY_PUBLIC_KEY: undefined })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, msg: '订单编号不存在' }))
  const order = await s.order()
  assert.equal((await s.request(`/api/orders/${order.id}/payment`, { action: 'create' }, s.buyer)).status, 200)
  // Not yet past the two-minute allowance: the trade stays open.
  s.db.prepare('UPDATE payments SET expires_at=? WHERE order_id=?').run(Date.now() - 60000, order.id)
  await reconcileOverdueReservations(s.env)
  assert.equal((await findPayment(s.env, order.id))!.state, 'pending')
  s.db.prepare('UPDATE payments SET expires_at=?,updated_at=0 WHERE order_id=?').run(Date.now() - 200000, order.id)
  s.db.prepare('UPDATE fulfillment_tasks SET expires_at=0 WHERE order_id=?').run(order.id)
  await reconcileOverdueReservations(s.env)
  assert.equal((await findPayment(s.env, order.id))!.state, 'closed')
  await reconcileServices(s.env)
  assert.equal(s.db.prepare('SELECT state FROM cdk_stock').get()!.state, 'available')
})
