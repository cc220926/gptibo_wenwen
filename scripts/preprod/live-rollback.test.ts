// Isolated protocol rehearsal. No real payment, supplier, mail, or Turnstile
// network is allowed. Run with SEO_BASELINE_ROOT and SEO_PREPROD_VARS set.
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import candidate from '../../worker/storefront-entry.ts'
import { customerFixture } from '../../tests/customer-fixture.ts'
import { productMap } from '../../worker/recharge/client.ts'
import { signZpayParams } from '../../worker/payments/zpay-protocol.ts'
import type { Env } from '../../worker/platform.ts'

const origin = 'https://preprod.example.test'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const mac = (text: string, secret: string) => createHmac('sha256', secret).update(text).digest('hex')
const money = (cents: number) => (cents / 100).toFixed(2)
type RemoteRecharge = { order_id: string; merchant_order_no: string; product_code: string; sale_amount: string; payment_status: string }
type RemoteRedemption = { redemption_id: string; order_id: string; status: string }
type NativeOrder = { id: string; merchant_order_no: string; product_code: string; supply_minor: number; fulfillment_type: string; status: string }

async function productionFixture(t: TestContext) {
  assert.ok(process.env.SEO_PREPROD_VARS, 'Provide audited non-credential production vars')
  const production = JSON.parse(readFileSync(process.env.SEO_PREPROD_VARS, 'utf8')) as Record<string, string>
  const s = await customerFixture()
  t.after(() => s.db.close())
  // Synthetic inventory uses the audited public main-store Plus retail price.
  s.db.prepare("UPDATE catalog_plans SET price_cents=13800 WHERE id='plus'").run()
  const env = s.env as Env & { STOREFRONT_SEO_ORIGIN: string; SEO_CATALOG_LIMITER: { limit(): Promise<{ success: boolean }> } }
  const secret = () => randomBytes(32).toString('hex')
  Object.assign(env, production, {
    STOREFRONT_SEO_ORIGIN: origin,
    SEO_CATALOG_LIMITER: { limit: async () => ({ success: true }) },
    TURNSTILE_HOSTNAMES: new URL(origin).hostname, TURNSTILE_SITE_KEY: 'isolated-site-key', TURNSTILE_SECRET_KEY: secret(),
    RECHARGE_API_BASE: 'https://recharge.example.test/v1', RECHARGE_PARTNER_ID: 'pt_isolated', RECHARGE_KEY_ID: 'key_isolated',
    RECHARGE_CLIENT_SECRET: secret(), RECHARGE_WEBHOOK_SECRET: secret(), RECHARGE_NOTIFY_URL: origin + '/api/recharge/webhook',
    RECHARGE_PRODUCT_MAP: JSON.stringify({ plus: 'isolated_plus' }),
    PAYMENT_NOTIFY_ORIGIN: origin, MAIL_PUBLIC_ORIGIN: origin,
    ZPAY_PID: '2026112100000000', ZPAY_KEY: secret(), MAPAY_PID: '20261121', MAPAY_KEY: secret(),
    MUSE_KEY_ID: 'isolated-native-key', MUSE_API_SECRET: secret(), MUSE_WEBHOOK_SECRET: secret(),
    CDK_ENCRYPTION_KEY: randomBytes(32).toString('base64'), RESEND_API_KEY: secret(), RESEND_FROM: 'Isolated <delivery@example.test>',
    ASSETS: { fetch: async () => new Response('<!doctype html><html><head><title>商店</title><meta name="description" content=""><meta name="robots" content="noindex"></head><body><div id="root"></div></body></html>', { headers: { 'Content-Type': 'text/html' } }) },
  })
  const protectedKeys = Object.keys(production).filter(k => k.endsWith('_ENABLED') || ['SERVICE_PAYMENT_PROVIDER', 'MUSE_PAYMENT_PROVIDER', 'MUSE_ACCOUNT_PAYMENT_APPROVED', 'PARTNER_PRODUCT_IDS', 'RECHARGE_CODEX_PRODUCT_MAP'].includes(k))
  for (const key of protectedKeys) assert.equal((env as unknown as Record<string, unknown>)[key], production[key], key)
  // Audit EVERY provided production variable. Only these explicit isolation
  // substitutions may differ; an unexpected future variable change fails closed.
  const isolationKeys = ['TURNSTILE_HOSTNAMES', 'TURNSTILE_SITE_KEY', 'RECHARGE_NOTIFY_URL', 'PAYMENT_NOTIFY_ORIGIN', 'MAIL_PUBLIC_ORIGIN']
  const assertVariables = () => {
    for (const [key, value] of Object.entries(production)) if (!isolationKeys.includes(key)) assert.equal((env as unknown as Record<string, unknown>)[key], value, key)
    assert.deepEqual(Object.keys(production).filter(k => (env as unknown as Record<string, unknown>)[k] !== production[k]).sort(), isolationKeys.sort())
  }
  assertVariables()
  assert.equal(env.ORDER_TESTING_ENABLED, 'false'); assert.equal(env.TURNSTILE_ENABLED, 'true')
  assert.equal(env.RECHARGE_CHECKOUT_ENABLED, 'true'); assert.equal(env.SERVICE_CHECKOUT_ENABLED, 'true')
  assert.equal(env.SERVICE_PAYMENT_PROVIDER, 'zpay', 'Rehearsal must be extended if production payment route changes')
  assert.equal(env.MUSE_PAYMENT_PROVIDER, 'mapay')
  assert.ok(env.GPTIBO_SUPPLY_ENABLED?.split(',').includes('gpt-plus-account'))
  return { ...s, env, production, protectedKeys, assertVariables }
}

test('production flags: candidate live orders survive baseline rollback with original database and verified callbacks', async t => {
  assert.ok(process.env.SEO_BASELINE_ROOT, 'Provide archived release baseline')
  const baseline = (await import(pathToFileURL(process.env.SEO_BASELINE_ROOT + '/worker/index.ts').href)).default as typeof candidate
  const s = await productionFixture(t), { env, production, protectedKeys, assertVariables } = s
  let current = candidate
  const call = (path: string, data?: unknown, cookie = '') => current.fetch(new Request(origin + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), env)
  const json = async (response: Response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text())
    return response.json() as Promise<Record<string, any>>
  }
  const buyerCookie = async () => {
    const response = await call('/api/orders/client', {})
    assert.equal(response.status, 200)
    return response.headers.get('Set-Cookie')!.split(';')[0]
  }
  const recharge = new Map<string, RemoteRecharge>(), redemptions = new Map<string, RemoteRedemption>()
  const native = new Map<string, NativeOrder>(), paid = new Set<string>()
  const rechargeCreates = new Map<string, number>(), redemptionCreates = new Map<string, number>(), nativeCreates = new Map<string, number>()
  const nativeDeliveryReads = new Map<string, number>(), emailKeys = new Set<string>(), recoveryCodes = new Map<string, string>()
  const forbiddenNetwork: string[] = []
  let challengeCalls = 0
  const delivery = 'ISOLATED-ACCOUNT@example.test----NOT-A-REAL-PASSWORD----ISOLATED-CODE'
  const bump = (counts: Map<string, number>, id: string) => counts.set(id, (counts.get(id) ?? 0) + 1)
  const mapped = productMap(env)
  const products = Object.values(mapped).map(code => ({ product_code: code, supply_price: '1.00', max_sale_price: '5000.00', currency: 'CNY', max_quantity: 1, available: true, delivery_modes: ['auto_recharge', 'cdk'] }))
  const rechargeDto = (order: RemoteRecharge) => ({ ...order, quantity: 1, supply_amount: '1.00', merchant_margin: money(Math.round(Number(order.sale_amount) * 100) - 100), currency: 'CNY', collection_mode: 'platform_collect', payment_scope: 'retail', delivery_mode: 'auto_recharge', qr_payload: 'https://recharge.example.test/pay/isolated', expires_at: new Date(Date.now() + 900000).toISOString(), refunded_amount: '0.00' })
  const redemptionDto = (item: RemoteRedemption) => ({ ...item, attempt_no: 1, failure_code: null, fallback_recharge_available: false, retry_allowed: false, next_action: item.status === 'succeeded' ? 'none' : 'wait', account_email_masked: 't***@example.test', finished_at: item.status === 'succeeded' ? new Date().toISOString() : null })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(options?.headers), raw = String(options?.body ?? ''), method = options?.method ?? 'GET'
    // Errors are recorded independently because business handlers intentionally catch
    // provider failures. Thus an unexpected egress cannot accidentally pass the test.
    try {
      assert.equal(options?.redirect, 'manual')
      if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        const body = JSON.parse(raw); assert.equal(body.secret, env.TURNSTILE_SECRET_KEY)
        challengeCalls++
        return Response.json({ success: body.response === 'isolated-valid-token', hostname: new URL(origin).hostname, action: 'order_create', challenge_ts: new Date().toISOString() })
      }
      if (url.origin === 'https://recharge.example.test') {
        assert.equal(headers.get('X-Partner-Id'), env.RECHARGE_PARTNER_ID)
        assert.equal(headers.get('X-Key-Id'), env.RECHARGE_KEY_ID)
        assert.equal(headers.get('X-Signature'), mac([method, url.pathname, '', headers.get('X-Timestamp'), headers.get('X-Nonce'), headers.get('X-Key-Id'), headers.get('Idempotency-Key') ?? '', digest(raw)].join('\n'), env.RECHARGE_CLIENT_SECRET!))
        if (url.pathname === '/v1/products') return Response.json({ data: products })
        if (url.pathname === '/v1/payment-methods') return Response.json({ data: [{ code: 'alipay' }] })
        if (url.pathname === '/v1/orders' && method === 'POST') {
          const body = JSON.parse(raw), id = 'ord_' + body.merchant_order_no.slice(4)
          assert.equal(body.notify_url, env.RECHARGE_NOTIFY_URL)
          assert.ok(Object.values(mapped).includes(body.product_code))
          bump(rechargeCreates, body.merchant_order_no)
          const order = recharge.get(id) ?? { order_id: id, merchant_order_no: body.merchant_order_no, product_code: body.product_code, sale_amount: body.sale_amount, payment_status: 'pending' }
          recharge.set(id, order); return Response.json({ data: rechargeDto(order) })
        }
        if (url.pathname.startsWith('/v1/orders/')) {
          const order = recharge.get(url.pathname.split('/')[3]); assert.ok(order)
          return Response.json({ data: rechargeDto(order) })
        }
        if (url.pathname === '/v1/redemptions' && method === 'POST') {
          const body = JSON.parse(raw), key = headers.get('Idempotency-Key')!
          assert.ok(recharge.has(body.order_id)); assert.equal(recharge.get(body.order_id)!.payment_status, 'paid')
          bump(redemptionCreates, body.order_id)
          const item = redemptions.get(key) ?? { redemption_id: 'ful_' + body.order_id.slice(4), order_id: body.order_id, status: 'queued' }
          redemptions.set(key, item); return Response.json({ data: redemptionDto(item) })
        }
        if (url.pathname.startsWith('/v1/redemptions/')) {
          const item = [...redemptions.values()].find(v => v.redemption_id === url.pathname.split('/')[3]); assert.ok(item)
          return Response.json({ data: redemptionDto(item) })
        }
      }
      if (url.origin === 'https://zpayz.cn' && url.pathname === '/api.php') {
        assert.equal(url.searchParams.get('pid'), env.ZPAY_PID); assert.equal(url.searchParams.get('key'), env.ZPAY_KEY)
        const id = 'YMX-' + url.searchParams.get('out_trade_no')
        const order = s.db.prepare('SELECT price_cents FROM orders WHERE id=?').get(id); assert.ok(order)
        return Response.json({ code: 1, pid: env.ZPAY_PID, type: 'alipay', out_trade_no: id.slice(4), money: money(Number(order.price_cents)), status: paid.has(id) ? 1 : 0, trade_no: 'trade_' + id.slice(4) })
      }
      if (url.origin === 'https://api.gptibo.com') {
        assert.equal(headers.get('X-Key-Id'), env.MUSE_KEY_ID)
        assert.equal(headers.get('X-Signature'), mac([method, url.pathname, '', headers.get('X-Timestamp'), headers.get('X-Nonce'), headers.get('X-Key-Id'), headers.get('Idempotency-Key') ?? '', digest(raw)].join('\n'), env.MUSE_API_SECRET!))
        const path = url.pathname.replace(/^\/v1/, '')
        if (path === '/products') return Response.json({ data: [{ code: 'gpt-plus-account', name: 'ChatGPT Plus 成品账号', supply_minor: 100, enabled: true, available: true, fulfillment_type: 'account_delivery' }] })
        if (path === '/balance') return Response.json({ data: { currency: 'CNY', available_minor: 100000, frozen_minor: 0 } })
        if (path === '/preflight') { assert.equal(JSON.parse(raw).product_code, 'gpt-plus-account'); return Response.json({ data: { ready: true, fulfillment_type: 'account_delivery', quantity: 1 } }) }
        if (path === '/orders' && method === 'POST') {
          const body = JSON.parse(raw), id = body.merchant_order_no
          assert.ok(paid.has(id)); assert.equal(body.product_code, 'gpt-plus-account'); assert.equal(body.expected_supply_minor, 100)
          bump(nativeCreates, id)
          const order = native.get(id) ?? { id: 'ord_' + id.slice(4), merchant_order_no: id, product_code: body.product_code, supply_minor: body.expected_supply_minor, fulfillment_type: 'account_delivery', status: 'running' }
          native.set(id, order); return Response.json({ data: order }, { status: 201 })
        }
        const order = [...native.values()].find(v => path.includes(v.id) || path.endsWith('/' + v.merchant_order_no))
        if (order && path.endsWith('/delivery')) { bump(nativeDeliveryReads, order.merchant_order_no); return Response.json({ data: { order_id: order.id, product_code: order.product_code, fulfillment_type: 'account_delivery', quantity: 1, content: delivery } }) }
        if (order && path.startsWith('/orders/')) return Response.json({ data: order })
      }
      if (url.href === 'https://api.resend.com/emails') {
        assert.equal(headers.get('Authorization'), 'Bearer ' + env.RESEND_API_KEY)
        const key = headers.get('Idempotency-Key'); assert.ok(key)
        if (key.startsWith('order-recovery/')) {
          const body = JSON.parse(raw), code = String(body.text).match(/\b\d{6}\b/)?.[0]
          assert.ok(code); assert.deepEqual(body.to, ['buyer@example.test'])
          recoveryCodes.set(key.slice('order-recovery/'.length), code)
        }
        emailKeys.add(key); return Response.json({ id: 'isolated-mail-' + digest(key).slice(0, 16) })
      }
      throw new Error('Unexpected endpoint')
    } catch (error) {
      forbiddenNetwork.push(url.origin + url.pathname)
      throw error
    }
  })

  const buyer = await buyerCookie(), stranger = await buyerCookie()
  const challenge = { turnstileToken: 'isolated-valid-token' }
  const before = s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n
  const noChallenge = await call('/api/orders', { plan: 'plus', expectedPrice: 13800, key: crypto.randomUUID(), email: 'buyer@example.test' }, buyer)
  assert.equal(noChallenge.status, 400)
  const wrongChallenge = await call('/api/orders', { plan: 'plus', expectedPrice: 13800, key: crypto.randomUUID(), email: 'buyer@example.test', turnstileToken: 'invalid' }, buyer)
  assert.equal(wrongChallenge.status, 400)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, before)
  const catalog = await json(await call('/api/catalog'))
  assert.equal(catalog.checkoutEnabled, true); assert.equal(catalog.testingEnabled, false)
  const makeRecharge = async (plan: string) => {
    const price = catalog.plans.find((p: any) => p.id === plan).price_cents
    const payload = { plan, expectedPrice: price, email: 'buyer@example.test', key: crypto.randomUUID(), ...challenge }
    const order = (await json(await call('/api/orders', payload, buyer), 201)).order
    assert.equal(order.mode, 'live'); assert.equal(order.status, 'pending')
    assert.equal((await json(await call('/api/orders', payload, buyer))).order.id, order.id)
    await json(await call(`/api/orders/${order.id}/fulfillment`, { action: 'query' }, buyer))
    assert.equal(rechargeCreates.get(order.id), 1)
    return order
  }
  const plus = await makeRecharge('plus'), codex = await makeRecharge('codex-credits-500')
  assert.equal(plus.price, 138); assert.equal(codex.price, 199)
  const query = (id: string) => call(`/api/orders/${id}/fulfillment`, { action: 'query' }, buyer)
  const submit = (id: string, key: string) => call(`/api/orders/${id}/fulfillment`, { action: 'submit', key, customerConfirmedEmail: true, credential: { mode: 'session', session: JSON.stringify({ user: { email: 'target@example.test' }, accessToken: 'ISOLATED-NOT-A-REAL-SESSION' }) } }, buyer)
  const codexRemote = [...recharge.values()].find(v => v.merchant_order_no === codex.id)!
  assert.equal(codexRemote.product_code, 'chatgpt_codex_500_cdk'); codexRemote.payment_status = 'paid'
  assert.equal((await json(await query(codex.id))).order.status, 'session')
  const codexKey = crypto.randomUUID()
  assert.equal((await json(await submit(codex.id, codexKey))).order.status, 'processing')
  await json(await submit(codex.id, codexKey)); assert.equal(redemptionCreates.get(codexRemote.order_id), 1)
  const product = await json(await call('/api/admin/inventory/products', { name: 'ChatGPT Plus 成品账号', category: '独立预发布', description: 'Synthetic fulfillment fixture' }, s.admin))
  const plan = await json(await call('/api/admin/inventory/plans', { productId: product.id, name: '成品账号', priceCents: 8500, kind: 'muse', enabled: true, purchaseNote: '隔离验收', instructions: '不可用测试资料', supplierCode: 'gpt-plus-account', maxCostCents: 100 }, s.admin))
  const accountPayload = { plan: plan.id, key: crypto.randomUUID(), expectedPrice: 8500, email: 'buyer@example.test', ...challenge }
  const account = (await json(await call('/api/orders', accountPayload, buyer), 201)).order
  assert.equal(account.mode, 'live'); assert.equal(account.status, 'pending')
  assert.equal((await json(await call('/api/orders', accountPayload, buyer))).order.id, account.id)
  const payment = await json(await call(`/api/orders/${account.id}/payment`, { action: 'create' }, buyer))
  assert.equal(payment.payment.provider, 'zpay'); assert.equal(nativeCreates.size, 0)
  const cashier = new URL(payment.payment.qr)
  assert.equal(cashier.hostname, 'zpayz.cn'); assert.equal(cashier.searchParams.get('notify_url'), origin + '/api/payments/notify/zpay')
  assert.equal(cashier.searchParams.get('sign'), signZpayParams(cashier.searchParams, env.ZPAY_KEY!))
  const accountNotice = (tamper = false) => {
    const p = new URLSearchParams({ pid: env.ZPAY_PID!, type: 'alipay', out_trade_no: account.id.slice(4), trade_no: 'trade_' + account.id.slice(4), money: '85.00', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5' })
    p.set('sign', signZpayParams(p, env.ZPAY_KEY!)); if (tamper) p.set('money', '1.00')
    return current.fetch(new Request(origin + '/api/payments/notify/zpay?' + p), env)
  }
  assert.equal((await accountNotice()).status, 400, 'Signed notice without paid authoritative query must not deliver')
  assert.equal((await accountNotice(true)).status, 400, 'Modified signed notice must be rejected')
  paid.add(account.id); assert.equal((await accountNotice()).status, 200)
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(account.id)!.status, 'processing')
  assert.equal(nativeCreates.get(account.id), 1)
  const beforeRollback = s.db.prepare('SELECT id,mode,status,payment_status FROM orders ORDER BY id').all()
  assert.deepEqual(beforeRollback.map(row => row.mode), ['live', 'live', 'live'])
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(plus.id)!.status, 'pending')
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(codex.id)!.status, 'processing')

  // Only implementation pointer changes. Preserve env, D1, cookies, ciphertext,
  // idempotency keys, supplier receipts and pending provider work across rollback.
  current = baseline
  assert.deepEqual(s.db.prepare('SELECT id,mode,status,payment_status FROM orders ORDER BY id').all(), beforeRollback)
  const rechargeNotice = async (order: RemoteRecharge, id: string, tamper = false) => {
    const stamp = String(Math.floor(Date.now() / 1000)), body = JSON.stringify({ event_id: id, type: 'order.paid', data: { order_id: order.order_id } })
    return current.fetch(new Request(origin + '/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'order.paid', 'X-Quefa-Event-Id': id, 'X-Quefa-Delivery': 'dlv_' + id, 'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': `t=${stamp},v1=${mac(stamp + '.' + body, env.RECHARGE_WEBHOOK_SECRET!)}` }, body: tamper ? body + ' ' : body }), env)
  }
  const plusRemote = [...recharge.values()].find(v => v.merchant_order_no === plus.id)!
  plusRemote.payment_status = 'paid'
  assert.equal((await rechargeNotice(plusRemote, 'evt_plus', true)).status, 400)
  assert.equal((await rechargeNotice(plusRemote, 'evt_plus')).status, 200)
  assert.equal((await rechargeNotice(plusRemote, 'evt_plus')).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM recharge_webhooks WHERE event_id='evt_plus'").get()!.n, 1)
  for (const item of redemptions.values()) item.status = 'succeeded'
  const accountRemote = native.get(account.id)!; accountRemote.status = 'succeeded'
  const nativeNotice = (tamper = false) => {
    const id = 'evt_native', timestamp = String(Math.floor(Date.now() / 1000)), body = JSON.stringify({ id, type: 'order.succeeded', data: { id: accountRemote.id, merchant_order_no: account.id, status: 'succeeded' } })
    return current.fetch(new Request(origin + '/api/muse/webhook', { method: 'POST', body: tamper ? body + ' ' : body, headers: { 'Content-Type': 'application/json', 'X-Event-Id': id, 'X-Timestamp': timestamp, 'X-Signature': mac(timestamp + '.' + id + '.' + body, env.MUSE_WEBHOOK_SECRET!) } }), env)
  }
  assert.equal((await nativeNotice(true)).status, 401)
  assert.equal((await nativeNotice()).status, 200); assert.equal((await nativeNotice()).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM muse_events WHERE id='evt_native'").get()!.n, 1)
  assert.equal((await accountNotice()).status, 200); assert.equal(nativeCreates.get(account.id), 1)
  s.db.prepare('UPDATE recharge_orders SET updated_at=0').run()
  await current.scheduled({ scheduledTime: Math.floor(Date.now() / 300000) * 300000 }, env)
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(codex.id)!.status, 'success')
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(account.id)!.status, 'success')
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(plus.id)!.status, 'session')
  const plusKey = crypto.randomUUID()
  await json(await submit(plus.id, plusKey)); await json(await submit(plus.id, plusKey))
  for (const item of redemptions.values()) item.status = 'succeeded'
  s.db.prepare('UPDATE recharge_orders SET updated_at=0').run()
  await current.scheduled({ scheduledTime: Math.floor(Date.now() / 300000) * 300000 }, env)
  await current.scheduled({ scheduledTime: Math.floor(Date.now() / 300000) * 300000 }, env)
  for (const order of [plus, codex, account]) {
    const viewed = (await json(await call('/api/orders/' + order.id, undefined, buyer))).order
    assert.equal(viewed.mode, 'live'); assert.equal(viewed.status, 'success'); assert.equal(viewed.paymentStatus, 'paid')
    assert.equal((await call('/api/orders/' + order.id, undefined, stranger)).status, 404)
  }
  const accountRead = (await json(await call('/api/orders/' + account.id, undefined, buyer))).order
  assert.equal(accountRead.delivery.value, delivery); assert.equal(accountRead.serviceDelivery.provider, 'muse')
  const list = await json(await call('/api/orders', undefined, buyer))
  assert.equal(list.orders.length, 3)
  // A fresh browser must recover through the public emailed-code flow after
  // rollback. Do not insert a customer session or transfer order ownership.
  const ownershipBeforeRecovery = s.db.prepare('SELECT id,owner_hash,customer_email FROM orders ORDER BY id').all()
  const recoveredBrowser = await buyerCookie()
  assert.equal((await call('/api/orders/' + account.id, undefined, recoveredBrowser)).status, 404)
  assert.equal((await json(await call('/api/orders', undefined, recoveredBrowser))).orders.length, 0)
  const challengeResponse = await json(await call('/api/orders/recovery/send', { email: 'buyer@example.test' }, recoveredBrowser))
  const code = recoveryCodes.get(challengeResponse.challenge)
  assert.ok(code, 'Read verification code from intercepted email only')
  const verified = await call('/api/orders/recovery/verify', { challenge: challengeResponse.challenge, code }, recoveredBrowser)
  await json(verified)
  const recoveryCookie = verified.headers.get('Set-Cookie')!.split(';')[0]
  const recovered = recoveredBrowser + '; ' + recoveryCookie
  assert.equal((await json(await call('/api/orders/recovery/session', undefined, recovered))).email, 'buyer@example.test')
  const recoveredList = await json(await call('/api/orders', undefined, recovered))
  assert.equal(recoveredList.recoveryEmail, 'buyer@example.test')
  assert.deepEqual(recoveredList.orders.map((o: any) => o.id).sort(), [plus.id, codex.id, account.id].sort())
  assert.equal((await json(await call('/api/orders/' + account.id, undefined, recovered))).order.delivery.value, delivery)
  assert.equal((await call('/api/orders/recovery/verify', { challenge: challengeResponse.challenge, code }, recoveredBrowser)).status, 401)
  assert.deepEqual(s.db.prepare('SELECT id,owner_hash,customer_email FROM orders ORDER BY id').all(), ownershipBeforeRecovery)
  assert.equal((await call('/api/orders/' + account.id, undefined, stranger)).status, 404)
  assert.equal(nativeCreates.get(account.id), 1); assert.equal(nativeDeliveryReads.get(account.id), 1)
  assert.equal(rechargeCreates.get(plus.id), 1); assert.equal(rechargeCreates.get(codex.id), 1)
  assert.equal(redemptionCreates.get(plusRemote.order_id), 1); assert.equal(redemptionCreates.get(codexRemote.order_id), 1)
  assert.ok(challengeCalls >= 4); assert.ok(emailKeys.size > 0)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM order_events').all()), /NOT-A-REAL-PASSWORD|NOT-A-REAL-SESSION/)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM fulfillment_tasks').all()), /NOT-A-REAL-PASSWORD/)
  assert.deepEqual(forbiddenNetwork, [], 'No unexpected network target or invalid outbound protocol may be swallowed')
  for (const key of protectedKeys) assert.equal((env as unknown as Record<string, unknown>)[key], production[key], key)
  assertVariables()
  t.diagnostic(JSON.stringify({ protocolSimulationOnly: true, syntheticCatalogFixture: true, retailCents: { plus: 13800, codex500: 19900, gptAccount: 8500 }, realExternalRequests: 0, sameDatabaseAcrossRollback: true, allProductionVariablesAudited: Object.keys(production).length, protectedProductionKeys: protectedKeys.length, candidateOrders: ['Plus pending', 'Codex 500 processing', 'GPTibo gpt-plus-account processing via ZPAY'], baselineFinalPaidSuccess: 3, baselineEmailRecovery: { normalPublicApi: true, codeFromInterceptedMail: true, recoveredOriginalOrders: 3, unchangedOrderOwnership: true, codeReplayDenied: true, foreignBuyerDenied: true }, supplierPurchases: [...nativeCreates.values()].reduce((a, b) => a + b, 0), rechargeOrders: rechargeCreates.size, rechargeSubmissions: redemptionCreates.size, verifiedCallbacks: ['ZPAY MD5 plus authoritative query', 'Recharge HMAC', 'Native supplier HMAC'], turnstileEnabled: env.TURNSTILE_ENABLED, mailIdempotencyKeys: emailKeys.size }))
})

test('production flags: main-store HTML and catalog make zero external calls; concurrent SEO reads share only the SEO budget', async t => {
  const s = await productionFixture(t)
  let outbound = 0, reads = 0, vaultChecks = 0, limits = 0, buyerLimits = 0
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('Public catalog must never contact external providers') })
  const db = s.env.INTEREST_DB
  s.env.INTEREST_DB = { ...db, prepare(sql) { reads++; if (/FROM inventory_key/.test(sql)) vaultChecks++; return db.prepare(sql) } }
  s.env.SEO_CATALOG_LIMITER.limit = async () => { limits++; return { success: true } }
  s.env.API_LIMITER.limit = async () => { buyerLimits++; return { success: true } }
  const responses = await Promise.all(Array.from({ length: 25 }, (_, n) => candidate.fetch(new Request(origin + (n % 2 ? '/product/chatgpt?src=' + n : '/')), s.env)))
  for (const response of responses) { assert.equal(response.status, 200); assert.match(await response.text(), /id="storefront-public-catalog"/) }
  // Enabled service payments check the inventory key twice (normal and Muse
  // payment routes). The earlier disabled-checkout fixture had only seven reads.
  assert.equal(limits, 1); assert.equal(reads, 9); assert.equal(vaultChecks, 2); assert.equal(buyerLimits, 0); assert.equal(outbound, 0)
  const catalog = await candidate.fetch(new Request(origin + '/api/catalog'), s.env)
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).checkoutEnabled, true)
  assert.equal(outbound, 0); assert.equal(buyerLimits, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  s.assertVariables()
  t.diagnostic(JSON.stringify({ productionFlagsPreserved: true, concurrentPublicPages: 25, seoCatalogReadBatches: limits, d1SelectsPerBatch: 9, inventoryKeyChecksIncluded: 2, publicAndBuyerCatalogExternalRequests: outbound }))
})

test('production flags: denied SEO budget and failed catalog reads preserve buyer initialization and standalone help', async t => {
  for (const mode of ['budget-denied', 'catalog-read-error', 'catalog-read-stalled'] as const) {
    const s = await productionFixture(t)
    let outbound = 0, reads = 0, limits = 0, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('External requests forbidden') })
    const db = s.env.INTEREST_DB
    s.env.INTEREST_DB = { ...db, prepare(sql) {
      const q = db.prepare(sql)
      if (!/\bFROM\s+catalog_plans\b/i.test(sql)) return q
      reads++
      const wrap = (item: typeof q): typeof q => ({ bind(...values) { return wrap(item.bind(...values)) }, async first<T>() { if (mode === 'catalog-read-stalled') await gate; else throw new Error('Isolated catalog failure'); return item.first<T>() }, async all<T>() { if (mode === 'catalog-read-stalled') await gate; else throw new Error('Isolated catalog failure'); return item.all<T>() }, run: () => item.run() })
      return wrap(q)
    } }
    s.env.SEO_CATALOG_LIMITER.limit = async () => { limits++; return { success: mode !== 'budget-denied' } }
    const start = performance.now(), response = await candidate.fetch(new Request(origin + '/'), s.env), elapsed = performance.now() - start
    assert.equal(response.status, 200); assert.match(response.headers.get('X-Robots-Tag')!, /noindex/)
    assert.doesNotMatch(await response.text(), /id="storefront-public-catalog"/)
    if (mode === 'budget-denied') assert.equal(reads, 0)
    if (mode === 'catalog-read-stalled') assert.ok(elapsed >= 1400 && elapsed < 2500, 'Stalled SEO must return around the 1.5 second deadline')
    const client = await candidate.fetch(new Request(origin + '/api/orders/client', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }), s.env)
    assert.equal(client.status, 200); assert.ok(client.headers.get('Set-Cookie'))
    const help = await candidate.fetch(new Request(origin + '/help/order-recovery'), s.env)
    assert.equal(help.status, 200); assert.match(await help.text(), /关闭页面后如何找回订单/)
    assert.equal(outbound, 0); assert.equal(limits, 1)
    release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    s.assertVariables()
    t.diagnostic(JSON.stringify({ mode, buyerInitialization: 'available', standaloneHelp: 'available', externalRequests: outbound, elapsedMs: Math.round(elapsed) }))
  }
})
