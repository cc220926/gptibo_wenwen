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
