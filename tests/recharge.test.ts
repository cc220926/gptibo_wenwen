import { seedAdminEmailCode } from './admin-email-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { alipayQr, canonicalQuery, request as supplierRequest, signature, marginCents, moneyCents, productMap, RechargeError } from '../worker/recharge/client.ts'
import { reconcileRecharge } from '../worker/recharge/service.ts'
import { purgeRetainedCredentials, retainedCredential, retainedRequest } from '../worker/recharge/saved-credentials.ts'
import { getOrder } from '../worker/order-state.ts'
import { orderLabel } from '../src/lib/demo-orders.ts'
import { confirmedRefundLabel } from '../shared/platform-order-status.ts'
import { reconcileRechargeRefunds } from '../worker/refunds.ts'
import { totpCode } from '../worker/totp.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const secret = 'private-test-api-secret'
const webhookSecret = 'private-test-webhook-secret'
const session = JSON.stringify({ user: { email: 'target@example.test' }, accessToken: 'PRIVATE-TOKEN-NOT-FOR-STORAGE' })
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const mac = (s: string, key = secret) => createHmac('sha256', key).update(s).digest('hex')
function setup(t: Context) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  const bound = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = {
    ASSETS: { fetch: async () => new Response('asset') }, INTEREST_LIMITER: { limit: async () => ({ success: true }) }, API_LIMITER: { limit: async () => ({ success: true }) }, EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    ADMIN_EMAIL: 'admin@example.invalid', ADMIN_USERNAME: 'tester', ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    RECHARGE_PARTNER_ID: 'pt_test', RECHARGE_KEY_ID: 'key_test', RECHARGE_CLIENT_SECRET: secret, RECHARGE_WEBHOOK_SECRET: webhookSecret, RECHARGE_NOTIFY_URL: 'https://shop.example.invalid/api/recharge/webhook', RECHARGE_PRODUCT_MAP: '{"plus":"demo_plus"}', RECHARGE_CHECKOUT_ENABLED: 'true',
    INTEREST_DB: {
      prepare(sql) {
        const state = { sql, values: [] as Value[] }
        const stmt: Statement = { bind(...values) { state.values = values; return this }, async first<T>() { return (db.prepare(sql).get(...state.values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...state.values) as T[] } }, async run() { return db.prepare(sql).run(...state.values) } }
        bound.set(stmt, state); return stmt
      },
      async batch(statements) {
        db.exec('BEGIN')
        try { const results = statements.map(s => { const state = bound.get(s)!; const query = db.prepare(state.sql); return /^\s*SELECT\b/i.test(state.sql) ? { results: query.all(...state.values) } : query.run(...state.values) }); db.exec('COMMIT'); return results }
        catch (e) { db.exec('ROLLBACK'); throw e }
      },
    },
  }
  const call = (path: string, data?: unknown, cookie = '', origin = 'https://shop.example.invalid') => worker.fetch(new Request('https://shop.example.invalid' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  const buyer = async () => (await call('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const create = async (cookie: string, key = crypto.randomUUID()) => {
    const response = await call('/api/orders', { plan: 'plus', expectedPrice: 13900, email: 'buyer@example.test', key }, cookie)
    assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).order
  }
  const login = async () => (await call('/api/admin/login', { username: 'tester', code: await totpCode(env.ADMIN_TOTP_SECRET!), ...await seedAdminEmailCode(db, env) })).headers.get('Set-Cookie')!.split(';')[0]
  let merchant = ''; let retail = '139.00'; let payment = 'pending'; let taskStatus = 'queued'; let fallback = false; let refundStatus = 'requested'; let refundNo = ''; let refundAmount = '139.00'
  let redemptionId = 'ful_test'; const redemptionKeys = new Map<string, string>()
  let faceToFace = false; let qr: string | null = null
  let expiry = new Date(Date.now() + 900000).toISOString()
  let quotePatch: Record<string, unknown> = {}
  const calls: { path: string; body: string; key: string; nonce: string }[] = []
  const products = [{ product_code: 'demo_plus', supply_price: '110.00', max_sale_price: '159.00', currency: 'CNY', max_quantity: 1, available: true, delivery_modes: ['auto_recharge', 'cdk'] }]
  const remoteOrder = () => ({ order_id: 'ord_test', merchant_order_no: merchant, product_code: products[0].product_code, quantity: 1, sale_amount: retail, supply_amount: products[0].supply_price, merchant_margin: Math.max(0, Number(retail) - Number(products[0].supply_price) - (refundStatus === 'succeeded' ? Number(refundAmount) : 0)).toFixed(2), currency: 'CNY', collection_mode: 'platform_collect', payment_scope: 'retail', delivery_mode: 'auto_recharge', payment_status: payment, qr_payload: faceToFace ? 'https://recharge.example.invalid/payments/ord_test?token=public-test-token-123456' : 'https://recharge.example.invalid/pay/example', expires_at: expiry, refunded_amount: refundStatus === 'succeeded' ? refundAmount : '0.00' })
  const redemption = () => ({ redemption_id: redemptionId, attempt_no: Math.max(1, redemptionKeys.size), order_id: 'ord_test', status: taskStatus, failure_code: taskStatus === 'failed' ? 'session_invalid' : null, fallback_recharge_available: fallback, retry_allowed: fallback, next_action: fallback ? 'resubmit' : ['queued','running'].includes(taskStatus) ? 'wait' : 'none', account_email_masked: 't***@example.test', finished_at: ['succeeded','failed'].includes(taskStatus) ? new Date().toISOString() : null, message: 'PRIVATE-TOKEN-NOT-FOR-STORAGE' })
  const remoteRefund = () => ({ refund_id: 'rf_test', order_id: 'ord_test', merchant_refund_no: refundNo, amount: refundAmount, status: refundStatus })
  let override: ((path: string, raw: string) => Response | Promise<Response | undefined> | undefined) | undefined
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    const url = new URL(input); const headers = new Headers(options.headers); const raw = String(options.body ?? '')
    assert.equal(url.origin, 'https://recharge.example.invalid'); assert.equal(options.redirect, 'manual')
    if (url.pathname.startsWith('/payments/')) {
      assert.equal(url.search, '?token=public-test-token-123456')
      assert.equal(headers.get('X-Signature'), null)
      calls.push({ path: url.pathname, body: raw, key: '', nonce: '' })
      const changed = await override?.(url.pathname, raw); if (changed) return changed
      if (url.pathname.endsWith('/start')) { assert.equal(options.method, 'POST'); qr = 'https://qr.alipay.com/bax01234567890' }
      else assert.equal(options.method, 'GET')
      return Response.json({ status: payment, amount: retail, expires_at: expiry, expired: false, can_start: true, qr_code: qr, delivery_mode: 'auto_recharge', ...quotePatch })
    }
    assert.equal(headers.get('X-Partner-Id'), env.RECHARGE_PARTNER_ID); assert.equal(headers.get('X-Key-Id'), env.RECHARGE_KEY_ID)
    const canonical = [options.method, url.pathname, '', headers.get('X-Timestamp'), headers.get('X-Nonce'), headers.get('X-Key-Id'), headers.get('Idempotency-Key') ?? '', digest(raw)].join('\n')
    assert.equal(headers.get('X-Signature'), mac(canonical))
    calls.push({ path: url.pathname, body: raw, key: headers.get('Idempotency-Key') ?? '', nonce: headers.get('X-Nonce')! })
    const changed = await override?.(url.pathname, raw); if (changed) return changed
    let data: unknown
    if (url.pathname === '/v1/products') data = products
    else if (url.pathname === '/v1/payment-methods') data = [{ code: 'alipay' }]
    else if (url.pathname === '/v1/orders' && options.method === 'POST') { const payload = JSON.parse(raw); merchant = payload.merchant_order_no; retail = payload.sale_amount; data = remoteOrder() }
    else if (url.pathname === '/v1/orders/ord_test') data = remoteOrder()
    else if (url.pathname === '/v1/redemptions' && options.method === 'POST') { const key = headers.get('Idempotency-Key')!; if (!redemptionKeys.has(key)) redemptionKeys.set(key, redemptionKeys.size === 0 ? 'ful_test' : 'ful_test_' + (redemptionKeys.size + 1)); redemptionId = redemptionKeys.get(key)!; data = redemption() }
    else if (url.pathname.startsWith('/v1/redemptions/ful_test')) data = redemption()
    else if (url.pathname === '/v1/orders/ord_test/refunds') { const value = JSON.parse(raw); refundNo = value.merchant_refund_no; refundAmount = value.amount; data = remoteRefund() }
    else if (url.pathname === '/v1/refunds/rf_test') data = remoteRefund()
    else throw new Error('Unexpected mocked endpoint')
    return Response.json({ data })
  })
  const query = (id: string, cookie: string) => call(`/api/orders/${id}/fulfillment`, { action: 'query' }, cookie)
  const submit = (id: string, cookie: string, key = crypto.randomUUID(), value = session) => call(`/api/orders/${id}/fulfillment`, { action: 'submit', key, customerConfirmedEmail: true, credential: { mode: 'session', session: value } }, cookie)
  const partner = () => {
    env.PARTNER_AUTH_SECRET = 'partner-auth-private-secret-of-at-least-32-characters'
    const token = 'a'.repeat(64); const now = Date.now()
    db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('partner-test','partner-test','测试代理','partner@example.test',now,now)
    db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,?,?,?)').run('partner-test','plus',11000,15900)
    db.prepare('INSERT INTO partner_sessions(token_hash,partner_id,auth_version,credential_version,expires_at) VALUES (?,?,?,?,?)').run(digest(token),'partner-test',0,digest(env.PARTNER_AUTH_SECRET),now+3600000)
    return '__Host-ymx_partner=' + token
  }
  const notice = (id: string) => {
    const stamp = String(Math.floor(Date.now()/1000)); const raw = JSON.stringify({ event_id: id, type: 'refund.succeeded', data: { order_id: 'ord_test' } })
    return worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'refund.succeeded', 'X-Quefa-Event-Id': id, 'X-Quefa-Delivery': 'dlv_'+id, 'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': `t=${stamp},v1=${mac(stamp+'.'+raw,webhookSecret)}` }, body: raw }), env)
  }
  return { db, env, call, buyer, create, query, submit, login, partner, notice, calls, products, remoteOrder, redemption, faceToFace: () => { faceToFace = true }, quote: (patch: Record<string, unknown>) => { quotePatch = patch }, setExpiry: (value: number) => { expiry = new Date(value).toISOString() }, setQr: (value: string | null) => { qr = value }, setPayment: (v: string) => { payment = v }, setTask: (v: string, retry = false) => { taskStatus = v; fallback = retry }, setRefund: (v: string) => { refundStatus = v }, override: (v: typeof override) => { override = v } }
}

test('separate Codex mapping preserves subscription SKUs and rejects point-tier swaps or conflicting mappings', t => {
  const s = setup(t)
  assert.deepEqual(productMap(s.env), { plus: 'demo_plus' })
  s.env.RECHARGE_CODEX_PRODUCT_MAP = '{"codex-credits-250":"chatgpt_codex_250_cdk","codex-credits-500":"chatgpt_codex_500_cdk"}'
  assert.deepEqual(productMap(s.env), { plus: 'demo_plus', 'codex-credits-250': 'chatgpt_codex_250_cdk', 'codex-credits-500': 'chatgpt_codex_500_cdk' })
  s.env.RECHARGE_CODEX_PRODUCT_MAP = '{"codex-credits-250":"chatgpt_codex_500_cdk"}'
  assert.throws(() => productMap(s.env), /映射配置无效/)
  s.env.RECHARGE_CODEX_PRODUCT_MAP = '{"plus":"chatgpt_codex_250_cdk"}'
  assert.throws(() => productMap(s.env), /映射配置无效/)
  s.env.RECHARGE_CODEX_PRODUCT_MAP = '{"codex-credits-250":"chatgpt_codex_250_cdk"}'
  s.env.RECHARGE_PRODUCT_MAP = '{"codex-credits-250":"another_sku"}'
  assert.throws(() => productMap(s.env), /映射配置无效/)
  // A tier configured only in the general map is still bound to its fixed SKU.
  delete s.env.RECHARGE_CODEX_PRODUCT_MAP
  s.env.RECHARGE_PRODUCT_MAP = '{"plus":"demo_plus","codex-credits-500":"chatgpt_codex_250_cdk"}'
  assert.throws(() => productMap(s.env), /映射配置无效/)
  s.env.RECHARGE_PRODUCT_MAP = '{"plus":"demo_plus","codex-credits-500":"chatgpt_codex_500_cdk"}'
  assert.deepEqual(productMap(s.env), { plus: 'demo_plus', 'codex-credits-500': 'chatgpt_codex_500_cdk' })
})

for (const [plan, points, price, supply] of [['codex-credits-250', 250, 9900, '78.82'], ['codex-credits-500', 500, 19900, '156.33']] as const) {
  test(`Codex ${points} points freeze the correct SKU and retail price, require verified payment and finish only after recharge success`, async t => {
    const s = setup(t), buyer = await s.buyer()
    const product = `chatgpt_codex_${points}_cdk`
    s.env.RECHARGE_CODEX_PRODUCT_MAP = JSON.stringify({ [plan]: product })
    Object.assign(s.products[0], { product_code: product, supply_price: supply })
    const payload = { plan, expectedPrice: price, email: 'buyer@example.test', key: crypto.randomUUID() }
    const response = await s.call('/api/orders', payload, buyer)
    assert.equal(response.status, 201, await response.clone().text())
    const order = (await response.json()).order
    assert.equal(order.price, price / 100); assert.equal(order.planName, `${points} 点`)
    assert.equal(order.manualFulfillment, false)
    assert.equal((await (await s.call('/api/orders', payload, buyer)).json()).order.id, order.id)
    const snapshot = JSON.parse(s.db.prepare('SELECT create_body FROM recharge_orders WHERE order_id=?').get(order.id)!.create_body as string)
    assert.equal(snapshot.product_code, product); assert.equal(snapshot.sale_amount, (price / 100).toFixed(2))
    assert.equal(snapshot.quantity, 1); assert.equal(snapshot.delivery_mode, 'auto_recharge')
    assert.equal(snapshot.collection_mode, 'platform_collect')
    assert.equal((await s.submit(order.id, buyer)).status, 409)
    await s.query(order.id, buyer); s.setPayment('paid')
    assert.equal((await (await s.query(order.id, buyer)).json()).order.status, 'session')
    const key = crypto.randomUUID()
    assert.equal((await s.submit(order.id, buyer, key)).status, 200)
    assert.equal((await s.submit(order.id, buyer, key)).status, 200)
    assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
    assert.equal((await (await s.query(order.id, buyer)).json()).order.status, 'processing')
    s.setTask('succeeded')
    const completed = (await (await s.query(order.id, buyer)).json()).order
    assert.equal(completed.status, 'success'); assert.equal(orderLabel(completed), '已完成')
    assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM recharge_redemptions').all()), /PRIVATE-TOKEN-NOT-FOR-STORAGE/)
  })

  test(`Codex ${points} points reject changed prices, unavailable supply, CDK-only products and foreign buyers`, async t => {
    const s = setup(t), buyer = await s.buyer()
    s.env.RECHARGE_CODEX_PRODUCT_MAP = JSON.stringify({ [plan]: `chatgpt_codex_${points}_cdk` })
    Object.assign(s.products[0], { product_code: `chatgpt_codex_${points}_cdk`, supply_price: supply })
    const create = (expectedPrice = price) => s.call('/api/orders', { plan, expectedPrice, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
    assert.equal((await create(price - 100)).status, 409)
    s.products[0].available = false; assert.equal((await create()).status, 409)
    s.products[0].available = true; s.products[0].delivery_modes = ['cdk']; assert.equal((await create()).status, 409)
    s.products[0].delivery_modes = ['auto_recharge']; s.products[0].supply_price = '250.00'; assert.equal((await create()).status, 409)
    s.products[0].supply_price = supply
    const response = await create(); assert.equal(response.status, 201, await response.clone().text())
    const order = (await response.json()).order
    assert.equal((await s.submit(order.id, await s.buyer())).status, 404)
    assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
  })
}

async function retainedSetup(t: Context, rawSession = session) {
  const s = setup(t)
  s.env.CDK_ENCRYPTION_KEY = Buffer.alloc(32, 51).toString('base64')
  s.env.RECHARGE_SAVED_CREDENTIALS_ENABLED = 'true'
  const buyer = await s.buyer(), order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const key = crypto.randomUUID()
  const submit = (raw: string, retain = true, attemptKey = crypto.randomUUID()) => s.call(`/api/orders/${order.id}/fulfillment`, { action: 'submit', key: attemptKey, customerConfirmedEmail: true, retainCredential: retain, credential: { mode: 'session', session: raw } }, buyer)
  assert.equal((await submit(rawSession, true, key)).status, 200)
  const read = async () => (await (await s.call('/api/orders/' + order.id, undefined, buyer)).json()).order
  const failSubscription = async () => {
    s.setTask('failed', true)
    s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), failure_code: 'account_has_subscription' } }) : undefined)
    return (await (await s.query(order.id, buyer)).json()).order
  }
  const reuse = (source = key, attemptKey = crypto.randomUUID(), cookie = buyer) => s.call(`/api/orders/${order.id}/fulfillment`, { action: 'retry-saved', key: attemptKey, sourceAttemptId: source, customerConfirmedEmail: true }, cookie)
  return { ...s, buyer, order, key, submitSaved: submit, read, failSubscription, reuse }
}

test('channel two fixed-price direct orders forward long complete Session JSON without issuing or storing a CDK', async t => {
  const s = setup(t); Object.assign(s.products[0], { fulfillment_mode: 'direct' })
  const buyer = await s.buyer(), order = await s.create(buyer)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_mode: 'direct', voucher_code: null } }) : undefined)
  await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  const raw = JSON.stringify({ user:{email:'target@example.test'},account:{id:'account-two'},accessToken:'PRIVATE-FULL-TOKEN',extra:'x'.repeat(150000) })
  const result = await s.submit(order.id,buyer,crypto.randomUUID(),raw)
  assert.equal(result.status,200,await result.clone().text())
  assert.equal(JSON.parse(s.calls.find(c=>c.path==='/v1/redemptions')!.body).credential.session,raw)
  s.setTask('succeeded'); const done=(await (await s.query(order.id,buyer)).json()).order
  assert.equal(done.status,'success'); assert.equal(done.fulfillment.canSubmit,false)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n,0)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM order_events').all()),/PRIVATE-FULL-TOKEN|account-two/)
})

test('channel two full_session_required is a definitive non-submission and permits complete JSON on the same paid order', async t => {
  const s=setup(t),buyer=await s.buyer(),order=await s.create(buyer)
  await s.query(order.id,buyer);s.setPayment('paid');await s.query(order.id,buyer)
  s.override(path=>path==='/v1/redemptions'?Response.json({error:{code:'full_session_required',retryable:false,message:'PRIVATE-FULL-TOKEN'}},{status:422}):undefined)
  const denied=await s.submit(order.id,buyer)
  assert.match(await denied.text(),/完整.*Session/)
  const current=(await(await s.call('/api/orders/'+order.id,undefined,buyer)).json()).order
  assert.equal(current.status,'failed');assert.equal(current.fulfillment.canSubmit,true)
  assert.equal(current.fulfillment.failureCode,'full_session_required')
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status,'rejected')
  s.override(undefined)
  const raw=JSON.stringify({user:{email:'target@example.test'},account_id:'account-two',accessToken:'PRIVATE-FULL-TOKEN'})
  assert.equal((await s.submit(order.id,buyer,crypto.randomUUID(),raw)).status,200)
  assert.equal(s.calls.filter(c=>c.path==='/v1/orders').length,1)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM recharge_redemptions').all()),/PRIVATE-FULL-TOKEN/)
})

test('channel two terminal retry uses explicit permission rather than the CDK fallback bit; queued and running remain blocked', async t => {
  for(const status of ['queued','running','failed','cancelled']) {
    const s=setup(t),buyer=await s.buyer(),order=await s.create(buyer)
    await s.query(order.id,buyer);s.setPayment('paid');await s.query(order.id,buyer);await s.submit(order.id,buyer)
    s.override(path=>path.startsWith('/v1/redemptions/')?Response.json({data:{...s.redemption(),status,failure_code:status==='failed'?'session_invalid':null,fallback_recharge_available:false,retry_allowed:true,next_action:'resubmit',finished_at:['failed','cancelled'].includes(status)?new Date().toISOString():null}}):undefined)
    const current=(await(await s.query(order.id,buyer)).json()).order
    const permitted=['failed','cancelled'].includes(status)
    assert.equal(current.fulfillment.canSubmit,permitted)
    s.override(undefined);s.setTask('queued')
    assert.equal((await s.submit(order.id,buyer)).status,permitted?200:409)
    assert.equal(s.calls.filter(c=>c.path==='/v1/orders').length,1)
    t.mock.restoreAll()
  }
})

test('full-session errors with ambiguous HTTP status or retryability keep the original attempt unknown', async t => {
  for (const [http,retryable] of [[503,false],[422,true],[202,false]] as const) {
    const s=setup(t),buyer=await s.buyer(),order=await s.create(buyer)
    await s.query(order.id,buyer);s.setPayment('paid');await s.query(order.id,buyer)
    s.override(path=>path==='/v1/redemptions'?Response.json({error:{code:'full_session_required',retryable}},{status:http}):undefined)
    await s.submit(order.id,buyer)
    assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status,'unknown')
    assert.equal((await s.submit(order.id,buyer,crypto.randomUUID(),session)).status,409)
    assert.equal(s.calls.filter(c=>c.path==='/v1/redemptions').length,1)
    t.mock.restoreAll()
  }
})

test('unpriced channel two product drafts cannot be sold even if erroneously marked available', async t => {
  const s=setup(t);s.products[0].supply_price='0.00'
  const buyer=await s.buyer()
  const r=await s.call('/api/orders',{plan:'plus',expectedPrice:13900,email:'buyer@example.test',key:crypto.randomUUID()},buyer)
  assert.equal(r.status,409)
  assert.equal(s.calls.filter(c=>c.path==='/v1/orders').length,0)
})

test('202 preflight_pending never becomes a successful result and carries a safe wait interval', async t => {
  const s=setup(t)
  s.override(path=>path.endsWith('/preflight')?Response.json({error:{code:'preflight_pending',retryable:true}},{status:202}):undefined)
  await assert.rejects(supplierRequest(s.env,'/products/demo_plus/preflight',JSON.stringify({credential:{mode:'session',session}}),'preflight:'+crypto.randomUUID()),e=>e instanceof RechargeError&&e.code==='preflight_pending'&&e.retryable&&e.retryAfter!>=5)
  assert.equal(s.calls.filter(c=>c.path==='/v1/redemptions'||c.path==='/v1/orders').length,0)
})

test('disabled Session retention ignores old client opt-ins while allowing ordinary paid submission', async t => {
  for (const flag of [undefined, 'false']) {
    const s = setup(t); s.env.CDK_ENCRYPTION_KEY = Buffer.alloc(32, 51).toString('base64')
    s.env.RECHARGE_SAVED_CREDENTIALS_ENABLED = flag
    const buyer = await s.buyer(), order = await s.create(buyer)
    await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
    const r = await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'submit', key: crypto.randomUUID(), customerConfirmedEmail: true, retainCredential: true, credential: { mode: 'session', session } }, buyer)
    assert.equal(r.status, 200, await r.clone().text())
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0)
    const current = (await r.json()).order
    assert.equal(current.fulfillment.canRetainCredential, false)
    assert.equal(current.fulfillment.savedCredential, null)
    assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
    t.mock.restoreAll()
  }
})

test('disabling Session retention blocks stale saved-retry buttons but permits a replacement Session', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  s.env.RECHARGE_SAVED_CREDENTIALS_ENABLED = 'false'
  const before = s.calls.length
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.length, before)
  const current = await s.read()
  assert.equal(current.fulfillment.canRetainCredential, false)
  assert.equal(current.fulfillment.savedCredential, null)
  s.override(undefined); s.setTask('queued')
  assert.equal((await s.submitSaved(session.replace('PRIVATE-TOKEN', 'REPLACEMENT-TOKEN'))).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
})

test('disabled Session retention clears saved snapshots after active submissions finish without altering orders', async t => {
  const s = await retainedSetup(t)
  s.env.RECHARGE_SAVED_CREDENTIALS_ENABLED = 'false'
  const before = s.db.prepare('SELECT status,payment_status,version FROM orders').get()
  s.db.prepare('UPDATE recharge_orders SET lease_until=?').run(Date.now() + 60000)
  await purgeRetainedCredentials(s.env)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 1)
  s.db.prepare('UPDATE recharge_orders SET lease_until=0').run()
  await purgeRetainedCredentials(s.env)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0)
  assert.deepEqual(s.db.prepare('SELECT status,payment_status,version FROM orders').get(), before)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 1)
})

test('saved Session is encrypted and order scoped; failure exposes only safe retry metadata', async t => {
  const s = await retainedSetup(t)
  const before = await s.read()
  assert.equal(before.fulfillment.canRetainCredential, true)
  assert.equal(before.fulfillment.savedCredential.canReuse, false)
  const current = await s.failSubscription()
  assert.equal(current.fulfillment.savedCredential.canReuse, true)
  assert.equal(current.fulfillment.savedCredential.attemptId, s.key)
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE-TOKEN|encrypted_request|request_hash/)
  const stored = s.db.prepare('SELECT * FROM recharge_saved_credentials').get()!
  assert.notEqual(stored.encrypted_request, session)
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE-TOKEN|target@example/)
  assert.equal(Number(stored.retain_until) - Number(stored.saved_at), 30 * 86400000)
  const stranger = (await s.call('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.reuse(s.key, crypto.randomUUID(), stranger)).status, 404)
  const admin = await s.login()
  assert.doesNotMatch(await (await s.call('/api/admin/orders', undefined, admin)).text(), /PRIVATE-TOKEN|encrypted_request/)
})

test('reuse creates one new attempt on the same paid order, preserving exact bytes and retention deadline', async t => {
  const exact = '  ' + session + '\n', s = await retainedSetup(t, exact)
  await s.failSubscription()
  const until = s.db.prepare('SELECT retain_until FROM recharge_saved_credentials').get()!.retain_until
  const retryKey = crypto.randomUUID()
  const response = await s.reuse(s.key, retryKey)
  assert.equal(response.status, 200, await response.clone().text())
  const posts = s.calls.filter(c => c.path === '/v1/redemptions')
  assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body)
  assert.equal(JSON.parse(posts[1].body).credential.session, exact)
  assert.notEqual(posts[0].key, posts[1].key)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.db.prepare('SELECT retain_until FROM recharge_saved_credentials').get()!.retain_until, until)
  assert.equal((await s.reuse(s.key, retryKey)).status, 200)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 2)
})

test('a newly submitted Session replaces saved data; a stale original-data button cannot reuse the replacement', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  const replacement = JSON.stringify({ user: { email: 'replacement@example.test' }, accessToken: 'REPLACEMENT-TOKEN' })
  s.override(undefined); s.setTask('queued')
  assert.equal((await s.submitSaved(replacement)).status, 200)
  await s.failSubscription()
  const count = s.calls.filter(c => c.path === '/v1/redemptions').length
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, count)
  const next = (await s.read()).fulfillment.savedCredential.attemptId
  assert.equal((await s.reuse(next)).status, 200)
  assert.equal(JSON.parse(s.calls.filter(c => c.path === '/v1/redemptions').at(-1)!.body).credential.session, replacement)
})

test('opting out on a replacement removes the old saved snapshot; old orders without a snapshot require new input', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  s.override(undefined); s.setTask('queued')
  assert.equal((await s.submitSaved(session, false)).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0)
  await s.failSubscription(); assert.equal((await s.read()).fulfillment.savedCredential, null)
  assert.equal((await s.reuse()).status, 409)
})

test('unknown submission reuses the original key and bytes even after token expiry, never creates a second attempt', async t => {
  const s = setup(t); s.env.CDK_ENCRYPTION_KEY = Buffer.alloc(32, 51).toString('base64')
  s.env.RECHARGE_SAVED_CREDENTIALS_ENABLED = 'true'
  const buyer = await s.buyer(), order = await s.create(buyer), key = crypto.randomUUID()
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const raw = JSON.stringify({ user: { email: 'target@example.test' }, accessToken: 'OPAQUE-TOKEN', expires: new Date(Date.now() + 3600000).toISOString() })
  s.override(path => { if (path === '/v1/redemptions') throw new Error('lost request') })
  assert.equal((await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'submit', key, customerConfirmedEmail: true, retainCredential: true, credential: { mode: 'session', session: raw } }, buyer)).status, 503)
  s.db.prepare('UPDATE recharge_saved_credentials SET credential_expires_at=1').run()
  s.override(undefined)
  const response = await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'retry-saved', key, sourceAttemptId: key, customerConfirmedEmail: true }, buyer)
  assert.equal(response.status, 200, await response.clone().text())
  const posts = s.calls.filter(c => c.path === '/v1/redemptions')
  assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key); assert.equal(posts[0].body, posts[1].body)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 1)
})

test('fresh supplier state, pending execution and refund hold all block new saved-data attempts', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), fallback_recharge_available: false, retry_allowed: false, next_action: 'none' } }) : undefined)
  assert.equal((await s.reuse()).status, 409)
  const count = s.calls.filter(c => c.path === '/v1/redemptions').length
  await s.failSubscription()
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(s.order.id)
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, count)
})

test('known-expired or provider-invalid saved credentials require a fresh Session, while new Session remains possible', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  s.db.prepare('UPDATE recharge_saved_credentials SET credential_expires_at=1').run()
  assert.equal((await s.read()).fulfillment.savedCredential.canReuse, false)
  assert.equal((await s.reuse()).status, 409)
  s.db.prepare('UPDATE recharge_saved_credentials SET credential_expires_at=NULL').run()
  s.db.prepare("UPDATE recharge_redemptions SET failure_code='session_invalid'").run()
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), failure_code: 'session_invalid' } }) : undefined)
  const count = s.calls.filter(c => c.path === '/v1/redemptions').length
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, count)
  s.override(undefined); s.setTask('queued')
  assert.equal((await s.submitSaved(session)).status, 200)
})

test('success, refund, redemption stop and retention expiry purge saved secrets', async t => {
  const s = await retainedSetup(t)
  s.setTask('succeeded'); await s.query(s.order.id, s.buyer)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0)
  const cases = ['refund', 'block', 'expiry']
  for (const kind of cases) {
    const next = await retainedSetup(t)
    if (kind === 'refund') next.db.prepare('UPDATE orders SET refunded_cents=1 WHERE id=?').run(next.order.id)
    if (kind === 'block') next.db.prepare('UPDATE orders SET redemption_blocked=1 WHERE id=?').run(next.order.id)
    if (kind === 'expiry') { next.db.prepare('UPDATE recharge_saved_credentials SET saved_at=0,retain_until=1').run(); await purgeRetainedCredentials(next.env) }
    assert.equal(next.db.prepare('SELECT COUNT(*) n FROM recharge_saved_credentials').get()!.n, 0, kind)
  }
})

test('ciphertext corruption, mismatched encryption key and audit rollback do not forward new credentials', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  s.db.prepare("UPDATE recharge_saved_credentials SET encrypted_request='invalid'").run()
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
  s.db.exec("CREATE TRIGGER fail_saved_audit BEFORE INSERT ON order_events WHEN NEW.action='recharge-submit' BEGIN SELECT RAISE(ABORT,'stop'); END")
  assert.equal((await s.submitSaved(session)).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
})

test('saved retries require fresh finance and task reads; query backoff cannot reuse stale retry permission', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ error: { code: 'api_poll_too_frequent', retryable: true, retry_after: 60 } }, { status: 429, headers: { 'Retry-After': '60' } }) : undefined)
  const first = await s.reuse()
  assert.equal(first.ok, false)
  s.override(undefined)
  assert.equal((await s.reuse()).ok, false)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
})

test('simultaneous saved retry clicks serialize before forwarding a new attempt', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  const retry = crypto.randomUUID()
  const results = await Promise.all([s.reuse(s.key, retry), s.reuse(s.key, retry)])
  assert.equal(results.filter(r => r.status === 200).length, 1)
  assert.equal(results.filter(r => r.status === 409).length, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 2)
})

test('a saved retry that outlives its lease stops before preparing or forwarding another attempt', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  s.override(path => {
    if (path === '/v1/orders/ord_test') now += 46000
    if (path.startsWith('/v1/redemptions/')) return Response.json({ data: { ...s.redemption(), failure_code: 'account_has_subscription' } })
  })
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 1)
})

test('unknown ciphertext cannot be moved across orders; the encryption key must match the original vault', async t => {
  const s = await retainedSetup(t); await s.failSubscription()
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  const saved = (await retainedCredential(s.env, s.order.id))!
  const attempt = s.db.prepare('SELECT request_hash FROM recharge_redemptions WHERE id=?').get(s.key)!
  await assert.rejects(() => retainedRequest(s.env, { ...saved, order_id: 'YMX-ANOTHER-ORDER' }, String(attempt.request_hash)), /暂时无法读取/)
  s.env.CDK_ENCRYPTION_KEY = Buffer.alloc(32, 52).toString('base64')
  assert.equal((await s.read()).fulfillment.savedCredential.canReuse, false)
  assert.equal((await s.reuse()).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
})

test('admin can read and search the stored upstream order without contacting the supplier', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  await s.query(order.id, buyer)
  assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders WHERE order_id=?').get(order.id)!.remote_id, 'ord_test')
  const before = s.calls.length
  s.override(() => { throw new Error('supplier unavailable') })
  const detail = (await (await s.call(`/api/admin/orders/${order.id}`, undefined, admin)).json()).order
  assert.equal(detail.platformStatus.remoteId, 'ord_test')
  for (const q of ['ord_test', 'ORD_TEST', 'ord_te', order.id, 'buyer@example.test', ' ord_test ']) {
    const response = await s.call('/api/admin/orders?' + new URLSearchParams({ q }), undefined, admin)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.total, 1); assert.equal(result.orders[0].id, order.id)
    assert.equal(result.orders[0].platformStatus.remoteId, 'ord_test')
  }
  for (const filter of ['q=missing', 'q=ord_test&status=success', 'q=ord_test&plan=pro-5x']) {
    const result = await (await s.call('/api/admin/orders?' + filter, undefined, admin)).json()
    assert.equal(result.total, 0); assert.deepEqual(result.orders, [])
  }
  const customer = (await (await s.call(`/api/orders/${order.id}`, undefined, buyer)).json()).order
  assert.equal(customer.platformStatus, undefined)
  assert.equal((await s.call('/api/admin/orders?q=ord_test', undefined, buyer)).status, 401)
  assert.equal(s.calls.length, before)
})

test('documented request errors retain safe codes, retry hints and diagnostics without replaying writes or exposing prose', async t => {
  const s = setup(t)
  for (const [code, status, retryable] of [
    ['invalid_request', 400, false], ['invalid_signature', 401, false], ['timestamp_out_of_range', 401, false],
    ['nonce_replayed', 409, false], ['ip_not_allowed', 403, false], ['product_not_authorized', 403, false],
    ['order_not_found', 404, false], ['idempotency_conflict', 409, false], ['idempotency_in_progress', 409, false],
    ['invalid_state_transition', 409, false], ['provider_refund_reconciliation_required', 409, false],
    ['price_out_of_range', 422, false], ['rate_limited', 429, true], ['temporarily_unavailable', 503, true],
  ] as const) {
    s.override(() => Response.json({ error: { code, retryable: false, request_id: 'req_body', message: session } }, { status, headers: { 'X-Request-Id': 'req_header', 'Retry-After': '23' } }))
    const before = s.calls.length
    await assert.rejects(supplierRequest(s.env, '/redemptions', '{}', 'test-error-key'), e => {
      assert.ok(e instanceof RechargeError)
      assert.equal(e.code, code); assert.equal(e.retryable, retryable); assert.equal(e.upstreamStatus, status)
      assert.equal(e.requestId, 'req_header'); assert.equal(e.retryAfter, 23)
      assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE-TOKEN|target@example/)
      return true
    })
    assert.equal(s.calls.length, before + 1)
  }
  s.override(() => Response.json({ error: { code: session, retryable: true, request_id: 'req_body', message: session } }, { status: 500, headers: { 'Retry-After': new Date(Date.now() + 60000).toUTCString() } }))
  await assert.rejects(supplierRequest(s.env, '/products'), e => {
    assert.ok(e instanceof RechargeError); assert.equal(e.code, 'request_rejected'); assert.equal(e.requestId, 'req_body'); assert.equal(e.retryable, true)
    assert.ok(e.retryAfter! >= 59 && e.retryAfter! <= 60); assert.doesNotMatch(JSON.stringify(e), /PRIVATE-TOKEN/); return true
  })
})

test('unreadable and malformed responses remain unknown instead of becoming definitive request rejection', async t => {
  const s = setup(t)
  for (const response of [
    new Response('x'.repeat(256001)), new Response(new Uint8Array([0xff])), new Response('{'), Response.json({ data: null }),
    Response.json({ error: { code: 'invalid_request', retryable: false } }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error(session)) } })),
  ]) {
    s.override(() => response)
    await assert.rejects(supplierRequest(s.env, '/products'), e => {
      assert.ok(e instanceof RechargeError); assert.equal(e.code, 'invalid_response'); assert.equal(e.retryable, true)
      assert.doesNotMatch(e.message, /PRIVATE-TOKEN/); return true
    })
  }
})

test('in-progress conflicts preserve the original recharge key and return safe retry metadata', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/redemptions' ? Response.json({ error: { code: 'idempotency_in_progress', retryable: false, message: session, request_id: 'req_private' } }, { status: 409, headers: { 'Retry-After': '15' } }) : undefined)
  const key = crypto.randomUUID(); const response = await s.submit(order.id, buyer, key); const payload = await response.json()
  assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '15')
  assert.equal(payload.code, 'idempotency_in_progress'); assert.equal(payload.retryAfter, 15); assert.match(payload.error, /原请求仍在处理中/)
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE-TOKEN|req_private/)
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions WHERE id=?').get(key)!.status, 'unknown')
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('public result codes supply missing stages without announcing premature success or permitting another recharge', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  let version = 1
  for (const [code, stage] of [['funding_pending', 'preparing_funds'], ['pending', 'confirming'], ['plus_paid', 'upgrading'], ['review', 'review'], ['completed', null]]) {
    s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), status: 'running', result_code: code, error_category: 'confirmation', progress_version: version++ } }, { status: 202 }) : undefined)
    const current = (await (await s.query(order.id, buyer)).json()).order
    assert.equal(current.status, 'processing'); assert.equal(current.fulfillment.canSubmit, false)
    assert.equal(current.fulfillment.progressStage, stage); assert.equal(current.fulfillment.resultCode, code)
    assert.equal(current.fulfillment.errorCategory, 'confirmation')
  }
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('contradictory terminal result snapshots cannot mark success or unlock another attempt', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), status, result_code: 'review', progress_version: 2, retry_allowed: true, fallback_recharge_available: true, next_action: 'resubmit' } }) : undefined)
    assert.equal((await s.query(order.id, buyer)).status, 503)
    assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(order.id)!.status, 'processing')
    assert.equal(s.db.prepare('SELECT fallback FROM recharge_redemptions WHERE order_id=?').get(order.id)!.fallback, 0)
  }
})

test('legacy unversioned result stages advance and a versioned unified stage takes precedence', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  for (const code of ['queued', 'review']) {
    s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), status: 'running', result_code: code } }) : undefined)
    const current = (await (await s.query(order.id, buyer)).json()).order
    assert.equal(current.fulfillment.progressStage, code)
  }
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), status: 'running', result_code: 'pending', progress_stage: 'review', progress_version: 2 } }) : undefined)
  assert.equal((await (await s.query(order.id, buyer)).json()).order.fulfillment.progressStage, 'review')
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), status: 'running', result_code: 'queued', error_category: 'service', progress_version: 1 } }) : undefined)
  const current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.resultCode, 'pending'); assert.equal(current.fulfillment.errorCategory, null)
  assert.equal(current.fulfillment.progressStage, 'review'); assert.equal(current.fulfillment.progressVersion, 2)
})

test('mailbox failures and public error categories give safe reasons while unknown codes never reach storage', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed')
  let patch: Record<string, unknown> = { failure_code: 'mailbox_login_failed', error_category: 'credential', result_code: 'declined', progress_version: 3 }
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), ...patch } }) : undefined)
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.failureCode, 'mailbox_login_failed'); assert.match(current.fulfillment.message, /邮箱登录失败/)
  assert.equal(current.fulfillment.canSubmit, false)
  patch = { failure_code: session, error_category: 'account', result_code: session, progress_version: 4 }
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.failureCode, 'other'); assert.equal(current.fulfillment.resultCode, null)
  assert.match(current.fulfillment.message, /账号状态需要核对/)
  patch = { failure_code: null, error_category: session, result_code: null, progress_version: 5 }
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.errorCategory, null); assert.match(current.fulfillment.message, /联系客服/)
  assert.doesNotMatch(JSON.stringify(current) + JSON.stringify(s.db.prepare('SELECT * FROM recharge_redemptions').all()), /PRIVATE-TOKEN/)
})

test('active-subscription details survive polling without storing supplier prose or replaying a recharge', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed', true)
  let patch: Record<string, unknown> = { failure_code: 'account_has_subscription', progress_version: 3, message: 'PRIVATE-TOKEN target@example.test 当前账号的目标套餐有效至 2026-11-08 05:26，到期后才能再次购买（GPT_PLAN_ALREADY_ACTIVE）' }
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), ...patch } }) : undefined)
  const writes = s.calls.filter(call => call.path === '/v1/redemptions').length
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, true)
  assert.match(current.fulfillment.message, /2026-11-08 05:26/)
  assert.match(current.fulfillment.message, /未注明时区/)
  assert.match(current.fulfillment.message, /本订单重新提交/)
  assert.equal(s.db.prepare('SELECT subscription_expires_hint FROM recharge_redemptions').get()!.subscription_expires_hint, '2026-11-08 05:26')
  assert.doesNotMatch(JSON.stringify(current) + JSON.stringify(s.db.prepare('SELECT * FROM recharge_redemptions').all()), /PRIVATE-TOKEN|target@example/)
  patch = { ...patch, progress_version: 2, message: '目标套餐有效至 2027-01-01 00:00（GPT_PLAN_ALREADY_ACTIVE）' }
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.match(current.fulfillment.message, /2026-11-08 05:26/)
  patch = { ...patch, progress_version: 4, message: '目标套餐有效至 2026-02-30 05:26（GPT_PLAN_ALREADY_ACTIVE）', retry_allowed: false }
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, false)
  assert.doesNotMatch(current.fulfillment.message, /可在本订单重新提交|2026-02-30/)
  assert.equal(s.calls.filter(call => call.path === '/v1/redemptions').length, writes)
  assert.equal(current.paymentStatus, 'paid')
})

test('confirmed recharge progress is versioned per attempt, survives stale or failed queries and never forwards supplier text', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  let version = 2; let stage = 'logging_in'
  const updatedAt = '2026-10-01T02:00:00.000Z'
  s.override(path => path.startsWith('/v1/redemptions') ? Response.json({ data: { ...s.redemption(), status: 'running', progress_stage: stage, progress_version: version, progress_updated_at: updatedAt, attempt_no: 1 } }) : undefined)
  let current = (await (await s.submit(order.id, buyer)).json()).order
  assert.equal(current.status, 'processing')
  assert.equal(current.fulfillment.progressStage, 'logging_in')
  assert.equal(current.fulfillment.progressUpdatedAt, Date.parse(updatedAt))
  assert.equal(current.fulfillment.progressVersion, 2)
  assert.equal(current.fulfillment.attemptNo, 1)
  version = 3; stage = 'upgrading'
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'processing'); assert.equal(current.fulfillment.progressStage, 'upgrading')
  version = 2; stage = 'queued'
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.progressStage, 'upgrading'); assert.equal(current.fulfillment.progressVersion, 3)
  s.override(path => path.startsWith('/v1/redemptions') ? Response.json({ error: { code: 'temporarily_unavailable', retryable: true } }, { status: 503 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  const saved = s.db.prepare('SELECT * FROM recharge_redemptions WHERE order_id=?').get(order.id)!
  assert.equal(saved.status, 'running'); assert.equal(saved.progress_stage, 'upgrading')
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-TOKEN/)
  s.db.prepare('UPDATE recharge_orders SET updated_at=0 WHERE order_id=?').run(order.id)
  const cached = (await (await s.call(`/api/orders/${order.id}`, undefined, buyer)).json()).order
  assert.equal(cached.fulfillment.syncError, true)
  assert.equal(cached.status, 'processing'); assert.equal(cached.fulfillment.progressStage, 'upgrading')
  s.override(path => path.startsWith('/v1/redemptions') ? Response.json({ data: { ...s.redemption(), status: 'running', progress_stage: 'PRIVATE-TOKEN', progress_version: 4 } }) : undefined)
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.progressStage, null); assert.equal(current.status, 'processing')
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE-TOKEN/)
})

test('recovery requires explicit platform retry permission, can be revoked at the same progress version and resets progress for a new attempt', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed', true)
  let allowed = false; let refund = false
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), progress_stage: 'failed', progress_version: 5, retry_allowed: allowed, recovery_action: refund ? 'refund' : 'retry' } }) : undefined)
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, false)
  allowed = true
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, true)
  refund = true
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, false)
  refund = false
  await s.query(order.id, buyer)
  s.override(undefined); s.setTask('queued')
  current = (await (await s.submit(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.attemptNo, 2)
  assert.equal(current.fulfillment.progressStage, null); assert.equal(current.fulfillment.progressVersion, 0)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
})

test('fulfillment.updated is verified, deduplicated and reconciles public progress through the original task', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify({ event_id: 'evt_progress', event: 'fulfillment.updated', data: { order_id: 'ord_test', redemption_id: 'ful_test', attempt_no: 1, status: 'succeeded', progress_stage: 'completed', progress_version: 999 } })
  const notify = () => worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'fulfillment.updated', 'X-Quefa-Event-Id': 'evt_progress', 'X-Quefa-Delivery': 'dlv_progress', 'X-Quefa-Timestamp': timestamp, 'X-Quefa-Signature': `t=${timestamp},v1=${mac(timestamp + '.' + raw, webhookSecret)}` }, body: raw }), s.env)
  assert.equal((await notify()).status, 200); assert.equal((await notify()).status, 200)
  assert.equal(s.db.prepare('SELECT notify_version FROM recharge_orders WHERE order_id=?').get(order.id)!.notify_version, 1)
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(order.id)!.status, 'processing')
  s.override(path => path === '/v1/redemptions/ful_test' ? Response.json({ data: { ...s.redemption(), status: 'running', progress_stage: 'dispatching', progress_version: 3 } }) : undefined)
  await reconcileRecharge(s.env)
  const current = (await (await s.call(`/api/orders/${order.id}`, undefined, buyer)).json()).order
  assert.equal(current.status, 'processing'); assert.equal(current.fulfillment.progressStage, 'dispatching')
  assert.equal(current.fulfillment.progressVersion, 3)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('25x new subscriptions use the confirmed supplier product, verified payment and idempotent automatic recharge', async t => {
  const s = setup(t)
  s.env.RECHARGE_PRODUCT_MAP = JSON.stringify({ 'pro-25x': 'demo_pro_large' })
  Object.assign(s.products[0], { product_code: 'demo_pro_large', supply_price: '3250.00', max_sale_price: '5000.00' })
  const buyer = await s.buyer()
  const payload = { plan: 'pro-25x', expectedPrice: 450000, email: 'buyer@example.test', key: crypto.randomUUID() }
  const catalog = await (await s.call('/api/catalog')).json()
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === 'pro-25x').enabled, 1)
  const created = await s.call('/api/orders', payload, buyer)
  assert.equal(created.status, 201, await created.clone().text())
  const order = (await created.json()).order
  assert.equal(order.mode, 'live'); assert.equal(order.manualFulfillment, false)
  assert.equal(order.planName, 'Pro 25×'); assert.equal(order.fulfillment.canSubmit, false)
  const snapshot = s.db.prepare('SELECT product_code,create_body FROM recharge_orders WHERE order_id=?').get(order.id)!
  assert.equal(snapshot.product_code, 'demo_pro_large')
  const stored = JSON.parse(snapshot.create_body as string)
  assert.equal(stored.delivery_mode, 'auto_recharge'); assert.equal(stored.collection_mode, 'platform_collect')
  assert.equal(stored.sale_amount, '4500.00')
  assert.equal((await (await s.call('/api/orders', payload, buyer)).json()).order.id, order.id)
  assert.equal((await s.call(`/api/orders/${order.id}/payment`, { action: 'create' }, buyer)).status, 409)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
  await s.query(order.id, buyer); s.setPayment('paid')
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'session'); assert.equal(current.paymentStatus, 'paid'); assert.equal(current.fulfillment.canSubmit, true)
  const admin = await s.login()
  assert.equal((await s.call(`/api/admin/orders/${order.id}/actions`, { action: 'manual-complete', version: current.version, note: '不得手工完成自动充值订单' }, admin)).status, 409)
  const key = crypto.randomUUID()
  assert.equal((await s.submit(order.id, buyer, key)).status, 200)
  assert.equal((await s.submit(order.id, buyer, key)).status, 200)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
  current = (await (await s.call(`/api/orders/${order.id}`, undefined, buyer)).json()).order
  assert.equal(current.status, 'processing'); assert.equal(current.manualFulfillment, false)
  assert.equal((await s.call(`/api/admin/orders/${order.id}/actions`, { action: 'manual-complete', version: current.version, note: '不得手工完成自动充值订单' }, admin)).status, 409)
  s.setTask('succeeded')
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'success'); assert.equal(current.manualFulfillment, false)
  assert.equal(current.fulfillment.accountEmailMasked, 't***@example.test')
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM recharge_redemptions').all()), /PRIVATE-TOKEN-NOT-FOR-STORAGE/)
})

test('25x automatic purchases require an authorized available product and safe supplier and partner prices', async t => {
  const s = setup(t); const buyer = await s.buyer()
  const payload = () => ({ plan: 'pro-25x', expectedPrice: 450000, email: 'buyer@example.test', key: crypto.randomUUID() })
  const enabled = async () => (await (await s.call('/api/catalog')).json()).plans.find((p: { id: string }) => p.id === 'pro-25x').enabled
  assert.equal(await enabled(), 0)
  assert.equal((await s.call('/api/orders', payload(), buyer)).status, 409)
  s.env.RECHARGE_PRODUCT_MAP = JSON.stringify({ 'pro-25x': 'demo_pro_large' })
  assert.equal(await enabled(), 1)
  assert.equal((await s.call('/api/orders', payload(), buyer)).status, 409)
  Object.assign(s.products[0], { product_code: 'demo_pro_large', supply_price: '3250.00', max_sale_price: '5000.00', available: false })
  assert.equal(await enabled(), 1)
  assert.equal((await s.call('/api/orders', payload(), buyer)).status, 409)
  s.products[0].available = true; s.products[0].delivery_modes = ['cdk']
  assert.equal(await enabled(), 1)
  assert.equal((await s.call('/api/orders', payload(), buyer)).status, 409)
  s.products[0].delivery_modes = ['auto_recharge']; s.products[0].supply_price = '4501.00'
  assert.equal((await s.call('/api/orders', payload(), buyer)).status, 409)
  // The current API no longer enforces the historical maximum-sale field.
  // Independent compatibility tests cover that change and quote-required SKUs.
  s.products[0].supply_price = '3250.00'; s.partner()
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,?,?,?)').run('partner-test', 'pro-25x', 324999, 450000)
  assert.equal((await s.call('/api/orders', { ...payload(), partner: 'partner-test' }, buyer)).status, 409)
  s.db.prepare('UPDATE partner_prices SET cost_cents=330000 WHERE partner_id=? AND plan=?').run('partner-test', 'pro-25x')
  assert.equal((await s.call('/api/orders', { ...payload(), partner: 'partner-test' }, buyer)).status, 201)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 0)
})

async function approveRefund(s: ReturnType<typeof setup>, id: string, buyer: string, admin: string, amount: number) {
  const current = await getOrder(s.env,id)
  assert.equal((await s.call(`/api/orders/${id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '申请售后退款' }, buyer)).status,201)
  const refund = s.db.prepare('SELECT * FROM refund_cases WHERE order_id=? ORDER BY created_at DESC LIMIT 1').get(id)!
  assert.equal((await s.call('/api/admin/refunds/'+refund.id, { action: 'approve', version: 0, amountCents: amount, note: '同意退款' }, admin)).status,200)
  return refund.id
}

async function partnerOrder(s: ReturnType<typeof setup>, buyer: string) {
  const response = await s.call('/api/orders',{ plan: 'plus', partner: 'partner-test', expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() },buyer)
  assert.equal(response.status,201,await response.clone().text())
  const order = (await response.json()).order
  await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer); await s.submit(order.id,buyer); s.setTask('succeeded'); await s.query(order.id,buyer)
  return order
}

test('manual marker blocks failed fallback recharges and original-key replay across queries, webhooks and reconciliation', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  const key = crypto.randomUUID(); await s.submit(order.id,buyer,key); s.setTask('failed',true); await s.query(order.id,buyer)
  let current = await getOrder(s.env,order.id)
  assert.equal(current.status,'failed')
  const path = `/api/admin/orders/${order.id}/actions`
  const mark = await s.call(path,{action:'redemption-control',blocked:true,note:'人工退款已处理',version:current.version},admin)
  assert.equal(mark.status,200,await mark.clone().text())
  assert.equal((await mark.json()).order.fulfillment.canSubmit,false)
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  for (const retryKey of [key,crypto.randomUUID()]) assert.equal((await s.submit(order.id,buyer,retryKey)).status,409)
  assert.equal((await s.query(order.id,buyer)).status,200)
  await s.notice('blocked-order'); await reconcileRecharge(s.env)
  const visible = (await (await s.call('/api/orders/'+order.id,undefined,buyer)).json()).order
  const listed = (await (await s.call('/api/orders',undefined,buyer)).json()).orders.find((o: {id:string})=>o.id===order.id)
  assert.equal(visible.redemptionBlocked,true); assert.equal(listed.redemptionBlocked,true)
  assert.equal(visible.fulfillment.canSubmit,false); assert.equal(visible.status,'failed')
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length,before)
  assert.equal(s.calls.some(c => c.path.includes('/refunds')),false)
  assert.equal(visible.refundedCents,0)
  current = await getOrder(s.env,order.id)
  assert.equal((await s.call(path,{action:'redemption-control',blocked:false,note:'核对后恢复兑换',version:current.version},admin)).status,200)
  assert.equal((await s.submit(order.id,buyer)).status,200)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length,before+1)
})

test('manual marker cannot race an in-flight recharge; a completed marker prevents later upstream writes', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => { entered=resolve })
  const gate = new Promise<void>(resolve => { release=resolve }); t.after(()=>release())
  s.override(async path => { if (path==='/v1/redemptions') { entered(); await gate } })
  const pending = s.submit(order.id,buyer)
  await started
  const current = await getOrder(s.env,order.id)
  const path = `/api/admin/orders/${order.id}/actions`
  const blocked = await s.call(path,{action:'redemption-control',blocked:true,note:'停止再次兑换',version:current.version},admin)
  assert.equal(blocked.status,409)
  assert.equal((await getOrder(s.env,order.id)).redemption_blocked,0)
  release(); assert.equal((await pending).status,200)
  const fresh = await getOrder(s.env,order.id)
  assert.equal((await s.call(path,{action:'redemption-control',blocked:true,note:'停止再次兑换',version:fresh.version},admin)).status,200)
  const writes = s.calls.filter(c=>c.path==='/v1/redemptions').length
  assert.equal((await s.submit(order.id,buyer)).status,409)
  assert.equal(s.calls.filter(c=>c.path==='/v1/redemptions').length,writes)
})

test('blocked unknown recharge cannot resend its original credentials or create a fresh attempt', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  s.override(path=>{if(path==='/v1/redemptions') throw new Error('lost response')})
  const key=crypto.randomUUID(); assert.equal((await s.submit(order.id,buyer,key)).status,503)
  const current=await getOrder(s.env,order.id)
  assert.equal((await s.call(`/api/admin/orders/${order.id}/actions`,{action:'redemption-control',blocked:true,note:'人工处理完成',version:current.version},admin)).status,200)
  const writes=s.calls.filter(c=>c.path==='/v1/redemptions').length
  for(const retryKey of [key,crypto.randomUUID()]) assert.equal((await s.submit(order.id,buyer,retryKey)).status,409)
  assert.equal(s.calls.filter(c=>c.path==='/v1/redemptions').length,writes)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n,1)
})

test('blocked pending orders cannot create or expose payment entrances, while an existing payment can still be reconciled', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  const path=`/api/admin/orders/${order.id}/actions`
  assert.equal((await s.call(path,{action:'redemption-control',blocked:true,note:'停止未付款订单',version:0},admin)).status,200)
  assert.equal((await s.query(order.id,buyer)).status,409)
  assert.equal(s.calls.filter(c=>c.path==='/v1/orders').length,0)
  assert.equal((await s.call(path,{action:'redemption-control',blocked:false,note:'核对后恢复',version:1},admin)).status,200)
  await s.query(order.id,buyer)
  let current=await getOrder(s.env,order.id)
  assert.equal((await s.call(`/api/admin/orders/${order.id}/actions`,{action:'redemption-control',blocked:true,note:'作废不退款',version:current.version},admin)).status,200)
  const starts=s.calls.filter(c=>c.path==='/payments/ord_test/start').length
  const response=await s.query(order.id,buyer)
  assert.equal(response.status,200)
  const visible=(await response.json()).order
  assert.equal(visible.fulfillment.paymentQr,null); assert.equal(visible.fulfillment.paymentUrl,null)
  assert.equal(s.calls.filter(c=>c.path==='/payments/ord_test/start').length,starts)
  s.setPayment('paid'); await s.query(order.id,buyer)
  current=await getOrder(s.env,order.id)
  assert.equal(current.payment_status,'paid'); assert.equal(current.redemption_blocked,1)
  assert.equal((await s.submit(order.id,buyer)).status,409)
})

test('HMAC canonicalization covers empty bodies, repeated query values, RFC3986 characters and exact JSON bytes', async () => {
  const url = new URL('https://recharge.example.invalid/v1/orders?z=a%2Bb&x=%21&x=a%20b')
  assert.equal(canonicalQuery(url.searchParams), 'x=%21&x=a%20b&z=a%2Bb')
  const lines = ['POST', '/v1/orders', 'x=%21&x=a%20b&z=a%2Bb', '1790323200', 'nonce-000000000001', 'key', 'order:001', digest('{"a":1}')].join('\n')
  assert.equal(await signature(secret, 'POST', url, '1790323200', 'nonce-000000000001', 'key', 'order:001', '{"a":1}'), mac(lines))
  assert.notEqual(await signature(secret, 'POST', url, '1790323200', 'nonce-000000000001', 'key', 'order:001', '{ "a":1}'), mac(lines))
})

test('Alipay 当面付 validates and renders only the real Alipay QR payload', () => {
  assert.equal(alipayQr('https://qr.alipay.com/bax01234567890'), 'https://qr.alipay.com/bax01234567890')
  assert.equal(alipayQr(null), null)
  for (const payload of ['https://recharge.example.invalid/payments/ord_test', 'https://qr.alipay.com.attacker.test/bax01234567890', 'http://qr.alipay.com/bax01234567890', 'https://user@qr.alipay.com/bax01234567890', 'https://qr.alipay.com/bax01234567890?redirect=evil', 'https://qr.alipay.com/bax01234567890#evil', 'javascript:alert(1)']) assert.throws(() => alipayQr(payload))
})

test('platform 当面付 creates one QR for the same alipay order and removes it after signed payment', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  let response = await s.query(order.id, buyer); assert.equal(response.status, 200, await response.clone().text())
  let current = (await response.json()).order
  assert.equal(current.fulfillment.paymentQr, 'https://qr.alipay.com/bax01234567890')
  assert.equal(current.fulfillment.paymentUrl, null)
  assert.equal(JSON.stringify(current).includes('recharge.example.invalid'), false)
  assert.equal(JSON.stringify(current).includes('public-test-token'), false)
  assert.equal(current.paymentStatus, 'unpaid'); assert.equal(current.fulfillment.canSubmit, false)
  const snapshot = s.db.prepare('SELECT create_body FROM recharge_orders').get()!.create_body
  await s.query(order.id, buyer)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/payments/ord_test/start').length, 1)
  assert.equal(s.db.prepare('SELECT create_body FROM recharge_orders').get()!.create_body, snapshot)
  s.setPayment('paid'); response = await s.query(order.id, buyer); current = (await response.json()).order
  assert.equal(current.status, 'session'); assert.equal(current.fulfillment.canSubmit, true)
  assert.equal(current.fulfillment.paymentQr, null); assert.equal(current.fulfillment.paymentUrl, null)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
})

test('customer and partner responses keep supplier cashier private, including legacy and unsafe cached QR data', async t => {
  const s = setup(t); s.faceToFace(); const partner = s.partner(); const buyer = await s.buyer()
  const created = await s.call('/api/orders', { plan: 'plus', partner: 'partner-test', expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  assert.equal(created.status, 201)
  const order = (await created.json()).order
  assert.equal((await s.query(order.id, buyer)).status, 200)
  assert.match(s.db.prepare('SELECT payment_url FROM recharge_orders WHERE order_id=?').get(order.id)!.payment_url as string, /recharge\.example\.invalid/)
  for (const cached of ['https://qr.alipay.com/bax01234567890', 'https://recharge.example.invalid/payments/ord_test?token=private-cashier-token']) {
    s.db.prepare('UPDATE recharge_orders SET payment_qr=? WHERE order_id=?').run(cached, order.id)
    for (const [path, cookie] of [[`/api/orders/${order.id}`, buyer], ['/api/orders', buyer], ['/api/partner/orders', partner]]) {
      const response = await s.call(path, undefined, cookie)
      assert.equal(response.status, 200)
      const raw = await response.text()
      assert.equal(raw.includes('recharge.example.invalid'), false, path)
      assert.equal(raw.includes('public-test-token'), false, path)
      assert.equal(raw.includes('private-cashier-token'), false, path)
    }
  }
})

test('lost cashier start recovers QR through status without recreating the signed order or starting a second payment', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  s.override(path => { if (path === '/payments/ord_test/start') { s.setQr('https://qr.alipay.com/bax01234567890'); throw new TypeError('network lost after creating QR') } })
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders').get()!.remote_id, 'ord_test')
  s.override(undefined)
  const response = await s.query(order.id, buyer); assert.equal(response.status, 200)
  assert.equal((await response.json()).order.fulfillment.paymentQr, 'https://qr.alipay.com/bax01234567890')
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/payments/ord_test/start').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders/ord_test').length, 1)
})

test('cashier status never authorizes payment and quote amount/expiry/QR mismatches withhold QR', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  s.quote({ status: 'paid' }); let response = await s.query(order.id, buyer)
  assert.equal(response.status, 200); let current = (await response.json()).order
  assert.equal(current.paymentStatus, 'unpaid'); assert.equal(current.status, 'pending'); assert.equal(current.fulfillment.canSubmit, false); assert.equal(current.fulfillment.paymentQr, null)
  for (const patch of [{ amount: '138.00' }, { expires_at: new Date(Date.now() + 60000).toISOString() }, { delivery_mode: 'cdk' }, { qr_code: 'https://recharge.example.invalid/payments/ord_test' }]) {
    s.quote(patch); response = await s.query(order.id, buyer); assert.equal(response.status, 503)
    assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders').get()!.remote_id, 'ord_test')
    assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
    assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  }
  assert.equal(s.calls.filter(c => c.path === '/payments/ord_test/start').length, 0)
  s.quote({}); response = await s.query(order.id, buyer); current = (await response.json()).order
  assert.equal(current.fulfillment.paymentQr, 'https://qr.alipay.com/bax01234567890')
})

test('a transient QR status failure retains only a previously validated live QR; invalid replacement clears it', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer)
  s.override(path => path === '/payments/ord_test/status' ? new Response('unavailable', { status: 503 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, 'https://qr.alipay.com/bax01234567890')
  s.override(undefined); s.quote({ amount: '1.00' })
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
  assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders').get()!.remote_id, 'ord_test')
})

test('cashier binding, channel and signed currency must match before QR start', async t => {
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  for (const patch of [{ qr_payload: 'https://recharge.example.invalid/payments/other?token=public-test-token-123456' }, { qr_payload: 'https://recharge.example.invalid/payments/ord_test?token=public-test-token-123456&redirect=evil' }, { payment_channel: 'usdt' }, { currency: 'USD' }]) {
    s.override(path => path === '/v1/orders' || path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), merchant_order_no: order.id, ...patch } }) : undefined)
    assert.equal((await s.query(order.id, buyer)).status, 503)
    assert.equal(s.calls.filter(c => c.path.startsWith('/payments/')).length, 0)
    assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  }
})

test('closed, expired and paused orders stop exposing or starting QR; legacy cashier remains a link', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  assert.equal((await (await s.query(order.id, buyer)).json()).order.fulfillment.paymentQr, null)
  assert.equal(s.calls.filter(c => c.path.startsWith('/payments/')).length, 0)
  s.faceToFace(); await s.query(order.id, buyer)
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.paymentQr, null); assert.equal(current.fulfillment.paymentUrl, null)
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  s.quote({ expired: true }); current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.paymentQr, null)
  s.quote({}); await s.query(order.id, buyer); s.setPayment('expired')
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'cancelled'); assert.equal(current.fulfillment.paymentQr, null)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
})

test('unpaid orders expire at creation +15 minutes even if supplier extends its quote; checking payment never restarts QR', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const s = setup(t); s.faceToFace(); s.setExpiry(clock + 3600000)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  let current = (await (await s.query(order.id, buyer)).json()).order
  const deadline = order.createdAt + 900000
  assert.equal(current.fulfillment.expiresAt, deadline)
  assert.ok(current.fulfillment.paymentQr)
  clock = deadline - 1
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'pending'); assert.equal(current.fulfillment.paymentExpired, false)
  const cashierCalls = s.calls.filter(c => c.path.startsWith('/payments/')).length
  clock = deadline
  for (let i = 0; i < 2; i++) {
    current = (await (await s.query(order.id, buyer)).json()).order
    assert.equal(current.status, 'cancelled'); assert.equal(current.fulfillment.paymentExpired, true)
    assert.equal(current.fulfillment.paymentQr, null); assert.equal(current.fulfillment.paymentUrl, null)
    assert.equal(current.fulfillment.canSubmit, false)
  }
  assert.equal(s.calls.filter(c => c.path.startsWith('/payments/')).length, cashierCalls)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-expired'").get()!.n, 1)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
  // Supplier-confirmed funds must remain recoverable after our local cutoff.
  s.setPayment('paid'); current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'session'); assert.equal(current.paymentStatus, 'paid')
  assert.equal(current.fulfillment.paymentExpired, false); assert.equal(current.fulfillment.canSubmit, true)
  assert.equal((await s.submit(order.id, buyer)).status, 200)
  assert.equal(s.calls.filter(c => c.path.startsWith('/payments/')).length, cashierCalls)
})

test('never-attempted expired orders close on read without creating a supplier payment', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const s = setup(t); s.faceToFace(); const buyer = await s.buyer(); const order = await s.create(buyer)
  clock = order.createdAt + 900000
  const list = await s.call('/api/orders', undefined, buyer)
  assert.equal(list.status, 200)
  const current = (await list.json()).orders.find((o: { id: string }) => o.id === order.id)
  assert.equal(current.status, 'cancelled'); assert.equal(current.fulfillment.paymentExpired, true)
  assert.equal((await s.query(order.id, buyer)).status, 200)
  await reconcileRecharge(s.env)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders' || c.path.startsWith('/payments/')).length, 0)
})

test('cashier status crossing the deadline cannot start a QR or leave an order payable', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const s = setup(t); s.faceToFace(); s.setExpiry(clock + 3600000)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  s.override(path => { if (path.endsWith('/status')) clock = order.createdAt + 900000 })
  const response = await s.query(order.id, buyer); assert.equal(response.status, 200)
  const current = (await response.json()).order
  assert.equal(current.status, 'cancelled'); assert.equal(current.fulfillment.paymentExpired, true)
  assert.equal(current.fulfillment.paymentQr, null); assert.equal(current.fulfillment.paymentUrl, null)
  assert.equal(s.calls.filter(c => c.path.endsWith('/start')).length, 0)
})

test('paid orders retain Session submission after the payment window', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  clock = order.createdAt + 3600000
  const current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'session'); assert.equal(current.fulfillment.paymentExpired, false)
  assert.equal(current.fulfillment.canSubmit, true)
  assert.equal((await s.submit(order.id, buyer)).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-expired'").get()!.n, 0)
})

test('lost supplier creation recovers the same idempotent write after expiry through Cron, never starting a QR', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const s = setup(t); s.faceToFace(); s.setExpiry(clock + 3600000)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  s.override(path => path === '/v1/orders' ? new Response('unavailable', { status: 503 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  clock = order.createdAt + 900000
  await reconcileRecharge(s.env)
  assert.equal((await getOrder(s.env, order.id)).status, 'cancelled')
  s.override(undefined); s.setPayment('paid'); clock += 60000
  await reconcileRecharge(s.env)
  assert.equal((await getOrder(s.env, order.id)).status, 'session')
  const attempts = s.calls.filter(c => c.path === '/v1/orders')
  assert.equal(attempts.length, 3)
  for (const attempt of attempts) {
    assert.equal(attempt.key, attempts[0].key); assert.equal(attempt.body, attempts[0].body)
  }
  assert.equal(s.calls.filter(c => c.path.startsWith('/payments/')).length, 0)
})

test('configured catalog is independent of supplier prices; orders still enforce live price bounds', async t => {
  const s = setup(t)
  const catalog = (await (await s.call('/api/catalog')).json())
  assert.equal(catalog.checkoutEnabled, true); assert.equal(catalog.testingEnabled, false)
  assert.deepEqual(catalog.plans.map((p: { enabled: number }) => p.enabled), [1,0,0,0,0,0,0,0,0,0,0,0])
  s.products[0].supply_price = '140.00'
  assert.equal((await (await s.call('/api/catalog')).json()).plans[0].enabled, 1)
  const buyer = await s.buyer()
  assert.equal((await s.call('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)).status, 409)
  s.env.RECHARGE_CHECKOUT_ENABLED = 'false'
  assert.equal((await (await s.call('/api/catalog')).json()).checkoutEnabled, false)
  s.env.ORDER_TESTING_ENABLED = 'true'
  const demo = await s.create(buyer)
  assert.equal(demo.mode, 'demo'); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_orders').get()!.n, 0)
})

test('platform collection, actual payment verification and auto recharge stay in own order; no credentials or vendor internals reach storage/customer response', async t => {
  const s = setup(t); const buyer = await s.buyer(); const other = await s.buyer(); const order = await s.create(buyer)
  assert.equal(order.mode, 'live'); assert.equal(order.paymentStatus, 'unpaid')
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal((await s.query(order.id, other)).status, 404)
  let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.paymentUrl, null)
  const sent = JSON.parse(s.calls.find(c => c.path === '/v1/orders')!.body)
  assert.equal(sent.delivery_mode, 'auto_recharge'); assert.equal(sent.collection_mode, 'platform_collect'); assert.equal(sent.payment_channel, 'alipay'); assert.equal(sent.sale_amount, '139.00')
  assert.equal('credential' in sent, false)
  s.setPayment('paid'); current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.paymentStatus, 'paid'); assert.equal(current.status, 'session'); assert.equal(current.fulfillment.paymentUrl, null)
  const response = await s.submit(order.id, buyer); assert.equal(response.status, 200, await response.clone().text())
  current = (await response.json()).order; assert.equal(current.status, 'processing')
  s.setTask('running'); assert.equal((await (await s.query(order.id, buyer)).json()).order.status, 'processing')
  s.setTask('succeeded'); current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'success'); assert.equal(current.fulfillment.accountEmailMasked, 't***@example.test')
  assert.equal(JSON.stringify(current).includes('PRIVATE-TOKEN'), false); assert.equal(JSON.stringify(current).includes('110.00'), false); assert.equal(JSON.stringify(current).includes('ord_test'), false)
  for (const table of ['orders','order_events','recharge_orders','recharge_redemptions','admin_audit']) assert.equal(JSON.stringify(s.db.prepare(`SELECT * FROM ${table}`).all()).includes('PRIVATE-TOKEN'), false)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-confirmed'").get()!.n, 1)
  assert.equal((await s.call(`/api/orders/${order.id}/payment`, { action: 'create' }, buyer)).status, 409)
  assert.equal((await s.call(`/api/orders/${order.id}/demo-actions`, { action: 'pay', version: current.version }, buyer)).status, 403)
  s.setTask('running'); s.setPayment('pending')
  const stale = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(stale.status, 'success'); assert.equal(stale.paymentStatus, 'paid')
})

test('production QF order identifiers work for checkout and polling; unsafe identifiers and replacement orders stay rejected', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  let remoteId: unknown = 'QF0000000008'
  s.override(path => {
    if (path === '/v1/orders' || path === '/v1/orders/QF0000000008') return Response.json({ data: { ...s.remoteOrder(), order_id: remoteId, merchant_order_no: order.id } })
  })
  const checkout = await s.query(order.id, buyer)
  assert.equal(checkout.status, 200, await checkout.clone().text())
  assert.equal((await checkout.json()).order.fulfillment.paymentUrl, null)
  assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders WHERE order_id=?').get(order.id)!.remote_id, 'QF0000000008')
  s.setPayment('paid')
  assert.equal((await (await s.query(order.id, buyer)).json()).order.paymentStatus, 'paid')
  assert.ok(s.calls.some(c => c.path === '/v1/orders/QF0000000008'))
  for (const invalid of [undefined, null, 8, '', 'a'.repeat(101), '../other', 'QF0000000009']) {
    remoteId = invalid
    assert.equal((await s.query(order.id, buyer)).status, 503)
    assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders WHERE order_id=?').get(order.id)!.remote_id, 'QF0000000008')
    assert.equal((await getOrder(s.env, order.id)).payment_status, 'paid')
  }
})

test('uncertain order creation retries exact stored body and idempotency with a fresh nonce; gate disable cannot abandon an attempted order', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  let lost = true
  s.override((path, raw) => { if (path === '/v1/orders' && lost) { lost = false; s.db.prepare('UPDATE orders SET updated_at=updated_at WHERE id=?').run(JSON.parse(raw).merchant_order_no); throw new Error('connection lost') } })
  assert.equal((await s.query(order.id, buyer)).status, 503)
  s.env.RECHARGE_CHECKOUT_ENABLED = 'false'
  assert.equal((await s.query(order.id, buyer)).status, 200)
  const calls = s.calls.filter(c => c.path === '/v1/orders')
  assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body); assert.equal(calls[0].key, calls[1].key); assert.notEqual(calls[0].nonce, calls[1].nonce)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_orders').get()!.n, 1)
})

test('expired new credentials never create a redemption or call the supplier', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const token = 'e30.' + Buffer.from('{"exp":1}').toString('base64url') + '.fixture'
  for (const credential of [
    { mode: 'session', session: JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: token }) },
    { mode: 'session', session: JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: 'opaque', expires: '2000-01-01T00:00:00Z' }) },
    { mode: 'access_token', access_token: token },
  ]) {
    const response = await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'submit', key: crypto.randomUUID(), customerConfirmedEmail: true, credential }, buyer)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /已过期|已超过有效期/)
  }
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(order.id)!.status, 'session')
})

test('unknown recharge recovers identical bytes even after credential expiry', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const now = Date.now(), raw = JSON.stringify({ ...JSON.parse(session), expires: new Date(now + 1000).toISOString() })
  let lost = true
  s.override(path => { if (path === '/v1/redemptions' && lost) { lost = false; throw new Error('lost response') } })
  const key = crypto.randomUUID()
  assert.equal((await s.submit(order.id, buyer, key, raw)).status, 503)
  t.mock.method(Date, 'now', () => now + 2000)
  assert.equal((await s.submit(order.id, buyer, key, raw)).status, 200)
  const calls = s.calls.filter(c => c.path === '/v1/redemptions')
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[0].body, calls[1].body)
})

test('unknown recharge keeps original key and body digest; other credentials/new attempt cannot duplicate charge', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  let lost = true
  s.override(path => { if (path === '/v1/redemptions' && lost) { lost = false; throw new Error('lost response') } })
  const key = crypto.randomUUID()
  assert.equal((await s.submit(order.id, buyer, key)).status, 503)
  const current = (await (await s.call('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(current.status, 'processing'); assert.equal(current.fulfillment.retryKey, key)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal((await s.submit(order.id, buyer, key, session.replace('PRIVATE-TOKEN', 'CHANGED-TOKEN'))).status, 409)
  assert.equal((await s.submit(order.id, buyer, key)).status, 200)
  const calls = s.calls.filter(c => c.path === '/v1/redemptions'); assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[0].body, calls[1].body)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
})

test('an unknown write beyond the guaranteed deduplication window is blocked for manual reconciliation', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => { if (path === '/v1/redemptions') throw new Error('lost response') })
  const key = crypto.randomUUID(); assert.equal((await s.submit(order.id, buyer, key)).status, 503)
  s.db.prepare('UPDATE recharge_redemptions SET created_at=?').run(Date.now() - 7 * 86400000)
  const current = (await (await s.call('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, false); assert.equal((await s.submit(order.id, buyer, key)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('definitive credential rejection permits a new authorized attempt without calling order creation again', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/redemptions' ? Response.json({ error: { code: 'invalid_credential', retryable: false, message: 'secret must not be exposed' } }, { status: 400 }) : undefined)
  assert.equal((await s.submit(order.id, buyer)).status, 503)
  const current = (await (await s.call('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(current.status, 'failed'); assert.equal(current.fulfillment.canSubmit, true)
  s.override(undefined); assert.equal((await s.submit(order.id, buyer)).status, 200)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
})

test('redemption fallback permits a new attempt without another order/payment, and refunds freeze submission', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  s.setTask('failed', true); let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.fulfillment.canSubmit, true)
  s.setTask('queued'); assert.equal((await s.submit(order.id, buyer)).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 2)
  // A running retry must resolve before the order can enter refund hold.
  current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal((await s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '取消服务' }, buyer)).status, 409)
  s.setTask('failed', true); current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal((await s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '取消服务' }, buyer)).status, 201)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
})

test('a failed recharge without explicit fallback cannot submit another attempt', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed', false)
  const current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal(current.status, 'failed'); assert.equal(current.fulfillment.canSubmit, false); assert.equal((await s.submit(order.id, buyer)).status, 409)
})

test('concurrent submit obtains one lease and one external request; audit failure rolls back attempt before credential forwarding', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.db.exec("CREATE TRIGGER fail_recharge BEFORE INSERT ON order_events WHEN NEW.action='recharge-submit' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.equal((await s.submit(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 0); assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
  s.db.exec('DROP TRIGGER fail_recharge')
  const key = crypto.randomUUID(); const responses = await Promise.all([s.submit(order.id, buyer, key), s.submit(order.id, buyer, key)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200,409]); assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('webhooks verify raw HMAC, age, header/body identity and deduplicate; even signed success only schedules GET verification', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  const timestamp = String(Math.floor(Date.now() / 1000)); const raw = JSON.stringify({ event_id: 'evt_test', type: 'order.paid', data: { order_id: 'ord_test', payment_status: 'paid', malicious_secret: 'PRIVATE-TOKEN' } })
  const notice = (text = raw, stamp = timestamp, sig = mac(stamp + '.' + text, webhookSecret)) => worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'order.paid', 'X-Quefa-Event-Id': 'evt_test', 'X-Quefa-Delivery': 'dlv_test', 'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': `t=${stamp},v1=${sig}` }, body: text }), s.env)
  assert.equal((await notice()).status, 200); assert.equal((await notice()).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_webhooks').get()!.n, 1); assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM recharge_webhooks').all()).includes('PRIVATE-TOKEN'), false)
  assert.equal((await notice(raw + ' ', timestamp, mac(timestamp + '.' + raw, webhookSecret))).status, 400)
  assert.equal((await notice(raw, String(Number(timestamp) - 301))).status, 400)
  assert.equal((await notice(raw.replace('evt_test','evt_other'))).status, 400)
  await reconcileRecharge(s.env)
  assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  s.setPayment('paid'); await reconcileRecharge(s.env); assert.equal((await getOrder(s.env, order.id)).payment_status, 'paid')
})

test('a signed webhook schedules only its original recharge order', async t => {
  const s = setup(t)
  const buyer = await s.buyer()
  const order = await s.create(buyer)
  await s.query(order.id, buyer)
  const other = 'YMX-WEBHOOK-OTHER'
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES(?,'other-owner','other-key','plus','Plus',13900,'live','unpaid','pending',1,1,'other-event')").run(other)
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,updated_at) SELECT ?,account,product_code,collection_mode,create_body,'ord_other',1234 FROM recharge_orders WHERE order_id=?").run(other, order.id)
  const stamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify({ event_id: 'evt_targeted', event: 'order.paid', data: { order_id: 'ord_test' } })
  const response = await worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'order.paid', 'X-Quefa-Event-Id': 'evt_targeted', 'X-Quefa-Delivery': 'dlv_targeted', 'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': 't=' + stamp + ',v1=' + mac(stamp + '.' + raw, webhookSecret) }, body: raw }), s.env)
  assert.equal(response.status, 200)
  assert.equal(s.db.prepare('SELECT notify_version FROM recharge_orders WHERE order_id=?').get(order.id)!.notify_version, 1)
  const untouched = s.db.prepare('SELECT notify_version,updated_at FROM recharge_orders WHERE order_id=?').get(other)!
  assert.equal(untouched.notify_version, 0)
  assert.equal(untouched.updated_at, 1234)
})

test('a webhook can target a locally known order before its upstream ID is saved', async t => {
  const s = setup(t)
  const buyer = await s.buyer()
  const order = await s.create(buyer)
  s.db.prepare('UPDATE recharge_orders SET attempted_at=? WHERE order_id=?').run(Date.now(), order.id)
  const stamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify({ event_id: 'evt_early', event: 'order.paid', data: { order_id: 'ord_early', merchant_order_no: order.id } })
  const response = await worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quefa-Event': 'order.paid', 'X-Quefa-Event-Id': 'evt_early', 'X-Quefa-Delivery': 'dlv_early', 'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': 't=' + stamp + ',v1=' + mac(stamp + '.' + raw, webhookSecret) }, body: raw }), s.env)
  assert.equal(response.status, 200)
  assert.equal(s.db.prepare('SELECT notify_version FROM recharge_orders WHERE order_id=?').get(order.id)!.notify_version, 1)
  assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
})

test('price/order/tenant mismatches and redirects fail closed without leaking vendor replies or forwarding credentials', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer)
  s.setPayment('paid')
  for (const patch of [{ sale_amount: '1.00' }, { payment_scope: 'procurement' }, { merchant_order_no: 'other' }, { order_id: 'ord_other' }]) {
    s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), ...patch } }) : undefined)
    assert.equal((await s.query(order.id, buyer)).status, 503); assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  }
  s.override(undefined); s.env.RECHARGE_PARTNER_ID = 'other'
  assert.equal((await s.query(order.id, buyer)).status, 503)
  s.env.RECHARGE_PARTNER_ID = 'pt_test'
  s.override(() => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }))
  await assert.rejects(supplierRequest(s.env, '/products'))
  assert.equal((await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'query' }, buyer, 'https://evil.test')).status, 403)
})

test('platform refund is asynchronous, uses fixed case id, and only verified final refund permits local bookkeeping once', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id, buyer); s.setPayment('paid'); let current = (await (await s.query(order.id, buyer)).json()).order
  assert.equal((await s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: current.version, reason: '退款' }, buyer)).status, 201)
  const refund = s.db.prepare('SELECT * FROM refund_cases').get()!; const admin = await s.login()
  assert.equal((await s.call('/api/admin/refunds/' + refund.id, { action: 'approve', version: 0, amountCents: 13900, note: '同意退款' }, admin)).status, 200)
  assert.equal((await (await s.call('/api/admin/refunds/' + refund.id, undefined, admin)).json()).paymentProvider, 'recharge')
  const execute = () => s.call('/api/admin/refunds/' + refund.id, { action: 'execute-refund', version: 1, note: '核对退款结果' }, admin)
  assert.equal((await execute()).status, 409)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 0); assert.equal((await getOrder(s.env, order.id)).refund_hold, 1)
  s.setRefund('succeeded'); s.setPayment('refunded')
  s.db.exec("CREATE TRIGGER refund_local_failure BEFORE INSERT ON refund_events WHEN NEW.status='refunded' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.equal((await execute()).status, 503)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 0); assert.equal((await getOrder(s.env, order.id)).refund_hold, 1)
  s.db.exec('DROP TRIGGER refund_local_failure')
  assert.equal((await execute()).status, 200)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 13900); assert.equal((await getOrder(s.env, order.id)).refund_hold, 0)
  assert.equal((await execute()).status, 409); assert.equal(s.calls.filter(c => c.path.endsWith('/refunds')).length, 1)
})

test('operator reconciles an external full refund with an unknown local request atomically without issuing another refund', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const admin = await s.login(); const refund = await approveRefund(s, order.id, buyer, admin, 13900)
  s.db.prepare('INSERT INTO recharge_refunds(case_id,order_id,create_body) VALUES (?,?,?)').run(refund, order.id, '{}')
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'refunded', refunded_amount: '139.00', merchant_margin: '-110.00' } }) : undefined)
  assert.equal((await s.call(`/api/admin/orders/${order.id}/platform-status`, {}, admin)).status, 200)
  const execute = (version = 1) => s.call('/api/admin/refunds/' + refund, { action: 'reconcile-platform-refund', version, note: '核对上游全额退款' }, admin)
  assert.equal((await execute(0)).status, 409)
  const detail = await (await s.call('/api/admin/refunds/' + refund, undefined, admin)).json()
  assert.equal(detail.platformStatus.refundedCents, 13900)
  assert.equal((await s.call('/api/admin/refunds/' + refund, { action: 'execute-refund', version: 1, note: '执行退款' }, admin)).status, 409)
  s.db.exec("CREATE TRIGGER external_refund_failure BEFORE INSERT ON refund_events WHEN NEW.status='refunded' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.equal((await execute()).status, 503)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 0)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases').get()!.status, 'approved')
  s.db.exec('DROP TRIGGER external_refund_failure')
  assert.equal((await execute()).status, 200)
  const current = await getOrder(s.env, order.id)
  assert.equal(current.refunded_cents, 13900); assert.equal(current.refund_hold, 0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold, 0)
  assert.equal(s.db.prepare('SELECT reference FROM refund_cases').get()!.reference, 'recharge-order:ord_test:13900')
  assert.equal((await execute()).status, 409)
  assert.equal((await reconcileRechargeRefunds(s.env)).checked, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM refund_events WHERE status='refunded'").get()!.n, 1)
  assert.equal(s.calls.some(c => c.path.includes('/refunds')), false)
})

test('external refund reconciliation requires fresh matching identity and exact totals and retains holds on failures', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const admin = await s.login(); const refund = await approveRefund(s, order.id, buyer, admin, 13900)
  const execute = (cookie = admin) => s.call('/api/admin/refunds/' + refund, { action: 'reconcile-platform-refund', version: 1, note: '核对退款' }, cookie)
  assert.equal((await execute(buyer)).status, 401)
  for (const patch of [
    { payment_status: 'paid', refunded_amount: '0.00' },
    { payment_status: 'partially_refunded', refunded_amount: '10.00' },
    { payment_status: 'refunded', refunded_amount: '139.00', merchant_order_no: 'another-order' },
  ]) {
    s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), ...patch } }) : undefined)
    assert.notEqual((await execute()).status, 200)
    assert.equal((await getOrder(s.env, order.id)).refunded_cents, 0)
    assert.equal((await getOrder(s.env, order.id)).refund_hold, 1)
  }
  s.override(() => new Response('unavailable', { status: 503 }))
  assert.equal((await execute()).status, 503)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases').get()!.status, 'approved')
  assert.equal(s.calls.some(c => c.path.includes('/refunds')), false)
})

test('refund commit guard uses this order even when another order has the expected total', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const admin = await s.login(); const refund = await approveRefund(s, order.id, buyer, admin, 13900)
  const other = await s.create(buyer)
  s.db.prepare("UPDATE recharge_orders SET payment_status='refunded',refunded_cents=13900 WHERE order_id=?").run(other.id)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), merchant_order_no: order.id, payment_status: 'refunded', refunded_amount: '139.00', merchant_margin: '0.00' } }) : undefined)
  const prepare = s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
  s.env.INTEREST_DB.prepare = sql => {
    if (sql.startsWith("UPDATE refund_cases SET status='refunded'")) s.db.prepare("UPDATE recharge_orders SET refunded_cents=13800,payment_status='partially_refunded' WHERE order_id=?").run(order.id)
    return prepare(sql)
  }
  assert.equal((await s.call('/api/admin/refunds/' + refund, { action: 'reconcile-platform-refund', version: 1, note: '核对退款' }, admin)).status, 409)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 0)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases').get()!.status, 'approved')
  assert.equal(s.calls.some(c => c.path.includes('/refunds')), false)
})

test('external partial refund reconciles paid partner commission once and blocks unresolved payouts', async t => {
  const s = setup(t); const partner = s.partner(); const buyer = await s.buyer(); const order = await partnerOrder(s, buyer); const admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts', { key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' }, partner)).status, 201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal((await s.call('/api/admin/partner-payouts/' + payout.id, { action: 'approve', version: 0, note: '审核提现' }, admin)).status, 200)
  const claimResponse = await s.call('/api/admin/partner-payouts/' + payout.id, { action: 'start-transfer', version: 1, note: '本地模拟领取转账处理权' }, admin)
  assert.equal(claimResponse.status, 200)
  const claim = { version: 2, attemptId: (await claimResponse.json()).attemptId, transferConfirmed: true }
  const refund = await approveRefund(s, order.id, buyer, admin, 1000)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '39.00' } }) : undefined)
  const execute = () => s.call('/api/admin/refunds/' + refund, { action: 'reconcile-platform-refund', version: 1, note: '核对部分退款' }, admin)
  assert.equal((await execute()).status, 409)
  assert.equal((await s.call('/api/admin/partner-payouts/' + payout.id, { action: 'paid', ...claim, note: '核对转账', reference: 'MOCK-TRANSFER-ONLY' }, admin)).status, 200)
  assert.equal((await execute()).status, 200)
  assert.equal((await getOrder(s.env, order.id)).refunded_cents, 1000)
  assert.equal(s.db.prepare('SELECT amount_cents FROM partner_debits').get()!.amount_cents, 1000)
  assert.equal((await execute()).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 1)
  assert.equal(s.calls.some(c => c.path.includes('/refunds')), false)
})

test('background refund reconciliation only follows initiated refunds and recovers an atomic bookkeeping failure without a second admin action', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  const admin = await s.login(); const refund = await approveRefund(s,order.id,buyer,admin,13900)
  assert.deepEqual(await reconcileRechargeRefunds(s.env),{ checked: 0, completed: 0, pending: 0 })
  assert.equal(s.calls.filter(c => c.path.endsWith('/refunds')).length,0)
  assert.equal((await s.call('/api/admin/refunds/'+refund,{ action: 'execute-refund', version: 1, note: '执行退款' },admin)).status,409)
  s.setRefund('processing'); assert.equal((await reconcileRechargeRefunds(s.env)).pending,1)
  assert.equal((await getOrder(s.env,order.id)).refund_hold,1)
  s.setRefund('succeeded'); s.setPayment('refunded')
  s.db.exec("CREATE TRIGGER background_refund_failure BEFORE INSERT ON refund_events WHEN NEW.status='refunded' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.equal((await reconcileRechargeRefunds(s.env)).pending,1)
  assert.equal((await getOrder(s.env,order.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  s.db.exec('DROP TRIGGER background_refund_failure')
  await worker.scheduled({},s.env)
  assert.equal((await getOrder(s.env,order.id)).refunded_cents,13900)
  assert.equal((await getOrder(s.env,order.id)).refund_hold,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,0)
  assert.equal((await reconcileRechargeRefunds(s.env)).checked,0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM refund_events WHERE status='refunded'").get()!.n,1)
  assert.equal(s.calls.filter(c => c.path.endsWith('/refunds')).length,1)
})

test('confirmed supplier rejection releases this refund hold and preserves a completed task observed while frozen', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer); await s.submit(order.id,buyer)
  // Refunds start only once fulfillment has a definitive outcome.
  s.setTask('failed'); await s.query(order.id,buyer)
  const admin = await s.login(); const refund = await approveRefund(s,order.id,buyer,admin,13900)
  assert.equal((await s.call('/api/admin/refunds/'+refund,{ action: 'execute-refund', version: 1, note: '执行退款' },admin)).status,409)
  s.setTask('succeeded')
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), progress_version: 1 } }) : undefined)
  await s.query(order.id,buyer)
  assert.equal((await getOrder(s.env,order.id)).status,'failed')
  s.setRefund('rejected'); assert.equal((await reconcileRechargeRefunds(s.env)).completed,1)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases').get()!.status,'rejected')
  assert.equal((await getOrder(s.env,order.id)).refund_hold,0)
  assert.equal((await getOrder(s.env,order.id)).refunded_cents,0)
  const current = (await (await s.query(order.id,buyer)).json()).order
  assert.equal(current.status,'success'); assert.equal(current.refundHold,false)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n,0)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length,1)
})

test('unmatched supplier refund freezes customer operations and its pending payout while admin income uses confirmed upstream refund', async t => {
  const s = setup(t); const partner = s.partner(); const buyer = await s.buyer(); const order = await partnerOrder(s,buyer); const admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,201)
  const payout = s.db.prepare('SELECT id FROM partner_payouts').get()!.id
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '39.00' } }) : undefined)
  const current = (await (await s.query(order.id,buyer)).json()).order
  assert.equal(current.refundHold,true); assert.equal(current.fulfillment.canSubmit,false)
  assert.equal((await getOrder(s.env,order.id)).refunded_cents,0)
  assert.equal((await s.call(`/api/orders/${order.id}/refunds`,{ key: crypto.randomUUID(), version: current.version, reason: '另申请退款' },buyer)).status,409)
  assert.equal((await s.submit(order.id,buyer)).status,409)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout,{ action: 'approve', version: 0, note: '审核提现' },admin)).status,409)
  const dashboard = (await (await s.call('/api/partner/dashboard',undefined,partner)).json())
  assert.equal(dashboard.stats.withdrawalHeld,false)
  assert.equal(dashboard.stats.available,0)
  assert.ok(dashboard.totals.pending > 0)
  const overview = (await (await s.call('/api/admin/overview',undefined,admin)).json())
  assert.equal(overview.stats.paid_amount,14900); assert.equal(overview.stats.refund_amount,1000); assert.equal(overview.recent[0].refundHold,true)
  const response = await s.call('/api/partner/orders',undefined,partner)
  assert.equal(response.status,200,await response.clone().text())
  const orders = (await response.json()).rows
  assert.equal(orders[0].refund_hold,1); assert.equal(orders[0].profit_cents,3900)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,0)
})

test('rejecting this refund cannot clear the separate hold caused by an unmatched upstream refund', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
  const admin = await s.login(); const refund = await approveRefund(s,order.id,buyer,admin,13900)
  assert.equal((await s.call('/api/admin/refunds/'+refund,{ action: 'execute-refund', version: 1, note: '发起退款' },admin)).status,409)
  s.setRefund('rejected')
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '19.00' } }) : undefined)
  assert.equal((await reconcileRechargeRefunds(s.env)).completed,1)
  assert.equal((await getOrder(s.env,order.id)).refund_hold,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  const current = (await (await s.call('/api/orders/'+order.id,undefined,buyer)).json()).order
  assert.equal(current.refundHold,true); assert.equal(current.fulfillment.canSubmit,false)
  assert.equal((await s.submit(order.id,buyer)).status,409)
})

test('partial Recharge refund caps profit at actual supplier margin and claws back the paid commission exactly once', async t => {
  const s = setup(t); const partner = s.partner(); const buyer = await s.buyer(); const order = await partnerOrder(s,buyer); const admin = await s.login()
  assert.equal((await (await s.call('/api/partner/dashboard',undefined,partner)).json()).stats.available,4900)
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal(payout.amount_cents,4900)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout.id,{ action: 'approve', version: 0, note: '审核通过' },admin)).status,200)
  const claimResponse = await s.call('/api/admin/partner-payouts/'+payout.id, { action: 'start-transfer', version: 1, note: '本地模拟领取转账处理权' }, admin)
  assert.equal(claimResponse.status, 200)
  const claim = { version: 2, attemptId: (await claimResponse.json()).attemptId, transferConfirmed: true }
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout.id,{ action: 'paid', ...claim, note: '已核对转账', reference: 'MOCK-TRANSFER-ONLY' },admin)).status,200)
  const refund = await approveRefund(s,order.id,buyer,admin,1000)
  assert.equal((await s.call('/api/admin/refunds/'+refund,{ action: 'execute-refund', version: 1, note: '执行部分退款' },admin)).status,409)
  assert.equal((await (await s.call('/api/partner/dashboard',undefined,partner)).json()).stats.withdrawalHeld,true)
  s.setRefund('succeeded'); s.setPayment('partially_refunded')
  assert.equal((await reconcileRechargeRefunds(s.env)).completed,1)
  const current = await getOrder(s.env,order.id)
  assert.equal(current.status,'success'); assert.equal(current.refunded_cents,1000); assert.equal(current.refund_hold,0)
  assert.equal(s.db.prepare('SELECT amount_cents FROM partner_debits').get()!.amount_cents,1000)
  const dashboard = (await (await s.call('/api/partner/dashboard',undefined,partner)).json())
  assert.equal(dashboard.stats.debt,1000); assert.equal(dashboard.stats.withdrawalHeld,false)
  const response = await s.call('/api/partner/orders',undefined,partner)
  assert.equal(response.status,200,await response.clone().text())
  assert.equal((await response.json()).rows[0].profit_cents,3900)
  await reconcileRechargeRefunds(s.env)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n,1)
})

test('a payout reserved at an old supplier margin cannot be approved after the confirmed margin changes', async t => {
  const s = setup(t); const partner = s.partner(); const buyer = await s.buyer(); const order = await partnerOrder(s,buyer); const admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,201)
  const payout = s.db.prepare('SELECT id FROM partner_payouts').get()!.id
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), supply_amount: '119.00', merchant_margin: '40.00' } }) : undefined)
  await s.query(order.id,buyer)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout,{ action: 'approve', version: 0, note: '审核提现' },admin)).status,409)
  assert.equal(s.db.prepare('SELECT reviewed_at FROM partner_payouts').get()!.reviewed_at,null)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout,{ action: 'rejected', version: 0, note: '重新核算收益' },admin)).status,200)
  assert.equal((await (await s.call('/api/partner/dashboard',undefined,partner)).json()).stats.available,4000)
})

test('partner configured price remains visible but unsafe supply disables sales and rejects creation', async t => {
  const s = setup(t); s.partner(); const buyer = await s.buyer()
  s.db.prepare("UPDATE partner_prices SET cost_cents=10000 WHERE partner_id='partner-test'").run()
  assert.equal((await (await s.call('/api/catalog?partner=partner-test')).json()).plans[0].enabled,0)
  assert.equal((await s.call('/api/orders',{ partner: 'partner-test', plan: 'plus', expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() },buyer)).status,409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0)
})

test('payout submission and approval verify current supplier finances even when no webhook or customer refresh ran', async t => {
  const s = setup(t); const partner = s.partner(); const buyer = await s.buyer(); await partnerOrder(s,buyer); const admin = await s.login()
  s.override(path => { if (path === '/v1/orders/ord_test') throw new Error('provider outage') })
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n,0)
  s.override(undefined)
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,201)
  const payout = s.db.prepare('SELECT id FROM partner_payouts').get()!.id
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '39.00' } }) : undefined)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout,{ action: 'approve', version: 0, note: '审核提现' },admin)).status,409)
  assert.equal(s.db.prepare('SELECT reviewed_at FROM partner_payouts').get()!.reviewed_at,null)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  assert.equal((await s.call('/api/admin/partner-payouts/'+payout,{ action: 'rejected', version: 0, note: '收益核对后重新申请' },admin)).status,200)
  assert.equal((await s.call('/api/partner/payouts',{ key: crypto.randomUUID(), recipient: '支付宝测试账户 / 测试人' },partner)).status,409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n,1)
})

test('a webhook arriving during terminal order reconciliation remains due and is verified by the next reconciliation', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer); await s.submit(order.id,buyer); s.setTask('succeeded'); await s.query(order.id,buyer)
  let first = true
  s.override(async path => {
    if (path !== '/v1/orders/ord_test') return undefined
    if (first) { first = false; const old = s.remoteOrder(); assert.equal((await s.notice('evt_during_query')).status,200); return Response.json({ data: old }) }
    return Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '19.00' } })
  })
  assert.equal((await s.query(order.id,buyer)).status,200)
  let stored = s.db.prepare('SELECT * FROM recharge_orders').get()!
  assert.equal(stored.notify_version,1); assert.equal(stored.checked_notify_version,0); assert.equal(stored.updated_at,0)
  assert.deepEqual(await reconcileRecharge(s.env),{ checked: 1, failed: 0 })
  stored = s.db.prepare('SELECT * FROM recharge_orders').get()!
  assert.equal(stored.checked_notify_version,1); assert.equal(stored.refunded_cents,1000); assert.equal(stored.financial_hold,1)
})

test('recently closed unpaid orders recover a verified late payment without a webhook', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('expired'); await s.query(order.id,buyer)
  assert.equal((await getOrder(s.env,order.id)).status,'cancelled')
  s.setPayment('paid'); assert.equal((await reconcileRecharge(s.env)).checked,1)
  assert.equal((await getOrder(s.env,order.id)).status,'session'); assert.equal((await getOrder(s.env,order.id)).payment_status,'paid')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-confirmed'").get()!.n,1)
})

test('completed orders remain in periodic financial reconciliation when an external refund webhook is missing', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer); await s.submit(order.id,buyer); s.setTask('succeeded'); await s.query(order.id,buyer)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '19.00' } }) : undefined)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_webhooks').get()!.n,0)
  assert.equal((await reconcileRecharge(s.env)).checked,1)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  assert.equal((await getOrder(s.env,order.id)).status,'success')
  assert.equal((await getOrder(s.env,order.id)).refunded_cents,0)
})

test('inconsistent supplier refund totals cannot unlock payment, local refunds, or profits', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); await s.query(order.id,buyer)
  for (const patch of [{ payment_status: 'refunded', refunded_amount: '0.00', merchant_margin: '0.00' },{ payment_status: 'partially_refunded', refunded_amount: '0.00' },{ payment_status: 'paid', refunded_amount: '1.00' },{ payment_status: 'refunded', refunded_amount: '139.00', merchant_margin: '29.00' }]) {
    s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), ...patch } }) : undefined)
    assert.equal((await s.query(order.id,buyer)).status,503)
    assert.equal((await getOrder(s.env,order.id)).payment_status,'unpaid')
    assert.equal((await getOrder(s.env,order.id)).refunded_cents,0)
  }
})

test('platform query confirms manual completion despite failed historical tasks and preserves the no-resubmit marker', async t => {
  const s = setup(t); const buyer = await s.buyer(); const admin = await s.login(); const agent = s.partner(); const order = await s.create(buyer)
  s.db.prepare("UPDATE orders SET partner_id='partner-test',cost_cents=11000 WHERE id=?").run(order.id)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed', true); await s.query(order.id, buyer)
  s.db.prepare('UPDATE orders SET redemption_blocked=1 WHERE id=?').run(order.id)
  const historical = s.db.prepare('SELECT * FROM recharge_redemptions').get()!
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_status: 'succeeded' } }) : undefined)
  const before = s.calls.length
  const path = `/api/admin/orders/${order.id}/platform-status`
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.deepEqual(s.calls.slice(before).map(c => [c.path,c.body]), [['/v1/orders/ord_test','']])
  const detail = (await (await s.call(`/api/admin/orders/${order.id}`, undefined, admin)).json()).order
  assert.equal(detail.status, 'success'); assert.equal(orderLabel(detail), '已完成'); assert.equal(detail.redemptionBlocked, true)
  assert.equal(detail.fulfillment.rechargeStatus, 'succeeded'); assert.equal(detail.fulfillment.progressStage, 'completed')
  assert.equal(detail.fulfillment.canSubmit, false); assert.equal(detail.fulfillment.finishedAt, null)
  assert.equal(detail.fulfillment.failureCode, null); assert.equal(detail.fulfillment.message, null)
  assert.deepEqual(s.db.prepare('SELECT * FROM recharge_redemptions').get(), historical)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  const partnerResponse = await s.call('/api/partner/orders', undefined, agent)
  assert.equal(partnerResponse.status, 200, await partnerResponse.clone().text())
  const rows = (await partnerResponse.json()).rows
  assert.equal(rows[0].status, 'success')
  const version = (await getOrder(s.env, order.id)).version
  assert.equal((await s.call(path, {}, admin)).status, 200)
  await reconcileRecharge(s.env)
  assert.equal((await getOrder(s.env, order.id)).version, version)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='platform-fulfillment-completed'").get()!.n, 1)
  assert.equal(s.calls.some(c => c.path.includes('/refunds')), false)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('manual completion cannot bypass payment, refunds or mismatched order identity', async t => {
  const s = setup(t); const buyer = await s.buyer(); const admin = await s.login(); const order = await s.create(buyer)
  await s.query(order.id, buyer)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_status: 'succeeded' } }) : undefined)
  const path = `/api/admin/orders/${order.id}/platform-status`
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.equal((await getOrder(s.env, order.id)).status, 'pending')
  s.setPayment('paid'); s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.equal((await getOrder(s.env, order.id)).status, 'session')
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  for (const patch of [{ payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '19.00' }, { merchant_order_no: 'wrong-order' }, { product_code: 'wrong-product' }]) {
    s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_status: 'succeeded', ...patch } }) : undefined)
    const response = await s.call(path, {}, admin)
    assert.equal(response.status, Object.hasOwn(patch,'payment_status') ? 200 : 503)
    assert.equal((await getOrder(s.env, order.id)).status, 'session')
  }
  // A stale paid snapshot cannot erase the independently confirmed refund hold.
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_status: 'succeeded' } }) : undefined)
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.equal((await getOrder(s.env, order.id)).status, 'session')
})

test('periodic reconciliation confirms manual fulfillment without changing the failed automatic task', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed'); await s.query(order.id, buyer)
  s.db.prepare('UPDATE orders SET redemption_blocked=1 WHERE id=?').run(order.id)
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), fulfillment_status: 'succeeded' } }) : undefined)
  assert.equal((await reconcileRecharge(s.env)).failed, 0)
  assert.equal((await getOrder(s.env, order.id)).status, 'success')
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status, 'failed')
})

test('platform query synchronizes the original recharge task and accepts only a newer confirmed terminal correction', async t => {
  const s = setup(t); const buyer = await s.buyer(); const admin = await s.login(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('failed')
  s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), progress_version: 4 } }) : undefined)
  await s.query(order.id, buyer)
  const path = `/api/admin/orders/${order.id}/platform-status`
  for (const [status, version, expected] of [['succeeded',3,'failed'], ['succeeded',4,'failed'], ['running',5,'failed'], ['succeeded',5,'success']] as const) {
    s.setTask(status)
    s.override(p => p.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), progress_version: version } }) : undefined)
    assert.equal((await s.call(path, {}, admin)).status, 200)
    assert.equal((await getOrder(s.env, order.id)).status, expected)
  }
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('platform query records full refunds with negative margins and shares the confirmed snapshot only with the owning agent', async t => {
  const s = setup(t); const buyer = await s.buyer(); const agent = s.partner(); const order = await s.create(buyer)
  s.db.prepare("UPDATE orders SET partner_id='partner-test',cost_cents=11000 WHERE id=?").run(order.id)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const admin = await s.login()
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'refunded', refunded_amount: '139.00', merchant_margin: '-110.00', qr_payload: null } }) : undefined)
  const before = s.calls.length
  const response = await s.call(`/api/admin/orders/${order.id}/platform-status`, {}, admin)
  assert.equal(response.status, 200, await response.clone().text())
  const snapshot = (await response.json()).platformStatus
  assert.equal(snapshot.paymentStatus, 'refunded'); assert.equal(snapshot.refundedCents, 13900)
  assert.equal(snapshot.financialHold, true); assert.ok(snapshot.checkedAt > 0)
  assert.deepEqual(s.calls.slice(before).map(c => [c.path,c.body]), [['/v1/orders/ord_test','']])
  const stored = s.db.prepare('SELECT * FROM recharge_orders WHERE order_id=?').get(order.id)!
  assert.equal(stored.reported_margin_cents, -11000); assert.equal(stored.merchant_margin_cents, 0)
  const detail = (await (await s.call(`/api/admin/orders/${order.id}`, undefined, admin)).json()).order
  assert.deepEqual(detail.platformStatus, snapshot)
  assert.equal(orderLabel(detail), '已退款')
  assert.equal(detail.refundHold, true)
  const list = (await (await s.call('/api/admin/orders?q=' + order.id, undefined, admin)).json()).orders
  assert.equal(orderLabel(list[0]), '已退款'); assert.deepEqual(list[0].platformStatus, snapshot)
  const recent = (await (await s.call('/api/admin/overview', undefined, admin)).json()).recent
  assert.equal(orderLabel(recent.find(o => o.id === order.id)), '已退款')
  const partnerResponse = await s.call('/api/partner/orders', undefined, agent)
  assert.equal(partnerResponse.status, 200, await partnerResponse.clone().text())
  const rows = (await partnerResponse.json()).rows
  assert.equal(rows.length, 1); assert.equal(rows[0].platform_payment_status, 'refunded')
  assert.equal(rows[0].platform_refunded_cents, 13900); assert.equal(rows[0].platform_checked_at, snapshot.checkedAt)
  assert.equal(rows[0].profit_cents, 0); assert.equal(rows[0].refund_hold, 1)
  assert.equal(confirmedRefundLabel(Math.max(rows[0].refunded_cents, rows[0].platform_refunded_cents), rows[0].price_cents), '已退款')
  assert.equal((await s.call(`/api/admin/orders/${order.id}/platform-status`, {}, agent)).status, 401)
  s.db.prepare("UPDATE orders SET partner_id=NULL WHERE id=?").run(order.id)
  assert.equal((await (await s.call('/api/partner/orders', undefined, agent)).json()).rows.length, 0)
  await s.call(`/api/admin/orders/${order.id}/platform-status`, {}, admin)
  assert.equal(s.db.prepare('SELECT refunded_cents FROM orders WHERE id=?').get(order.id)!.refunded_cents, 0)
  for (const table of ['refund_cases','partner_debits','recharge_refunds']) assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='platform-order-query'").get()!.n, 2)
})

test('platform query never creates a remote order or starts a cashier and enforces admin origin and the order lease', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  const path = `/api/admin/orders/${order.id}/platform-status`
  assert.equal((await s.call(path, {})).status, 401)
  assert.equal((await s.call(path, {}, admin, 'https://foreign.example')).status, 403)
  assert.equal((await s.call(path, {}, admin)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 0)
  s.faceToFace(); await s.query(order.id, buyer); s.setQr(null)
  assert.equal((await s.notice('evt_order_query')).status, 200)
  const before = s.calls.length
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.deepEqual(s.calls.slice(before).map(c => [c.path,c.body]), [['/v1/orders/ord_test','']])
  const notified = s.db.prepare('SELECT notify_version,checked_notify_version,updated_at FROM recharge_orders').get()!
  assert.equal(notified.notify_version, 1); assert.equal(notified.checked_notify_version, 0); assert.equal(notified.updated_at, 0)
  s.db.prepare('UPDATE recharge_orders SET lease_until=? WHERE order_id=?').run(Date.now()+60000, order.id)
  assert.equal((await s.call(path, {}, admin)).status, 409)
  s.db.prepare('UPDATE recharge_orders SET lease_until=0 WHERE order_id=?').run(order.id)
  s.db.prepare('UPDATE orders SET is_test=1 WHERE id=?').run(order.id)
  assert.equal((await s.call(path, {}, admin)).status, 409)
})

test('partial refunds survive failed, malformed and stale platform queries without claiming a new verification', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const path = `/api/admin/orders/${order.id}/platform-status`
  const remote = { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '40.00', merchant_margin: '-11.00' }
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: remote }) : undefined)
  assert.equal((await s.call(path, {}, admin)).status, 200)
  const saved = s.db.prepare('SELECT payment_status,refunded_cents,reported_margin_cents,verified_at FROM recharge_orders').get()!
  assert.equal(saved.refunded_cents, 4000); assert.equal(saved.reported_margin_cents, -1100)
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ error: { code: 'temporarily_unavailable' } }, { status: 503 }) : undefined)
  assert.equal((await s.call(path, {}, admin)).status, 503)
  assert.deepEqual(s.db.prepare('SELECT payment_status,refunded_cents,reported_margin_cents,verified_at FROM recharge_orders').get(), saved)
  for (const patch of [{ sale_amount: '-139.00' }, { refunded_amount: '-40.00' }, { merchant_margin: '-110.01' }, { merchant_margin: '-11.1' }, { order_id: 'wrong-order' }]) {
    s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...remote, ...patch } }) : undefined)
    assert.equal((await s.call(path, {}, admin)).status, 503)
    assert.deepEqual(s.db.prepare('SELECT payment_status,refunded_cents,reported_margin_cents,verified_at FROM recharge_orders').get(), saved)
  }
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...remote, refunded_amount: '10.00', merchant_margin: '19.00' } }) : undefined)
  assert.equal((await s.call(path, {}, admin)).status, 200)
  assert.deepEqual(s.db.prepare('SELECT payment_status,refunded_cents,reported_margin_cents,verified_at FROM recharge_orders').get(), saved)
})

test('only platform margins accept signed money, while sale, supply and refunds stay nonnegative', () => {
  assert.equal(marginCents('-110.00'), -11000); assert.equal(marginCents('29.00'), 2900)
  for (const value of ['-110.00','-0.01','+1.00','1.1',1,null]) assert.throws(() => moneyCents(value))
  for (const value of ['--1.00','-1.1','-01.00','-Infinity']) assert.throws(() => marginCents(value))
})

test('API signing preserves a literal plus and uppercases the method', async () => {
  const url = new URL('https://recharge.example.invalid/v1/orders?search=a+b&tag=%E6%B5%8B%E8%AF%95&search=a%20b')
  const canonical = ['GET', url.pathname, 'search=a%20b&search=a%2Bb&tag=%E6%B5%8B%E8%AF%95', '1790323200', 'nonce-compat', 'key', '', digest('')].join('\n')
  assert.equal(await signature(secret, 'get', url, '1790323200', 'nonce-compat', 'key', '', ''), mac(canonical))
})

test('signed payment-code binds the original order, amount, expiry and idempotency without calling a public cashier', async t => {
  const s = setup(t); Object.assign(s.env, { RECHARGE_PAYMENT_CODE_ENABLED: 'true' })
  const remote = { ...s.remoteOrder(), merchant_order_no: 'SHOP-compat' }
  const valid = { order_id: remote.order_id, merchant_order_no: remote.merchant_order_no, amount: remote.sale_amount, currency: 'CNY', payment_status: 'pending', payment_code_type: 'alipay_precreate', payment_code: 'https://qr.alipay.com/bax01234567890', expires_at: remote.expires_at }
  let patch: Record<string, unknown> = {}
  s.override(path => path === '/v1/orders/ord_test/payment-code' ? Response.json({ data: { ...valid, ...patch } }) : undefined)
  const { paymentQr } = await import('../worker/recharge/client.ts')
  assert.equal(await paymentQr(s.env, remote.qr_payload, remote), valid.payment_code)
  assert.equal(await paymentQr(s.env, remote.qr_payload, remote), valid.payment_code)
  const calls = s.calls.filter(c => c.path === '/v1/orders/ord_test/payment-code')
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[0].body, '{}'); assert.notEqual(calls[0].nonce, calls[1].nonce)
  for (const value of [{ order_id: 'other' }, { merchant_order_no: 'other' }, { amount: '1.00' }, { currency: 'USD' }, { payment_code_type: 'link' }, { expires_at: new Date(Date.now() + 60000).toISOString() }, { payment_code: 'https://recharge.example.invalid/payments/ord_test' }]) {
    patch = value
    await assert.rejects(paymentQr(s.env, remote.qr_payload, remote))
  }
  patch = { payment_status: 'paid' }
  assert.equal(await paymentQr(s.env, remote.qr_payload, remote), null)
  assert.equal(s.calls.some(c => c.path.startsWith('/payments/')), false)
  const count = s.calls.length
  assert.equal(await paymentQr(s.env, null, remote, Date.now() - 1), null)
  assert.equal(s.calls.length, count)
})

test('fixed-price checkout ignores the historical sale ceiling but rejects products requiring a fresh account quote', async t => {
  const s = setup(t); const buyer = await s.buyer()
  s.products[0].max_sale_price = '120.00'
  const order = await s.create(buyer)
  assert.equal(order.mode, 'live')
  Object.assign(s.products[0], { supply_price: '0.00', quote_required: true })
  const before = s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n
  const denied = await s.call('/api/orders', { plan: 'plus', expectedPrice: 13900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  assert.equal(denied.status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, before)
  assert.equal(s.calls.some(c => c.path === '/v1/orders'), false)
})

test('long Session JSON is accepted by extracted-token size and never persisted', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const token = 'sensitive-long-token-' + 'x'.repeat(64000)
  const raw = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: token, extra: 'x'.repeat(80000) })
  const response = await s.submit(order.id, buyer, crypto.randomUUID(), raw)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(JSON.parse(s.calls.find(c => c.path === '/v1/redemptions')!.body).credential.session, raw)
  assert.doesNotMatch(await response.text(), /sensitive-long-token/)
  for (const table of ['orders', 'order_events', 'recharge_orders', 'recharge_redemptions', 'admin_audit']) assert.doesNotMatch(JSON.stringify(s.db.prepare(`SELECT * FROM ${table}`).all()), /sensitive-long-token/)
})

test('over-limit extracted tokens and request bodies are rejected before forwarding credentials', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const tooLongToken = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: 'x'.repeat(128 * 1024 + 1) })
  assert.equal((await s.submit(order.id, buyer, crypto.randomUUID(), tooLongToken)).status, 400)
  const tooLongBody = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: 'short-token', extra: 'x'.repeat(256 * 1024) })
  assert.equal((await s.submit(order.id, buyer, crypto.randomUUID(), tooLongBody)).status, 413)
  assert.equal(s.calls.some(c => c.path === '/v1/redemptions'), false)
})

test('supplier-requested read delays persist per account/resource and do not replay requests early', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: s.remoteOrder() }, { headers: { 'X-Poll-After': '60', 'X-Poll-Stop': 'true' } }) : undefined)
  await supplierRequest(s.env, '/orders/ord_test')
  const before = s.calls.length
  await assert.rejects(supplierRequest({ ...s.env }, '/orders/ord_test'), e => e instanceof RechargeError && e.retryAfter === 60)
  assert.equal(s.calls.length, before)
  // Other resources retain their own window, and server-side reads never create orders.
  await supplierRequest(s.env, '/products')
  now += 61000
  await supplierRequest(s.env, '/orders/ord_test')
  assert.equal(s.calls.filter(c => c.path === '/v1/orders/ord_test').length, 2)
  assert.equal(s.calls.some(c => c.path === '/v1/orders'), false)
})

test('signed checkout exposes only a verified QR and revocation clears it without replacing the order', async t => {
  const s = setup(t); Object.assign(s.env, { RECHARGE_PAYMENT_CODE_ENABLED: 'true' })
  const buyer = await s.buyer(); const order = await s.create(buyer)
  s.override(path => path === '/v1/orders/ord_test/payment-code' ? Response.json({ data: { order_id: 'ord_test', merchant_order_no: order.id, amount: '139.00', currency: 'CNY', payment_status: 'pending', payment_code_type: 'alipay_precreate', payment_code: 'https://qr.alipay.com/bax01234567890', expires_at: s.remoteOrder().expires_at } }) : undefined)
  const response = await s.query(order.id, buyer)
  assert.equal(response.status, 200, await response.clone().text())
  const current = (await response.json()).order
  assert.equal(current.fulfillment.paymentQr, 'https://qr.alipay.com/bax01234567890')
  assert.equal(current.fulfillment.paymentUrl, null); assert.equal(current.paymentStatus, 'unpaid')
  assert.doesNotMatch(JSON.stringify(current), /ord_test|recharge\.example|110\.00/)
  s.override(path => path.endsWith('/payment-code') ? Response.json({ error: { code: 'direct_payment_code_disabled', retryable: false } }, { status: 403 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, null)
  assert.equal(s.db.prepare('SELECT remote_id FROM recharge_orders').get()!.remote_id, 'ord_test')
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.calls.some(c => c.path.startsWith('/payments/')), false)
})

test('429 body retry hints survive key rotation and successful business writes allow a fresh read', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ error: { code: 'api_poll_too_frequent', retryable: true, retry_after: 45 } }, { status: 429 }) : undefined)
  await assert.rejects(supplierRequest(s.env, '/orders/ord_test'), e => e instanceof RechargeError && e.code === 'api_poll_too_frequent' && e.retryAfter === 45)
  const before = s.calls.length
  await assert.rejects(supplierRequest({ ...s.env, RECHARGE_KEY_ID: 'rotated-key' }, '/orders/ord_test'), e => e instanceof RechargeError && e.retryAfter === 45)
  assert.equal(s.calls.length, before)
  now += 46000
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: s.remoteOrder() }, { headers: { 'X-Poll-After': '300' } }) : undefined)
  await supplierRequest(s.env, '/orders/ord_test')
  await assert.rejects(supplierRequest(s.env, '/orders/ord_test'))
  await supplierRequest(s.env, '/redemptions', JSON.stringify({ mode: 'auto_recharge', order_id: 'ord_test' }), 'compat-reset-key')
  await supplierRequest(s.env, '/orders/ord_test')
  assert.equal(s.calls.filter(c => c.path === '/v1/orders/ord_test').length, 3)
})

test('API-rejected request must not shift upstream attempt numbering', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/redemptions' ? Response.json({ error: { code: 'invalid_credential', retryable: false } }, { status: 400 }) : undefined)
  assert.equal((await s.submit(order.id, buyer)).status, 503)
  s.override(path => path === '/v1/redemptions' ? Response.json({ data: { ...s.redemption(), attempt_no: 1 } }, { status: 202 }) : undefined)
  const response = await s.submit(order.id, buyer)
  assert.equal(response.status, 200)
})
test('signed payment QR survives a transient refresh error', async t => {
  const s = setup(t); s.env.RECHARGE_PAYMENT_CODE_ENABLED = 'true'
  const buyer = await s.buyer(); const order = await s.create(buyer)
  s.override(path => path.endsWith('/payment-code') ? Response.json({ data: { order_id: 'ord_test', merchant_order_no: order.id, amount: '139.00', currency: 'CNY', payment_status: 'pending', payment_code_type: 'alipay_precreate', payment_code: 'https://qr.alipay.com/bax01234567890', expires_at: s.remoteOrder().expires_at } }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 200)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, 'https://qr.alipay.com/bax01234567890')
  s.override(path => path.endsWith('/payment-code') ? Response.json({ error: { code: 'temporarily_unavailable', retryable: true } }, { status: 503 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT payment_qr FROM recharge_orders').get()!.payment_qr, 'https://qr.alipay.com/bax01234567890')
})
test('successful redemption read is applied even while financial read is under backoff', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: s.remoteOrder() }, { headers: { 'X-Poll-After': '300' } }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 200)
  now += 5000; s.setTask('succeeded')
  const response = await s.query(order.id, buyer)
  assert.equal(response.status, 200)
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status, 'succeeded')
})
test('desynchronized terminal backoffs must not permanently discard both success snapshots', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('succeeded'); let initialOrderRead = true
  s.override(path => {
    if (path === '/v1/orders/ord_test') {
      if(initialOrderRead) { initialOrderRead = false; throw new Error('one transient timeout') }
      return Response.json({ data: {...s.remoteOrder(), fulfillment_status:'succeeded'} }, { headers: { 'X-Poll-After': '300', 'X-Poll-Stop': 'true' } })
    }
    if(path.startsWith('/v1/redemptions/')) return Response.json({ data:s.redemption() }, { headers: { 'X-Poll-After': '300', 'X-Poll-Stop': 'true' } })
  })
  const start = s.calls.length; const codes: Record<number, number>={}
  for(let i=0;i<181;i++) { if(i) now+=5000; const r=await s.query(order.id,buyer); codes[r.status]=(codes[r.status]??0)+1; await new Promise(resolve=>setImmediate(resolve)) }
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status,'success')
  assert.equal(codes[503], 1); assert.equal(codes[200], 180)
  assert.ok(s.calls.length - start <= 8, 'polling must retain resource backoff instead of hammering the supplier')
})
test('frontend poll action must be accepted by Workers fulfillment endpoint', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  const response = await s.call(`/api/orders/${order.id}/fulfillment`, { action:'poll' }, buyer)
  assert.equal(response.status,200)
  assert.equal((await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'poll' }, buyer)).status, 200)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
})

test('platform attempt numbers remain distinct from rejected local submissions and cannot be rebound', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/redemptions' ? Response.json({ error: { code: 'invalid_credential', retryable: false } }, { status: 400 }) : undefined)
  assert.equal((await s.submit(order.id, buyer)).status, 503)
  s.override(undefined)
  assert.equal((await s.submit(order.id, buyer)).status, 200)
  s.setTask('failed', true); await s.query(order.id, buyer)
  s.setTask('queued'); assert.equal((await s.submit(order.id, buyer)).status, 200)
  const rows = s.db.prepare('SELECT attempt_no,remote_attempt_no,status,remote_id FROM recharge_redemptions ORDER BY attempt_no').all()
  assert.deepEqual(rows.map(r => [r.attempt_no, r.remote_attempt_no, r.status]), [[1, null, 'rejected'], [2, 1, 'failed'], [3, 2, 'queued']])
  for (const patch of [{ attempt_no: 1 }, { attempt_no: 3 }, { attempt_no: 0 }, { attempt_no: 1.5 }, { redemption_id: 'ful_test' }, { order_id: 'other_order' }]) {
    s.override(path => path.startsWith('/v1/redemptions/') ? Response.json({ data: { ...s.redemption(), ...patch, status: 'succeeded' } }) : undefined)
    assert.equal((await s.query(order.id, buyer)).status, 503)
    assert.deepEqual(s.db.prepare('SELECT attempt_no,remote_attempt_no,status,remote_id FROM recharge_redemptions ORDER BY attempt_no').all(), rows)
    assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'processing')
  }
})

test('an existing unknown submission with a rejected predecessor recovers only its original key and body', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/redemptions' ? Response.json({ error: { code: 'invalid_credential', retryable: false } }, { status: 400 }) : undefined)
  await s.submit(order.id, buyer)
  s.override(undefined); const key = crypto.randomUUID(); await s.submit(order.id, buyer, key)
  // Old releases retained the hash/key but lost the accepted task on the local
  // sequence mismatch. Migration leaves this uncertainty and history intact.
  s.db.prepare("UPDATE recharge_redemptions SET status='unknown',remote_id=NULL,remote_attempt_no=NULL WHERE id=?").run(key)
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal((await s.submit(order.id, buyer, key, session + ' ')).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
  assert.equal((await s.submit(order.id, buyer, key)).status, 200)
  const saved = s.db.prepare('SELECT attempt_no,remote_attempt_no,status,remote_id FROM recharge_redemptions WHERE id=?').get(key)!
  assert.equal(saved.attempt_no, 2); assert.equal(saved.remote_attempt_no, 1); assert.equal(saved.remote_id, 'ful_test'); assert.equal(saved.status, 'queued')
  const replay = s.calls.filter(c => c.key === 'recharge:' + key)
  assert.equal(replay.length, 2); assert.equal(replay[0].body, replay[1].body)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions').get()!.n, 2)
})

test('local polling deferral retains confirmed state without issuing early reads or acknowledging a pending notice', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ data: s.remoteOrder() }, { headers: { 'X-Poll-After': '300' } }) : path.startsWith('/v1/redemptions/') ? Response.json({ data: s.redemption() }, { headers: { 'X-Poll-After': '300' } }) : undefined)
  await s.query(order.id, buyer); await s.notice('evt_deferred')
  const before = s.calls.length; now += 5000
  const result = await s.call(`/api/orders/${order.id}/fulfillment`, { action: 'poll' }, buyer)
  assert.equal(result.status, 200); assert.equal((await result.json()).order.status, 'processing'); assert.equal(s.calls.length, before)
  let row = s.db.prepare('SELECT notify_version,checked_notify_version FROM recharge_orders').get()!
  assert.ok(Number(row.notify_version) > Number(row.checked_notify_version))
  now += 300000; await s.query(order.id, buyer)
  row = s.db.prepare('SELECT notify_version,checked_notify_version FROM recharge_orders').get()!
  assert.equal(row.notify_version, row.checked_notify_version)
})

test('a successful task snapshot persists through a financial read failure without hiding the failure', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('succeeded')
  s.override(path => path === '/v1/orders/ord_test' ? Response.json({ error: { code: 'temporarily_unavailable', retryable: true } }, { status: 503 }) : undefined)
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status, 'succeeded')
  assert.equal(s.db.prepare('SELECT payment_status FROM orders').get()!.payment_status, 'paid')
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
})

test('saving a successful task cannot advance fulfillment through a newly verified financial hold', async t => {
  const s = setup(t); const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  s.setTask('succeeded'); s.setRefund('succeeded'); s.setPayment('refunded')
  const result = await s.query(order.id, buyer)
  assert.equal(result.status, 200)
  const current = (await result.json()).order
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status, 'succeeded')
  assert.equal(current.status, 'processing'); assert.equal(current.refundHold, true); assert.equal(current.fulfillment.canSubmit, false)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold, 1)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
})

test('remote attempt migration preserves old rejected and unknown history without inventing platform numbers', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files.filter(f => f < '0045_')) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
    db.exec("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,status,mode,payment_status,created_at,updated_at,last_event_id) VALUES ('YMX-MIGRATION','owner','key','plus','Plus',13900,'processing','live','paid',1,1,'event')")
    db.exec("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,updated_at) VALUES ('YMX-MIGRATION','account','plus','platform_collect','{}','ord_old',1)")
    db.exec("INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,created_at) VALUES ('rejected','YMX-MIGRATION',1,'hash-one','session','rejected',1),('unknown','YMX-MIGRATION',2,'hash-two','session','unknown',2)")
    const before = db.prepare('SELECT * FROM recharge_redemptions ORDER BY attempt_no').all()
    db.exec(readFileSync(new URL('../migrations/0045_recharge_remote_attempt.sql', import.meta.url), 'utf8'))
    const after = db.prepare('SELECT * FROM recharge_redemptions ORDER BY attempt_no').all()
    assert.deepEqual(after.map(({ remote_attempt_no, ...row }) => { assert.equal(remote_attempt_no, null); return { ...row } }), before.map(row => ({ ...row })))
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { db.close() }
})

test('independently successful reads acknowledge the same notification without requiring aligned polling windows', async t => {
  const s = setup(t); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer); await s.submit(order.id, buyer)
  await s.notice('evt_split_reads')
  let unavailable = true; s.setTask('succeeded')
  s.override(path => {
    if (path === '/v1/orders/ord_test') {
      if (unavailable) { unavailable = false; throw new Error('one failed read') }
      return Response.json({ data: s.remoteOrder() }, { headers: { 'X-Poll-After': '300' } })
    }
    if (path.startsWith('/v1/redemptions/')) return Response.json({ data: s.redemption() }, { headers: { 'X-Poll-After': '300' } })
  })
  assert.equal((await s.query(order.id, buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT checked_notify_version FROM recharge_orders').get()!.checked_notify_version, 0)
  now += 5000
  assert.equal((await s.query(order.id, buyer)).status, 200)
  const row = s.db.prepare('SELECT notify_version,checked_notify_version FROM recharge_orders').get()!
  assert.equal(row.notify_version, 1); assert.equal(row.checked_notify_version, 1)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'success')
})

test('security fix: active recharge dispatch excludes a racing refund request', async t => {
 const s=setup(t), buyer=await s.buyer(), order=await s.create(buyer)
 await s.query(order.id,buyer); s.setPayment('paid'); await s.query(order.id,buyer)
 const original=s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB)
 let triggered=false, refundStatus=0
 s.env.INTEREST_DB.batch=async statements=>{
  const result=await original(statements)
  if (!triggered && s.db.prepare('SELECT 1 FROM recharge_redemptions WHERE order_id=?').get(order.id)) {
   triggered=true
   const row=s.db.prepare('SELECT version FROM orders WHERE id=?').get(order.id)!
   const response=await s.call(`/api/orders/${order.id}/refunds`,{key:crypto.randomUUID(),version:row.version,reason:'取消服务'},buyer)
   refundStatus=response.status
  }
  return result
 }
 const response=await s.submit(order.id,buyer)
 assert.equal(response.status,200,await response.clone().text())
 assert.equal(refundStatus,409)
 assert.equal(s.db.prepare('SELECT refund_hold FROM orders WHERE id=?').get(order.id)!.refund_hold,0)
 assert.equal(s.calls.filter(c=>c.path==='/v1/redemptions').length,1)
})


test('security fix: anonymous empty requests cannot lock out a valid administrator', async t=>{
 const s=setup(t)
 for(let ip=1;ip<=4;ip++)for(let i=0;i<8;i++){
  const r=await worker.fetch(new Request('https://shop.example.invalid/api/admin/login',{method:'POST',headers:{Origin:'https://shop.example.invalid','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+ip},body:'{}'}),s.env)
  assert.ok([401,429].includes(r.status))
 }
 const valid={username:'tester',code:await totpCode(s.env.ADMIN_TOTP_SECRET!),...await seedAdminEmailCode(s.db,s.env)}
 const r=await worker.fetch(new Request('https://shop.example.invalid/api/admin/login',{method:'POST',headers:{Origin:'https://shop.example.invalid','Content-Type':'application/json','CF-Connecting-IP':'198.51.100.1'},body:JSON.stringify(valid)}),s.env)
 assert.equal(r.status,200)
})

test('security fix: unresolved recharge blocks refunds after lease expiry, failed recharge allows refunds', async t => {
  const s = setup(t), buyer = await s.buyer(), order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const key = crypto.randomUUID()
  s.override(path => path === '/v1/redemptions' ? new Response('temporary', { status: 503 }) : undefined)
  assert.equal((await s.submit(order.id, buyer, key)).status, 503)
  assert.equal(s.db.prepare('SELECT status FROM recharge_redemptions').get()!.status, 'unknown')
  const refund = async () => s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: (await getOrder(s.env, order.id)).version, reason: '申请退款' }, buyer)
  assert.equal((await refund()).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n, 0)
  s.override(() => undefined)
  assert.equal((await s.submit(order.id, buyer, key)).status, 200)
  assert.equal((await refund()).status, 409)
  s.setTask('failed', true); await s.query(order.id, buyer)
  assert.equal((await refund()).status, 201)
  const before = s.calls.filter(c => c.path === '/v1/redemptions').length
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, before)
})

test('security fix: refund winning before recharge prevents dispatch', async t => {
  const s = setup(t), buyer = await s.buyer(), order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const refund = await s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: (await getOrder(s.env, order.id)).version, reason: '取消充值' }, buyer)
  assert.equal(refund.status, 201)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 0)
})

test('security fix: valid email challenges still share a distributed TOTP attempt budget', async t => {
  const s = setup(t)
  const wrong = String((Number(await totpCode(s.env.ADMIN_TOTP_SECRET!)) + 1) % 1000000).padStart(6, '0')
  for (let i = 0; i < 31; i++) {
    const data = { username: 'tester', code: wrong, ...await seedAdminEmailCode(s.db, s.env) }
    const r = await worker.fetch(new Request('https://shop.example.invalid/api/admin/login', { method: 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.' + (i + 1) }, body: JSON.stringify(data) }), s.env)
    assert.equal(r.status, i < 30 ? 401 : 429)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
})

test('security fix: legacy refund hold cannot start an upstream refund while recharge is unresolved', async t => {
  const s = setup(t), buyer = await s.buyer(), order = await s.create(buyer), admin = await s.login()
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  const refund = await approveRefund(s, order.id, buyer, admin, 13900)
  // Simulate the persisted state created by the pre-fix race: an approved refund
  // and an already-dispatched recharge. New customer requests cannot create it.
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(order.id)
  assert.equal((await s.submit(order.id, buyer)).status, 200)
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  const r = await s.call('/api/admin/refunds/' + refund, { action: 'execute-refund', version: 1, note: '核对后退款' }, admin)
  assert.equal(r.status, 409)
  assert.equal(s.calls.filter(c => c.path.endsWith('/refunds')).length, 0)
  s.setTask('failed'); await s.query(order.id, buyer)
  // An existing held order can still query its fulfillment and then submit refund.
  assert.equal((await s.call('/api/admin/refunds/' + refund, { action: 'execute-refund', version: 1, note: '核对后退款' }, admin)).status, 409)
  assert.equal(s.calls.filter(c => c.path.endsWith('/refunds')).length, 1)
})

test('security fix: active recharge lease blocks refund before an attempt exists, expired lease alone does not', async t => {
  const s = setup(t), buyer = await s.buyer(), order = await s.create(buyer)
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.db.prepare('UPDATE recharge_orders SET lease_token=?,lease_until=? WHERE order_id=?').run('in-flight', Date.now() + 45000, order.id)
  const refund = () => s.call(`/api/orders/${order.id}/refunds`, { key: crypto.randomUUID(), version: s.db.prepare('SELECT version FROM orders WHERE id=?').get(order.id)!.version, reason: '申请退款' }, buyer)
  assert.equal((await refund()).status, 409)
  assert.equal(s.db.prepare('SELECT refund_hold FROM orders WHERE id=?').get(order.id)!.refund_hold, 0)
  s.db.prepare('UPDATE recharge_orders SET lease_until=? WHERE order_id=?').run(Date.now() - 1, order.id)
  assert.equal((await refund()).status, 201)
})


function auditPartner(s: ReturnType<typeof setup>, suffix = '1') {
  s.env.PARTNER_AUTH_SECRET = 'audit-only-partner-auth-secret-at-least-32'
  const id = crypto.randomUUID(), slug = 'AUDIT' + suffix, token = (suffix === '1' ? 'b' : 'c').repeat(64), now = Date.now()
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,slug,'Audit shop',`partner${suffix}@example.test`,now,now)
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES(?,?,?,?)').run(id,'plus',11000,15900)
  s.db.prepare('INSERT INTO partner_sessions(token_hash,partner_id,auth_version,credential_version,expires_at) VALUES(?,?,0,?,?)').run(digest(token),id,digest(s.env.PARTNER_AUTH_SECRET),now+3600000)
  return { id, slug, cookie: '__Host-ymx_partner='+token }
}

test('partner fixes: real API order details work for its partner and admin', async t => {
  const s=setup(t), p=auditPartner(s), buyer=await s.buyer(), admin=await s.login()
  const r=await s.call('/api/orders',{plan:'plus',partner:p.slug,expectedPrice:15900,email:'buyer@example.test',key:crypto.randomUUID()},buyer)
  assert.equal(r.status,201,await r.clone().text())
  const order=(await r.json()).order
  assert.match(order.id,/^YMX-[A-Z0-9]+$/)
  const listed=await (await s.call('/api/partner/orders',undefined,p.cookie)).json()
  assert.equal(listed.rows[0].id,order.id)
  assert.equal((await s.call('/api/partner/orders/'+order.id,undefined,p.cookie)).status,200)
  assert.equal((await s.call(`/api/admin/partners/${p.id}/orders/${order.id}`,undefined,admin)).status,200)
  assert.equal((await s.call('/api/orders/'+order.id,undefined,buyer)).status,200)
})

test('partner fixes: unsafe partner prices are disabled before checkout', async t => {
  const s=setup(t), p=auditPartner(s), buyer=await s.buyer()
  s.db.prepare('UPDATE partner_prices SET cost_cents=10000 WHERE partner_id=?').run(p.id)
  const catalog=await (await s.call('/api/catalog?partner='+p.slug)).json()
  assert.equal(catalog.plans.find((x:{id:string})=>x.id==='plus').enabled,0)
  const r=await s.call('/api/orders',{plan:'plus',partner:p.slug,expectedPrice:15900,email:'buyer@example.test',key:crypto.randomUUID()},buyer)
  assert.equal(r.status,409)
  assert.match((await r.json()).error,/供货价需重新核对/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0)
})

test('partner fixes: cached catalog shares supplier reads but checks current partner prices and expires', async t => {
  const s = setup(t), p = auditPartner(s), buyer = await s.buyer()
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const catalog = async () => (await (await s.call('/api/catalog?partner=' + p.slug)).json()).plans.find((p: { id: string }) => p.id === 'plus')
  const productsRead = () => s.calls.filter(c => c.path === '/v1/products').length
  const first = await Promise.all([catalog(), catalog(), catalog()])
  assert.ok(first.every(plan => plan.enabled === 1)); assert.equal(productsRead(), 1)
  s.db.prepare('UPDATE partner_prices SET cost_cents=10000 WHERE partner_id=?').run(p.id)
  assert.equal((await catalog()).enabled, 0); assert.equal(productsRead(), 1)
  const dashboard = await (await s.call('/api/partner/dashboard', undefined, p.cookie)).json()
  assert.equal(dashboard.plans[0].enabled, 0); assert.match(dashboard.plans[0].saleIssue, /供货价/)
  s.db.prepare('UPDATE partner_prices SET cost_cents=11000 WHERE partner_id=?').run(p.id)
  assert.equal((await catalog()).enabled, 1)
  s.products[0].supply_price = '111.00'
  // Cache is display-only: fresh checkout validation rejects the now-unsafe cost.
  const r = await s.call('/api/orders', { plan: 'plus', partner: p.slug, expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  assert.equal(r.status, 409); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  now += 60001
  assert.equal((await catalog()).enabled, 0); assert.equal(productsRead(), 3)
})

test('partner fixes: catalog provider failure is contained and does not block paid fulfillment', async t => {
  const s = setup(t), p = auditPartner(s), buyer = await s.buyer()
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const created = await s.call('/api/orders', { plan: 'plus', partner: p.slug, expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  assert.equal(created.status, 201); const order = (await created.json()).order
  await s.query(order.id, buyer); s.setPayment('paid'); await s.query(order.id, buyer)
  s.override(path => path === '/v1/products' ? new Response('unavailable', { status: 503 }) : undefined)
  const before = s.calls.filter(c => c.path === '/v1/products').length
  for (let i = 0; i < 3; i++) {
    const response = await s.call('/api/catalog?partner=' + p.slug); assert.equal(response.status, 200)
    const plan = (await response.json()).plans.find((p: { id: string }) => p.id === 'plus')
    assert.equal(plan.enabled, 0); assert.match(plan.saleIssue, /暂时无法核对/)
  }
  assert.equal(s.calls.filter(c => c.path === '/v1/products').length, before + 1)
  assert.equal((await s.submit(order.id, buyer)).status, 200)
  s.setTask('succeeded'); const done = await s.query(order.id, buyer)
  assert.equal(done.status, 200); assert.equal((await done.json()).order.status, 'success')
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
  s.override(() => undefined); now += 5001
  const recovered = await (await s.call('/api/catalog?partner=' + p.slug)).json()
  assert.equal(recovered.plans.find((p: { id: string }) => p.id === 'plus').enabled, 1)
})

test('partner fixes: real-format detail still excludes other partners and preserves order state', async t => {
  const s = setup(t), p = auditPartner(s), other = auditPartner(s, '2').cookie, buyer = await s.buyer(), admin = await s.login()
  const r = await s.call('/api/orders', { plan: 'plus', partner: p.slug, expectedPrice: 15900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  const id = (await r.json()).order.id, before = s.db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  assert.equal((await s.call('/api/partner/orders/' + id, undefined, other)).status, 404)
  assert.equal((await s.call(`/api/admin/partners/${crypto.randomUUID()}/orders/${id}`, undefined, admin)).status, 404)
  assert.equal((await s.call('/api/partner/orders/' + id)).status, 401)
  const response = await s.call('/api/partner/orders/' + id, undefined, p.cookie)
  assert.equal(response.status, 200); const detail = await response.text()
  assert.doesNotMatch(detail, /owner_hash|create_body|paymentQr|retryKey|credential_mode/)
  assert.deepEqual(s.db.prepare('SELECT * FROM orders WHERE id=?').get(id), before)
})

test('partner acceptance: isolated 149/139 order completes payment, delivery, 10-yuan commission and manual payout once', async t => {
  // Fixture setup only: all databases, identities and upstream responses are local.
  // From order creation onward, financial state changes only through Worker APIs.
  const s = setup(t), partner = auditPartner(s), otherPartner = auditPartner(s, '2')
  const buyer = await s.buyer(), stranger = await s.buyer(), admin = await s.login()
  s.db.prepare('UPDATE partner_prices SET cost_cents=13900,price_cents=13900 WHERE partner_id=?').run(partner.id)
  const control = await s.create(stranger)
  const controlSnapshot = () => ({
    order: s.db.prepare('SELECT * FROM orders WHERE id=?').get(control.id),
    supplier: s.db.prepare('SELECT * FROM recharge_orders WHERE order_id=?').get(control.id),
    events: s.db.prepare('SELECT * FROM order_events WHERE order_id=? ORDER BY order_version').all(control.id),
    mainPlan: s.db.prepare("SELECT * FROM catalog_plans WHERE id='plus'").get(),
    otherPrices: s.db.prepare('SELECT * FROM partner_prices WHERE partner_id=?').all(otherPartner.id),
  })
  const untouched = controlSnapshot()
  const response = async (r: Response, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json() }
  const dashboard = async () => response(await s.call('/api/partner/dashboard', undefined, partner.cookie))
  const payout = (key = crypto.randomUUID(), accountVersion = 1) => s.call('/api/partner/payouts', { key, accountVersion }, partner.cookie)
  const notice = (type: string, event: string, valid = true) => {
    const stamp = String(Math.floor(Date.now() / 1000))
    const raw = JSON.stringify({ event_id: event, type, data: { order_id: 'ord_test' } })
    return worker.fetch(new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Quefa-Event': type, 'X-Quefa-Event-Id': event, 'X-Quefa-Delivery': 'dlv_' + event,
      'X-Quefa-Timestamp': stamp, 'X-Quefa-Signature': `t=${stamp},v1=${valid ? mac(stamp + '.' + raw, webhookSecret) : '0'.repeat(64)}`,
    }, body: raw }), s.env)
  }

  await response(await s.call('/api/partner/prices/plus', { priceCents: 14900, version: 0 }, partner.cookie))
  const catalog = await response(await s.call('/api/catalog?partner=' + partner.slug))
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === 'plus').price_cents, 14900)
  const payload = { plan: 'plus', partner: partner.slug, expectedPrice: 14900, email: 'acceptance-buyer@example.test', key: crypto.randomUUID() }
  const order = (await response(await s.call('/api/orders', payload, buyer), 201)).order
  assert.equal((await response(await s.call('/api/orders', payload, buyer))).order.id, order.id)
  assert.equal(s.db.prepare('SELECT cost_cents FROM orders WHERE id=?').get(order.id)!.cost_cents, 13900)
  assert.equal((await dashboard()).stats.available, 0)
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal((await s.call('/api/orders/' + order.id, undefined, stranger)).status, 404)
  assert.equal((await s.call('/api/partner/orders/' + order.id, undefined, otherPartner.cookie)).status, 404)
  t.diagnostic('下单：149元，供货价139元，重复请求仍为同一订单；其他买家和分站不能读取。')

  await response(await s.query(order.id, buyer))
  assert.equal((await notice('order.paid', 'acceptance_bad', false)).status, 400)
  // Even a valid payment notification cannot invent a successful payment.
  await response(await notice('order.paid', 'acceptance_early'))
  await response(await s.query(order.id, buyer))
  assert.equal((await getOrder(s.env, order.id)).payment_status, 'unpaid')
  s.setPayment('paid')
  await response(await notice('order.paid', 'acceptance_paid'))
  await response(await notice('order.paid', 'acceptance_paid'))
  const paid = (await response(await s.query(order.id, buyer))).order
  assert.equal(paid.paymentStatus, 'paid'); assert.equal(paid.status, 'session')
  assert.equal((await dashboard()).stats.available, 0)
  await response(await s.call('/api/partner/payout-account', { phone: '13800000000', name: '本地模拟收款人', version: 0 }, partner.cookie))
  assert.equal((await payout()).status, 409)
  t.diagnostic('支付：验签及主动查单通过后确认已付；尚未履约时收益为0，禁止提现。')

  const submitKey = crypto.randomUUID()
  await response(await s.submit(order.id, buyer, submitKey))
  assert.equal((await s.submit(order.id, buyer)).status, 409)
  assert.equal((await getOrder(s.env, order.id)).status, 'processing')
  assert.equal((await dashboard()).stats.available, 0)
  s.setTask('succeeded')
  await response(await notice('fulfillment.updated', 'acceptance_delivered'))
  await response(await notice('fulfillment.updated', 'acceptance_delivered'))
  const delivered = (await response(await s.query(order.id, buyer))).order
  assert.equal(delivered.status, 'success')
  assert.equal((await dashboard()).stats.available, 1000)
  assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
  assert.equal(s.calls.filter(c => c.path === '/v1/orders').length, 1)
  const details = await response(await s.call('/api/partner/orders/' + order.id, undefined, partner.cookie))
  assert.equal(details.order.profit_cents, 1000)
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE-TOKEN|retryKey|paymentUrl/)
  t.diagnostic('履约与收益：模拟开通成功，产生10元可提现收益，重复通知和重复提交没有二次充值。')

  assert.equal((await payout(crypto.randomUUID(), 0)).status, 409)
  const payoutKey = crypto.randomUUID()
  await response(await payout(payoutKey), 201)
  await response(await payout(payoutKey))
  const ps = s.db.prepare('SELECT * FROM partner_payouts WHERE partner_id=?').get(partner.id)!
  assert.equal(ps.amount_cents, 1000)
  assert.equal(ps.recipient, '13800000000 / 本地模拟收款人')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payout_items WHERE payout_id=? AND order_id=? AND profit_cents=1000').get(ps.id, order.id)!.n, 1)
  assert.equal((await dashboard()).stats.available, 0)
  assert.equal((await dashboard()).totals.pending, 1000)
  const path = '/api/admin/partner-payouts/' + ps.id
  assert.equal((await s.call(path, { action: 'approve', version: 0, note: '仅本地模拟' }, partner.cookie)).status, 401)
  assert.equal((await s.call(path, { action: 'paid', version: 0, note: '仅本地模拟', reference: 'SIMULATED-NO-TRANSFER' }, admin)).status, 409)
  s.override(path => { if (path === '/v1/orders/ord_test') throw new Error('simulated supplier outage') })
  assert.equal((await s.call(path, { action: 'approve', version: 0, note: '仅本地模拟' }, admin)).status, 503)
  assert.equal(s.db.prepare('SELECT reviewed_at FROM partner_payouts WHERE id=?').get(ps.id)!.reviewed_at, null)
  s.override(undefined)
  await response(await s.call(path, { action: 'approve', version: 0, note: '本地模拟核对收益通过' }, admin))
  const claimResponse = await s.call(path, { action: 'start-transfer', version: 1, note: '本地模拟领取转账处理权' }, admin)
  assert.equal(claimResponse.status, 200)
  const claim = { version: 2, attemptId: (await claimResponse.json()).attemptId, transferConfirmed: true }
  assert.equal((await s.call(path, { action: 'paid', version: 1, note: '本地模拟', reference: '' }, admin)).status, 400)
  t.diagnostic('提现申请与审核：锁定10元，重复申请不重复占款；越权、未审核和上游查询异常均拦截。')

  // This is bookkeeping in an in-memory database, never an actual transfer.
  const transfer = { action: 'paid', ...claim, note: '仅本地模拟登记，不发生真实转账', reference: 'SIMULATED-NO-TRANSFER' }
  await response(await s.call(path, transfer, admin))
  assert.equal((await s.call(path, transfer, admin)).status, 409)
  const final = await dashboard()
  assert.equal(final.stats.available, 0); assert.equal(final.totals.pending, 0); assert.equal(final.totals.paid, 1000)
  assert.equal(final.stats.payoutCoolingDown, true)
  assert.equal((await payout()).status, 409)
  assert.equal((await response(await s.call('/api/partner/orders/' + order.id, undefined, partner.cookie))).order.payout_status, 'paid')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM order_events WHERE order_id=? AND action=\'payment-confirmed\'').get(order.id)!.n, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_redemptions WHERE order_id=?').get(order.id)!.n, 1)
  assert.deepEqual(controlSnapshot(), untouched)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts WHERE partner_id=?').get(otherPartner.id)!.n, 0)
  t.diagnostic('模拟转账登记：已提现10元、待付0、可提0；重复登记被拒，正常对照订单及其他分站配置保持不变。')
})

test('payout safety: start transfer revalidates a previously approved commission', async t => {
  const s = setup(t), partner = s.partner(), buyer = await s.buyer(), order = await partnerOrder(s, buyer), admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts', { key: crypto.randomUUID(), recipient: 'LOCAL ONLY' }, partner)).status, 201)
  const ps = s.db.prepare('SELECT * FROM partner_payouts').get()!, path = '/api/admin/partner-payouts/' + ps.id
  assert.equal((await s.call(path, { action: 'approve', version: 0, note: '审核' }, admin)).status, 200)
  s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'refunded', refunded_amount: '159.00', merchant_margin: '-110.00' } }) : undefined)
  assert.equal((await s.call(path, { action: 'start-transfer', version: 1, note: '转账前重新核对' }, admin)).status, 409)
  assert.equal((await s.call(path, { action: 'paid', version: 1, note: '旧页面不能跳过转账领取', reference: 'LOCAL-ONLY' }, admin)).status, 409)
  assert.equal(s.db.prepare('SELECT status FROM partner_payouts').get()!.status, 'pending')
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, ps.id)
})

test('payout safety: transfer claim is single use and unknown outcome cannot release earnings', async t => {
  const s = setup(t), partner = s.partner(), buyer = await s.buyer(), order = await partnerOrder(s, buyer), admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts', { key: crypto.randomUUID(), recipient: 'LOCAL ONLY' }, partner)).status, 201)
  const ps = s.db.prepare('SELECT * FROM partner_payouts').get()!, path = '/api/admin/partner-payouts/' + ps.id
  assert.equal((await s.call(path, { action: 'approve', version: 0, note: '审核' }, admin)).status, 200)
  const starts = await Promise.all([1, 2].map(() => s.call(path, { action: 'start-transfer', version: 1, note: '本地开始转账' }, admin)))
  assert.deepEqual(starts.map(r => r.status).sort(), [200, 409])
  const claimed = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal(claimed.transfer_state, 'transferring')
  assert.equal((await s.call(path, { action: 'rejected', version: 2, note: '结果不明不能退回' }, admin)).status, 409)
  assert.equal((await s.call(path, { action: 'mark-unknown', version: 2, attemptId: claimed.transfer_id, note: '外部结果未知' }, admin)).status, 200)
  s.db.exec('UPDATE partner_payouts SET transfer_started_at=1,created_at=1,cooldown_exempt=1')
  assert.equal((await s.call(path, { action: 'start-transfer', version: 3, note: '不能再次打款' }, admin)).status, 409)
  assert.equal((await s.call(path, { action: 'confirm-not-transferred', version: 3, attemptId: claimed.transfer_id, note: '未核验不能释放' }, admin)).status, 400)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, ps.id)
  assert.equal((await (await s.call('/api/partner/dashboard', undefined, partner)).json()).stats.available, 0)
  assert.equal((await s.call(path, { action: 'confirm-not-transferred', version: 3, attemptId: claimed.transfer_id, confirmedNotTransferred: true, evidence: '仅本地模拟：已核对账单，没有发生实际转账。', note: '确认未转账后释放' }, admin)).status, 200)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, null)
  assert.equal(s.db.prepare('SELECT transfer_state FROM partner_payouts').get()!.transfer_state, 'not_sent')
})

test('payout safety: supplier outage on transfer start fails closed and retry revalidates', async t => {
  const s = setup(t), partner = s.partner(), buyer = await s.buyer(), order = await partnerOrder(s, buyer), admin = await s.login()
  assert.equal((await s.call('/api/partner/payouts', { key: crypto.randomUUID(), recipient: 'LOCAL ONLY' }, partner)).status, 201)
  const ps = s.db.prepare('SELECT * FROM partner_payouts').get()!, path = '/api/admin/partner-payouts/' + ps.id
  assert.equal((await s.call(path, { action: 'approve', version: 0, note: '审核' }, admin)).status, 200)
  s.override(p => { if (p === '/v1/orders/ord_test') throw new Error('local simulated outage') })
  assert.equal((await s.call(path, { action: 'start-transfer', version: 1, note: '领取' }, admin)).status, 503)
  assert.equal(s.db.prepare('SELECT transfer_state FROM partner_payouts').get()!.transfer_state, 'idle')
  assert.equal(s.db.prepare('SELECT version FROM partner_payouts').get()!.version, 1)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, ps.id)
  s.override(undefined)
  assert.equal((await s.call(path, { action: 'start-transfer', version: 1, note: '重新核验' }, admin)).status, 200)
})

for (const outcome of ['paid', 'not-sent'] as const) {
  test(`payout acceptance: unknown -> ${outcome} -> refund reconciles once and preserves control orders`, async t => {
    // In-memory DB, fake identities, mocked supplier. No production or real transfers.
    // After fixture setup, all order, payout and refund mutations use Worker APIs.
    const s = setup(t), partner = auditPartner(s), other = auditPartner(s, '2')
    const buyer = await s.buyer(), controlBuyer = await s.buyer(), admin = await s.login()
    const check = async (r: Response, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json() }
    const control = await s.create(controlBuyer)
    const snapshot = () => ({
      order: s.db.prepare('SELECT * FROM orders WHERE id=?').get(control.id),
      supplier: s.db.prepare('SELECT * FROM recharge_orders WHERE order_id=?').get(control.id),
      events: s.db.prepare('SELECT * FROM order_events WHERE order_id=? ORDER BY order_version').all(control.id),
      plans: s.db.prepare('SELECT * FROM catalog_plans ORDER BY id').all(),
      other: s.db.prepare('SELECT * FROM partner_prices WHERE partner_id=? ORDER BY plan').all(other.id),
    })
    const untouched = snapshot()
    const order = (await check(await s.call('/api/orders', { plan: 'plus', partner: partner.slug, expectedPrice: 15900, email: 'local-acceptance@example.test', key: crypto.randomUUID() }, buyer), 201)).order
    await check(await s.query(order.id, buyer)); s.setPayment('paid'); await check(await s.query(order.id, buyer))
    await check(await s.submit(order.id, buyer)); s.setTask('succeeded')
    assert.equal((await check(await s.query(order.id, buyer))).order.status, 'success')
    await check(await s.call('/api/partner/payout-account', { phone: '13800000000', name: '模拟收款人', version: 0 }, partner.cookie))
    const dashboard = async () => check(await s.call('/api/partner/dashboard', undefined, partner.cookie))
    const request = (key = crypto.randomUUID()) => s.call('/api/partner/payouts', { key, accountVersion: 1 }, partner.cookie)
    assert.equal((await dashboard()).stats.available, 4900)
    const key = crypto.randomUUID()
    const sameKey = await Promise.all(Array.from({ length: 20 }, () => request(key)))
    // Concurrent supplier verification is itself leased: losing requests may
    // return 409 rather than an idempotent 200. Retrying after completion must
    // resolve to the existing payout, never reserve another one.
    assert.equal(sameKey.filter(r => r.status === 201).length, 1)
    assert.equal(sameKey.filter(r => r.status === 409).length, 19)
    for (const r of sameKey.filter(r => r.status === 409)) assert.match((await r.json()).error, /订单正在同步/)
    await check(await request(key))
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n, 1)
    const differentKeys = await Promise.all(Array.from({ length: 20 }, () => request()))
    assert.ok(differentKeys.every(r => r.status === 409))
    const ps = s.db.prepare('SELECT * FROM partner_payouts').get()!, path = '/api/admin/partner-payouts/' + ps.id
    assert.equal(ps.amount_cents, 4900)
    await check(await s.call(path, { action: 'approve', version: 0, note: '本地模拟审核' }, admin))
    const starts = await Promise.all(Array.from({ length: 20 }, () => s.call(path, { action: 'start-transfer', version: 1, note: '本地领取' }, admin)))
    assert.equal(starts.filter(r => r.status === 200).length, 1)
    assert.equal(starts.filter(r => r.status === 409).length, 19)
    const attemptId = (await starts.find(r => r.status === 200)!.json()).attemptId
    await check(await s.call(path, { action: 'mark-unknown', version: 2, attemptId, note: '模拟付款结果未知' }, admin))
    assert.deepEqual(snapshot(), untouched)
    assert.equal((await dashboard()).totals.pending, 4900)
    assert.equal((await dashboard()).stats.available, 0)
    const refund = await approveRefund(s, order.id, buyer, admin, 1000)
    s.override(p => p === '/v1/orders/ord_test' ? Response.json({ data: { ...s.remoteOrder(), payment_status: 'partially_refunded', refunded_amount: '10.00', merchant_margin: '39.00' } }) : undefined)
    const reconcile = () => s.call('/api/admin/refunds/' + refund, { action: 'reconcile-platform-refund', version: 1, note: '本地核对上游已退款' }, admin)
    assert.equal((await reconcile()).status, 409)
    for (const action of ['rejected', 'start-transfer']) assert.equal((await s.call(path, { action, version: 3, note: '禁止解锁或重打' }, admin)).status, 409)
    assert.equal((await s.call(path, { action: 'paid', version: 3, attemptId: 'wrong-attempt', transferConfirmed: true, reference: 'SIM-ONLY', note: '错误处理编号' }, admin)).status, 409)
    // Cooldown reset cannot release an unknown transfer or bypass its pending lock.
    await check(await s.call(`/api/admin/partners/${partner.id}/payout-cooldown/reset`, { key: crypto.randomUUID(), note: '本地测试冷却豁免不解锁' }, admin))
    assert.equal((await request()).status, 409)
    assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, ps.id)
    const resolution = { action: outcome === 'paid' ? 'paid' : 'confirm-not-transferred', version: 3, attemptId, note: '本地模拟核对结果', reference: 'SIM-UNKNOWN-PAID', transferConfirmed: true, confirmedNotTransferred: true, evidence: '模拟核对付款账户账单，确认未转出且没有处理中交易' }
    const resolved = await Promise.all(Array.from({ length: 20 }, () => s.call(path, resolution, admin)))
    assert.equal(resolved.filter(r => r.status === 200).length, 1)
    assert.equal(resolved.filter(r => r.status === 409).length, 19)
    const refunds = await Promise.all([reconcile(), reconcile()])
    assert.deepEqual(refunds.map(r => r.status).sort(), [200, 409])
    assert.equal((await getOrder(s.env, order.id)).refunded_cents, 1000)
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases WHERE status=\'refunded\'').get()!.n, 1)
    if (outcome === 'paid') {
      const stats = await dashboard()
      assert.equal(stats.totals.paid, 4900); assert.equal(stats.totals.pending, 0); assert.equal(stats.stats.available, 0); assert.equal(stats.stats.debt, 1000)
      assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 1)
      assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, ps.id)
      assert.equal((await request()).status, 409)
      t.diagnostic('已转出分支：已提现49元、退款10元、唯一抵扣10元、可提现0元，历史订单持续占用。')
    } else {
      assert.equal((await dashboard()).stats.available, 3900)
      assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 0)
      assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, null)
      const requests = await Promise.all(Array.from({ length: 20 }, () => request()))
      assert.equal(requests.filter(r => r.status === 201).length, 1); assert.equal(requests.filter(r => r.status === 409).length, 19)
      const next = s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!, nextPath = '/api/admin/partner-payouts/' + next.id
      assert.equal(next.amount_cents, 3900)
      await check(await s.call(nextPath, { action: 'approve', version: 0, note: '核验退款后剩余收益' }, admin))
      const claim = await check(await s.call(nextPath, { action: 'start-transfer', version: 1, note: '本地领取新申请' }, admin))
      await check(await s.call(nextPath, { action: 'paid', version: 2, attemptId: claim.attemptId, transferConfirmed: true, reference: 'SIM-NEW-PAYOUT', note: '本地登记39元' }, admin))
      assert.equal((await s.call(path, resolution, admin)).status, 409)
      assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order.id)!.payout_id, next.id)
      const stats = await dashboard()
      assert.equal(stats.totals.paid, 3900); assert.equal(stats.totals.pending, 0); assert.equal(stats.stats.available, 0); assert.equal(stats.stats.debt, 0)
      t.diagnostic('未转出分支：旧49元申请退回，退款后仅39元能重新提现；新申请结算后旧请求不能释放新占款。')
    }
    assert.deepEqual(snapshot(), untouched)
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts WHERE partner_id=?').get(other.id)!.n, 0)
    assert.equal(s.calls.filter(c => c.path === '/v1/redemptions').length, 1)
    assert.equal(s.calls.some(c => c.path.endsWith('/refunds')), false)
    t.diagnostic('对照订单、事件、商品及其他代理配置逐字段一致；没有真实外部调用，没有二次履约或主动退款。')
  })
}
