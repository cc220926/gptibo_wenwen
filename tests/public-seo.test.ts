import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerFixture } from './customer-fixture.ts'
import type { Env } from '../worker/platform.ts'

// Resolve the configured production entry rather than testing an unused helper.
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const worker = (await import('../' + config.main)).default
const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const origin = 'https://shop.example.invalid'
async function fixture() {
  const s = await customerFixture()
  const env = { ...s.env, STOREFRONT_SEO_ORIGIN: origin }
  env.ASSETS = { fetch: async () => new Response(template, { headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex, nofollow' } }) }
  return { ...s, env, get: (path: string, method = 'GET') => worker.fetch(new Request(origin + path, { method }), env) }
}

test('configured public homepage is readable without JavaScript and uses live catalog prices', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.db.prepare("UPDATE platform_branding SET name='测试充电站',page_title='测试充电站',headline='AI 服务',description='服务说明' WHERE id=1").run()
  s.db.prepare("UPDATE catalog_plans SET price_cents=12345 WHERE id='plus'").run()
  const response = await s.get('/')
  assert.equal(response.status, 200)
  assert.doesNotMatch(response.headers.get('X-Robots-Tag') ?? '', /noindex/)
  const html = await response.text()
  assert.match(html, /<title>测试充电站<\/title>/)
  assert.match(html, /<h1[^>]*>AI 服务<\/h1>/)
  assert.match(html, /123\.45/)
  assert.match(html, /rel="canonical" href="https:\/\/shop.example.invalid\/"/)
  assert.match(html, /href="\/help\/"/)
  assert.doesNotMatch(html, /name="robots" content="noindex/)
})

test('robots and sitemap expose only explicitly public main-store URLs', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const robots = await s.get('/robots.txt')
  assert.match(robots.headers.get('Content-Type')!, /text\/plain/)
  assert.match(await robots.text(), /Sitemap: https:\/\/shop.example.invalid\/sitemap.xml/)
  const sitemap = await s.get('/sitemap.xml')
  assert.match(sitemap.headers.get('Content-Type')!, /application\/xml/)
  const xml = await sitemap.text()
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/)
  assert.match(xml, /<loc>https:\/\/shop.example.invalid\/help\/<\/loc>/)
  assert.doesNotMatch(xml, /\/orders|\/admin|\/api\/|\/partner|\/r\/|\/s\//)
})

test('public content never changes any database row or creates buyer cookies', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => String(r.name))
  const snapshot = () => tables.map(name => [name, s.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])
  const before = snapshot()
  for (const path of ['/', '/product/chatgpt', '/help/', '/help/order-recovery', '/robots.txt', '/sitemap.xml']) {
    const r = await s.get(path)
    assert.equal(r.status, 200, path)
    assert.equal(r.headers.get('Set-Cookie'), null)
  }
  assert.deepEqual(snapshot(), before)
})

test('unknown and hidden public content is a real noindex 404', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  for (const path of ['/product/nonexistent', '/help/nonexistent', '/not-a-real-page']) {
    const r = await s.get(path)
    assert.equal(r.status, 404, path)
    assert.match(r.headers.get('X-Robots-Tag')!, /noindex/)
  }
})

test('help pages provide standalone answers and no transactional scripts', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const r = await s.get('/help/order-recovery')
  const html = await r.text()
  assert.match(html, /<h1[^>]*>.*找回订单/)
  assert.match(html, /下单邮箱/)
  assert.doesNotMatch(html, /<script[^>]+src=|aggregateRating|ratingValue/)
})

test('disabled SEO and unrelated hosts preserve the original asset response', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  for (const env of [{ ...s.env, STOREFRONT_SEO_ORIGIN: undefined }, { ...s.env, STOREFRONT_SEO_ORIGIN: 'https://other.invalid' }]) {
    const r = await worker.fetch(new Request(origin + '/'), env as Env)
    assert.equal(await r.text(), template)
    assert.match(r.headers.get('X-Robots-Tag')!, /noindex/)
  }
})

test('canonical addresses normalize variants without forwarding tracking parameters into content', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  for (const [path, target] of [['/index.html?source=friend', '/?source=friend'], ['/help', '/help/'], ['/product/chatgpt/', '/product/chatgpt']]) {
    const r = await s.get(path)
    assert.equal(r.status, 308, path); assert.equal(r.headers.get('Location'), target)
  }
  const r = await s.get('/product/chatgpt?email=private@example.invalid&partner=foreign')
  const html = await r.text()
  assert.match(html, /rel="canonical" href="https:\/\/shop.example.invalid\/product\/chatgpt"/)
  assert.doesNotMatch(html, /private@example.invalid|partner=foreign/)
  const head = await s.get('/product/chatgpt', 'HEAD')
  assert.equal(head.status, 200); assert.equal(await head.text(), '')
})

test('current price, paused state, visibility and removal update in HTML and sitemap', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.db.prepare("UPDATE catalog_plans SET price_cents=33333,enabled=0 WHERE product_id='chatgpt'").run()
  const paused = await (await s.get('/product/chatgpt')).text()
  assert.match(paused, /333\.33/); assert.match(paused, /暂停售卖/)
  assert.doesNotMatch(paused, />可选购</)
  // Use the actual public visibility API so the fixture follows real storage rules.
  const settings = await (await s.request('/api/admin/product-visibility', undefined, s.admin)).json()
  assert.ok(settings.hiddenProductIds)
  const saved = await s.request('/api/admin/product-visibility', { hiddenProductIds: ['chatgpt'], version: settings.version, note: '本地 SEO 验收下架测试' }, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.equal((await s.get('/product/chatgpt')).status, 404)
  const sitemap = await (await s.get('/sitemap.xml')).text()
  assert.doesNotMatch(sitemap, /\/product\/chatgpt</)
  assert.doesNotMatch(await (await s.get('/')).text(), /href="\/product\/chatgpt"/)
})

test('SEO errors do not prevent the legacy app and do not expose internal failures', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.INTEREST_DB = { prepare() { throw new Error('PRIVATE DATABASE DETAIL') }, batch() { throw new Error('write') } }
  const r = await s.get('/')
  assert.equal(r.status, 200); assert.match(r.headers.get('X-Robots-Tag')!, /noindex/)
  assert.equal(await r.text(), template)
})

test('direct order shell remains private but can restore public metadata when navigating home', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const r = await s.get('/orders')
  assert.match(r.headers.get('X-Robots-Tag')!, /noindex/)
  const html = await r.text()
  assert.match(html, /data-public-seo="true"/)
  assert.match(html, /name="robots" content="noindex/)
  assert.doesNotMatch(html, /rel="canonical"|public-seo-fallback/)
})

test('discovery failures are retryable errors, never a successful HTML sitemap', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.INTEREST_DB = { prepare() { throw new Error('PRIVATE FAILURE') }, batch() { throw new Error('write') } }
  const r = await s.get('/sitemap.xml')
  assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '120')
  assert.doesNotMatch(await r.text(), /<html|PRIVATE FAILURE/)
})

test('public GETs never call external suppliers, payment services or mail providers', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('External network forbidden in SEO') })
  for (const path of ['/', '/product/chatgpt', '/help/', '/help/after-sales', '/sitemap.xml']) assert.equal((await s.get(path)).status, 200)
  assert.equal(calls, 0)
})
