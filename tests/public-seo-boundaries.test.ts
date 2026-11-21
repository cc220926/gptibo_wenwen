import test from 'node:test'
import assert from 'node:assert/strict'
import original from '../worker/index.ts'
import { withPublicStorefront } from '../worker/storefront-entry.ts'
import { readOnlyDatabase, seoOrigin } from '../worker/public-seo.ts'
import { publicProducts, publicPageMetadata, type PublicOffer } from '../shared/public-storefront.ts'
import type { Env } from '../worker/platform.ts'

const offer = (input: Partial<PublicOffer> = {}): PublicOffer => ({ id: 'plus', product_id: 'chatgpt', name: 'Plus', price_cents: 13800, enabled: 1, ...input })

test('API forwarding preserves the exact request, environment, response and original scheduled handler', async () => {
  const env = new Proxy({}, { get() { throw new Error('SEO must not inspect API bindings') } }) as Env
  let expected: Request
  const response = new Response('untouched', { status: 202, headers: { 'Set-Cookie': 'original=1', 'X-Test': 'original' } })
  const entry = withPublicStorefront({ ...original, fetch: async (request, passedEnv) => {
    assert.equal(request, expected); assert.equal(passedEnv, env)
    assert.equal(request.bodyUsed, false)
    return response
  } })
  assert.equal(entry.scheduled, original.scheduled)
  for (const path of ['/api/orders', '/api/payments/notify/alipay', '/api/recharge/webhook', '/api/muse/webhook', '/api/invoices/notify/alipay', '/api/admin/login', '/api/catalog?partner=ABCDEF']) {
    for (const method of ['GET', 'POST', 'PUT', 'HEAD']) {
      expected = new Request('https://shop.example.invalid' + path, { method, headers: { Cookie: 'original-buyer=1', Origin: 'https://shop.example.invalid', 'X-Storefront-Shop': 'ABCDEF' }, ...(method === 'POST' || method === 'PUT' ? { body: 'signed=callback&value=1' } : {}) })
      assert.equal(await entry.fetch(expected, env), response)
    }
  }
})

test('readonly catalog adapter refuses writes, batches, PRAGMAs and multi-statements', async () => {
  let calls = 0, writes = 0
  const db = readOnlyDatabase({ prepare() { calls++; return { bind() { return this }, first: async <T>() => ({ value: 1 } as T), all: async <T>() => ({ results: [{ value: 1 } as T] }), run: async () => { writes++; return { changes: 1 } } } }, batch: async () => { writes++; return [] } })
  for (const sql of ['UPDATE orders SET status=1', 'DELETE FROM orders', 'INSERT INTO orders VALUES(1)', 'PRAGMA user_version=1', 'SELECT 1; DELETE FROM orders', 'WITH t AS (SELECT 1) DELETE FROM orders']) assert.throws(() => db.prepare(sql))
  assert.equal(calls, 0)
  await assert.rejects(db.batch([]))
  await assert.rejects(db.prepare('SELECT ?').bind(1).run())
  assert.deepEqual(await db.prepare('SELECT ?').bind(1).first(), { value: 1 })
  assert.equal(writes, 0, 'No underlying write or batch may be invoked')
})

test('SEO origin is explicit and never inferred from an inbound Host or forwarding header', () => {
  for (const value of ['', undefined, 'http://shop.example.invalid', 'https://user:pass@shop.example.invalid', 'https://shop.example.invalid/path', 'https://shop.example.invalid?partner=x', 'https://shop.example.invalid/#secret', 'not a URL']) assert.equal(seoOrigin(value), null)
  assert.equal(seoOrigin('https://shop.example.invalid/'), 'https://shop.example.invalid')
  assert.equal(seoOrigin('http://127.0.0.1:8788'), 'http://127.0.0.1:8788')
})

test('public model matches SMS replacement, service aliases, visibility, removal and configured prices', () => {
  const legacy = offer({ id: 'codex-sms-once', product_id: 'codex-sms', price_cents: 1000, enabled: 0 })
  const sms = offer({ id: 'custom-sms', product_id: 'custom-sms-product', product_name: 'SMS', supply_kind: 'codex-sms', delivery_type: 'stock', price_cents: 800 })
  const account = offer({ id: 'custom-account', product_id: 'custom-gpt', product_name: 'ChatGPT Plus 成品账号', delivery_type: 'stock', price_cents: 8500 })
  const products = publicProducts({ plans: [offer(), legacy, sms, account, offer({ id: 'gone', product_id: 'custom-gone', delisted: 1, delivery_type: 'stock' })] })
  assert.deepEqual(products.map(p => p.path), ['/product/chatgpt', '/product/codex-sms', '/product/gpt-plus'])
  assert.deepEqual(products[1].offers.map(o => o.price_cents), [800])
  assert.equal(publicProducts({ plans: [offer(), sms], hiddenProductIds: ['chatgpt', 'codex-sms'] }).length, 0)
  assert.equal(publicProducts({ plans: [] }).length, 0)
  assert.equal(publicProducts({ plans: [offer({ price_cents: NaN }), offer({ price_cents: -1 }), offer({ product_id: '../orders' })] }).length, 0)
})

test('metadata is page specific; orders, hidden products and unknown routes cannot inherit public canonical', () => {
  const catalog = { plans: [offer()], platformBranding: { name: '测试店', pageTitle: '', headline: '', description: '' } }
  assert.deepEqual(publicPageMetadata('store', catalog, '首页标题', '首页说明'), { title: '首页标题', description: '首页说明', path: '/' })
  assert.equal(publicPageMetadata('product/chatgpt', catalog, '', '')?.title, 'ChatGPT · 测试店')
  for (const page of ['orders', 'product/missing', 'admin', 'partner']) assert.equal(publicPageMetadata(page, catalog, '', ''), null)
  assert.equal(publicPageMetadata('product/chatgpt', { ...catalog, hiddenProductIds: ['chatgpt'] }, '', ''), null)
})

test('SEO cache maintenance failure cannot alter a successful pricing settings response',async()=>{
 let forwarded=0,lookups=0
 const response=new Response('original admin result',{status:200,headers:{'X-Original':'yes'}})
 const env=new Proxy({}, {get(){lookups++;throw new Error('cache binding unavailable')}}) as Env
 const entry=withPublicStorefront({...original,fetch:async()=>{forwarded++;return response}})
 const request=new Request('https://shop.example.invalid/api/admin/plans/plus',{method:'POST',body:'original signed body'})
 const actual=await entry.fetch(request,env)
 assert.equal(actual,response);assert.equal(forwarded,1);assert.equal(lookups,1);assert.equal(request.bodyUsed,false)
})
