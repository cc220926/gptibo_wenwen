import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFixture } from './customer-fixture.ts'

const endpoint = '/api/admin/product-visibility'
const hidden = ['gmail', 'x-premium', 'duolingo', 'gemini']

test('only an authenticated administrator can save a valid platform delisting', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  assert.deepEqual(await (await s.request(endpoint, undefined, s.admin)).json(), { hiddenProductIds: [], version: 0 })
  const payload = { hiddenProductIds: hidden, version: 0, note: '暂停四项商品销售' }
  assert.equal((await s.request(endpoint)).status, 401)
  assert.equal((await s.request(endpoint, payload)).status, 401)
  assert.equal((await s.request(endpoint, payload, s.admin, 'https://other.example.invalid')).status, 403)
  for (const value of [null, 'gmail', ['gmail', 'gmail'], ['unknown'], [1]]) {
    assert.equal((await s.request(endpoint, { ...payload, hiddenProductIds: value }, s.admin)).status, 400)
  }
  for (const version of [null, -1, 0.5, '0']) assert.equal((await s.request(endpoint, { ...payload, version }, s.admin)).status, 400)
  assert.equal((await s.request(endpoint, { ...payload, note: '' }, s.admin)).status, 400)
  assert.equal((await s.request(endpoint, { ...payload, note: 'x'.repeat(501) }, s.admin)).status, 400)
  assert.deepEqual(await (await s.request(endpoint, undefined, s.admin)).json(), { hiddenProductIds: [], version: 0 })
  const saved = await s.request(endpoint, payload, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.deepEqual(await saved.json(), { hiddenProductIds: hidden, version: 1 })
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='platform-product-visibility' AND target_id='platform'").get()!.n, 1)
  assert.equal((await s.request(endpoint, payload, s.admin)).status, 409)
})

test('platform delisting hides product cards and plans in the platform and partner shops', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const partner = await s.agent('independent-shop')
  const slug = String(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(partner.id)!.slug)
  const saved = await s.request(endpoint, { hiddenProductIds: hidden, version: 0, note: '下架四个商品' }, s.admin)
  assert.equal(saved.status, 200)
  const platform = await (await s.request('/api/catalog')).json()
  assert.deepEqual(platform.hiddenProductIds, hidden)
  assert.equal(platform.plans.some((plan: { product_id: string }) => hidden.includes(plan.product_id)), false)
  assert.equal(platform.plans.some((plan: { product_id: string }) => plan.product_id === 'chatgpt'), true)
  const partnerCatalog = await (await s.request('/api/catalog?partner=' + slug)).json()
  assert.deepEqual(partnerCatalog.hiddenProductIds, hidden)
  assert.equal((await s.request(endpoint, { hiddenProductIds: [], version: 1, note: '重新上架' }, s.admin)).status, 200)
  const restored = await (await s.request('/api/catalog')).json()
  assert.deepEqual(restored.hiddenProductIds, [])
  assert.equal(restored.plans.some((plan: { product_id: string }) => plan.product_id === 'gmail'), true)
})

test('a delisted product rejects new orders, while existing orders remain accessible', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const payload = { plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID(), email: 'buyer@example.test' }
  const created = await s.request('/api/orders', payload, buyer)
  assert.equal(created.status, 201, await created.clone().text())
  const order = (await created.json()).order
  assert.equal((await s.request(endpoint, { hiddenProductIds: ['chatgpt'], version: 0, note: '暂停 ChatGPT' }, s.admin)).status, 200)
  assert.equal((await s.request('/api/orders', { ...payload, key: crypto.randomUUID() }, buyer)).status, 409)
  assert.equal((await s.request('/api/orders/' + order.id, undefined, buyer)).status, 200)
  assert.equal((await s.request('/api/orders', payload, buyer)).status, 200)
  assert.equal((await s.request(endpoint, { hiddenProductIds: [], version: 1, note: '重新上架 ChatGPT' }, s.admin)).status, 200)
  assert.equal((await s.request('/api/orders', { ...payload, key: crypto.randomUUID() }, buyer)).status, 201)
})

test('an order insert rechecks delisting after preflight, and competing admins cannot overwrite each other', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const saves = await Promise.all([
    s.request(endpoint, { hiddenProductIds: ['gmail'], version: 0, note: '暂停 Gmail' }, s.admin),
    s.request(endpoint, { hiddenProductIds: ['gemini'], version: 0, note: '暂停 Gemini' }, s.admin),
  ])
  assert.deepEqual(saves.map(response => response.status).sort(), [200, 409])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='platform-product-visibility'").get()!.n, 1)
  assert.equal((await s.request(endpoint, { hiddenProductIds: [], version: 1, note: '重置' }, s.admin)).status, 200)
  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const batch = s.env.INTEREST_DB.batch
  s.env.INTEREST_DB.batch = async statements => {
    s.db.prepare('UPDATE platform_product_visibility SET hidden_product_ids=?,version=version+1 WHERE id=1').run('["chatgpt"]')
    return batch(statements)
  }
  const response = await s.request('/api/orders', { plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID(), email: 'buyer@example.test' }, buyer)
  assert.equal(response.status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('partner visibility inherits platform hidden cards, rejects new orders and preserves existing orders', async t => {
  const s = await customerFixture(); t.after(() => s.db.close()); const p = await s.agent('reseller')
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,price_cents,cost_cents) SELECT ?,id,price_cents,100 FROM catalog_plans').run(p.id)
  const slug = s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const payload = { partner: slug, plan: 'plus', expectedPrice: 13900, email: 'buyer@example.test', key: crypto.randomUUID() }
  const created = await s.request('/api/orders', payload, buyer); assert.equal(created.status, 201)
  const order = (await created.json()).order
  const before = s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)
  assert.equal((await s.request(endpoint, { hiddenProductIds: ['chatgpt', 'claude', 'grok'], version: 0, note: '全站下架' }, s.admin)).status, 200)
  const catalog = await (await s.request('/api/catalog?partner='+slug)).json()
  assert.ok(['chatgpt', 'claude', 'grok'].every(id => catalog.hiddenProductIds.includes(id)))
  assert.equal(catalog.plans.some((r: { product_id: string }) => r.product_id==='chatgpt'), false)
  const settings = await (await s.request('/api/partner/product-order', undefined, p.cookie)).json()
  assert.deepEqual(settings.platformHiddenProductIds, ['chatgpt', 'claude', 'grok'])
  const dashboard = await (await s.request('/api/partner/dashboard', undefined, p.cookie)).json()
  assert.equal(dashboard.plans.some((r: { product_id: string }) => r.product_id==='chatgpt'), false)
  assert.equal((await s.request('/api/orders', { ...payload, key: crypto.randomUUID() }, buyer)).status, 409)
  assert.equal((await s.request('/api/orders', payload, buyer)).status, 200)
  assert.equal((await s.request('/api/orders/'+order.id, undefined, buyer)).status, 200)
  assert.deepEqual(s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id), before)
})

test('partner visibility rechecks platform delisting in order transaction and cannot be bypassed by shop relisting', async t => {
  const s = await customerFixture(); t.after(() => s.db.close()); const p = await s.agent('reseller')
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,price_cents,cost_cents) SELECT ?,id,price_cents,100 FROM catalog_plans').run(p.id)
  const slug = s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const batch = s.env.INTEREST_DB.batch
  s.env.INTEREST_DB.batch = async statements => {
    s.db.prepare('UPDATE platform_product_visibility SET hidden_product_ids=?,version=version+1 WHERE id=1').run('["chatgpt","claude","grok"]')
    return batch(statements)
  }
  const payload = { partner: slug, plan: 'plus', expectedPrice: 13900, email: 'buyer@example.test', key: crypto.randomUUID() }
  assert.equal((await s.request('/api/orders', payload, buyer)).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  s.env.INTEREST_DB.batch = batch
  const settings = await (await s.request('/api/partner/product-order', undefined, p.cookie)).json()
  assert.equal((await s.request('/api/partner/product-order', { productIds: settings.productIds, hiddenProductIds: [], version: settings.version }, p.cookie)).status, 200)
  assert.ok((await (await s.request('/api/catalog?partner='+slug)).json()).hiddenProductIds.includes('chatgpt'))
  assert.equal((await s.request('/api/orders', payload, buyer)).status, 409)
})

test('platform relisting preserves independent shop delisting and sorting', async t => {
  const s = await customerFixture(); t.after(() => s.db.close()); const p = await s.agent('reseller')
  const slug = s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  const settings = await (await s.request('/api/partner/product-order', undefined, p.cookie)).json()
  const order = [...settings.productIds].reverse()
  assert.equal((await s.request('/api/partner/product-order', { productIds: order, hiddenProductIds: ['chatgpt'], version: 0 }, p.cookie)).status, 200)
  assert.equal((await s.request(endpoint, { hiddenProductIds: ['claude','grok'], version: 0, note: '总站隐藏预告商品' }, s.admin)).status, 200)
  const combined = await (await s.request('/api/catalog?partner='+slug)).json()
  assert.deepEqual(new Set(combined.hiddenProductIds), new Set(['claude','grok','chatgpt']))
  assert.deepEqual(combined.productOrder, order)
  assert.equal((await s.request(endpoint, { hiddenProductIds: [], version: 1, note: '总站重新展示' }, s.admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog?partner='+slug)).json()).hiddenProductIds, ['chatgpt'])
})
