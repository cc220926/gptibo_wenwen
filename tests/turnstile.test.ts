import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFixture } from './customer-fixture.ts'

const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const valid = () => ({ success: true, hostname: 'shop.example.invalid', action: 'order_create', challenge_ts: new Date().toISOString() })
const setup = async () => {
  const s = await customerFixture()
  Object.assign(s.env, { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'fixture-public-key', TURNSTILE_SECRET_KEY: 'fixture-private-key', TURNSTILE_HOSTNAMES: 'shop.example.invalid' })
  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const order = () => ({ plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID(), email: 'buyer@example.test', turnstileToken: 'valid-challenge' })
  return { ...s, buyer, order }
}

test('public checkout config exposes only the site key; partial/foreign-host config fails closed', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const config = await s.request('/api/orders/verification')
  assert.equal(config.status, 200)
  assert.deepEqual(await config.json(), { enabled: true, purpose: 'order_create', siteKey: 'fixture-public-key' })
  assert.equal(config.headers.get('Set-Cookie'), null)
  assert.deepEqual(await (await s.request('/api/orders/verification?purpose=auth')).json(), { enabled: false, purpose: 'auth' })
  for (const patch of [{ TURNSTILE_SECRET_KEY: '' }, { TURNSTILE_SITE_KEY: '' }, { TURNSTILE_HOSTNAMES: '' }, { TURNSTILE_HOSTNAMES: 'evil.example.invalid' }]) {
    const original = { ...s.env }; Object.assign(s.env, patch)
    assert.equal((await s.request('/api/orders/verification')).status, 503)
    assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 503)
    Object.assign(s.env, original)
  }
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 0)
})

test('new orders reject missing, malformed and failed challenges before any write', async t => {
  const s = await setup(); t.after(() => s.db.close())
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) })
  for (const token of [undefined, null, false, 123, '', ' ', 'x'.repeat(2049)]) {
    assert.equal((await s.request('/api/orders', { ...s.order(), turnstileToken: token }, s.buyer)).status, 400)
  }
  assert.equal(calls, 0)
  assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 400)
  assert.equal(calls, 1)
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT count(*) n FROM order_events').get()!.n, 0)
})

test('siteverify binds hostname/action/age, and transport errors never bypass validation', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const results = [
    { ...valid(), success: 'true' }, { ...valid(), hostname: 'evil.example.invalid' }, { ...valid(), action: 'customer_send' },
    { ...valid(), challenge_ts: new Date(Date.now() - 301000).toISOString() }, { ...valid(), challenge_ts: new Date(Date.now() + 61000).toISOString() },
    { ...valid(), challenge_ts: 'invalid' }, { ...valid(), challenge_ts: null },
  ]
  let response: Response
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), endpoint)
    assert.equal(init!.redirect, 'manual')
    const data = JSON.parse(String(init!.body))
    assert.equal(data.secret, 'fixture-private-key'); assert.equal(data.response, 'valid-challenge')
    return response
  })
  for (const result of results) {
    response = Response.json(result)
    assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 400)
  }
  for (const bad of [new Response(null, { status: 307, headers: { Location: 'https://untrusted.example.invalid' } }), new Response('unavailable', { status: 503 }), new Response('not JSON'), new Response('null'), new Response('x'.repeat(16385))]) {
    response = bad
    assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 503)
  }
  for (const code of ['invalid-input-secret', 'missing-input-secret', 'internal-error']) {
    response = Response.json({ success: false, 'error-codes': [code] })
    assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 503)
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network timeout') })
  assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 503)
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 0)
})

test('verification forwards the edge IP, and concurrent reuse creates at most one order', async t => {
  const s = await setup(); t.after(() => s.db.close())
  let consumed = false
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const data = JSON.parse(String(init!.body))
    assert.equal(data.remoteip, '192.0.2.10')
    const success = !consumed; consumed = true
    return Response.json({ ...valid(), success })
  })
  const { default: worker } = await import('../worker/index.ts')
  const submit = () => worker.fetch(new Request('https://shop.example.invalid/api/orders', {
    method: 'POST', headers: { Cookie: s.buyer, Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' }, body: JSON.stringify(s.order()),
  }), s.env)
  assert.deepEqual((await Promise.all([submit(), submit()])).map(r => r.status).sort(), [201, 400])
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 1)
})

test('one-use challenges protect both storefronts while owner idempotency survives consumed tokens', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const partner = await s.agent('independent-shop')
  const slug = String(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(partner.id)!.slug)
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,price_cents,cost_cents) VALUES(?,?,?,?)').run(partner.id, 'plus', 15000, 10000)
  const used = new Set<string>(); let calls = 0
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    calls++; const token = JSON.parse(String(init!.body)).response
    if (used.has(token)) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    used.add(token); return Response.json(valid())
  })
  const data = s.order()
  const created = await s.request('/api/orders', data, s.buyer)
  assert.equal(created.status, 201, await created.clone().text())
  const retry = await s.request('/api/orders', { ...data, turnstileToken: undefined }, s.buyer)
  assert.equal(retry.status, 200)
  assert.equal(calls, 1)
  assert.equal((await retry.json()).order.id, (await created.json()).order.id)
  assert.equal((await s.request('/api/orders', s.order(), s.buyer)).status, 400)
  assert.equal((await s.request('/api/orders', { ...s.order(), partner: slug, expectedPrice: 15000, turnstileToken: undefined }, s.buyer)).status, 400)
  assert.equal((await s.request('/api/orders', { ...s.order(), partner: slug, expectedPrice: 15000, turnstileToken: 'partner-challenge' }, s.buyer)).status, 201)
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 2)
})

test('custom inventory cannot bypass the shared challenge gate; disabled local mode stays compatible', async t => {
  const s = await setup(); t.after(() => s.db.close())
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }))
  assert.equal((await s.request('/api/orders', { ...s.order(), plan: 'custom-test', turnstileToken: undefined }, s.buyer)).status, 400)
  assert.equal(s.db.prepare('SELECT count(*) n FROM orders').get()!.n, 0)
  s.env.TURNSTILE_ENABLED = 'false'
  assert.deepEqual(await (await s.request('/api/orders/verification')).json(), { enabled: false, purpose: 'order_create' })
  assert.equal((await s.request('/api/orders', { ...s.order(), turnstileToken: undefined }, s.buyer)).status, 201)
})
