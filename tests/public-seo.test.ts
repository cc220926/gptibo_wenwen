import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerFixture } from './customer-fixture.ts'
import type { Env } from '../worker/platform.ts'
import { publicArticles } from '../shared/public-help.ts'

// Resolve the configured production entry rather than testing an unused helper.
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const worker = (await import('../' + config.main)).default
const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const origin = 'https://shop.example.invalid'
async function fixture() {
  const s = await customerFixture()
  const env = { ...s.env, STOREFRONT_SEO_ORIGIN: origin, SEO_CATALOG_LIMITER: { limit: async () => ({ success: true }) } }
  env.ASSETS = { fetch: async () => new Response(template, { headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex, nofollow' } }) }
  return { ...s, env, get: (path: string, method = 'GET') => worker.fetch(new Request(origin + path, { method }), env) }
}

function bootstrap(html: string) {
  const json = html.match(/<script id="storefront-public-catalog" type="application\/json">([^]*?)<\/script>/)?.[1]
  assert.ok(json, 'Fresh public catalog must be available to the real application')
  return JSON.parse(json).catalog
}

test('configured public homepage keeps metadata and supplies fresh prices to the real storefront', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.db.prepare("UPDATE platform_branding SET name='测试充电站',page_title='测试充电站',headline='AI 服务',description='服务说明' WHERE id=1").run()
  s.db.prepare("UPDATE catalog_plans SET price_cents=12345 WHERE id='plus'").run()
  const response = await s.get('/')
  assert.equal(response.status, 200)
  assert.doesNotMatch(response.headers.get('X-Robots-Tag') ?? '', /noindex/)
  const html = await response.text()
  assert.match(html, /<title>测试充电站<\/title>/)
  const catalog = bootstrap(html)
  assert.equal(catalog.platformBranding.headline, 'AI 服务')
  assert.equal(catalog.plans.find((plan: { id: string }) => plan.id === 'plus').price_cents, 12345)
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
  assert.match(xml, /<loc>https:\/\/shop.example.invalid\/help\/session-expired<\/loc>/)
  assert.doesNotMatch(xml, /\/orders|\/admin|\/api\/|\/partner|\/r\/|\/s\//)
})

test('public content never changes any database row or creates buyer cookies', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => String(r.name))
  const snapshot = () => tables.map(name => [name, s.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])
  const before = snapshot()
  for (const path of ['/', '/product/chatgpt', '/help/', '/help/order-recovery', '/help/session-expired', '/help/completed-still-free', '/help/renewal-before-expiry', '/robots.txt', '/sitemap.xml']) {
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
  assert.match(html, /<link rel="stylesheet" href="\/help-article-v2\.css">/)
  assert.match(html, /<article class="help-article" aria-labelledby="help-article-title">/)
  assert.match(html, /<a class="help-article-primary" href="\/orders">查看或找回订单/)
  assert.doesNotMatch(html, /<script[^>]+src=|aggregateRating|ratingValue/)
})

test('related questions reuse help-center rows and only link to other articles in the category', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const html = await (await s.get('/help/recharge-or-account')).text()
  const related = html.match(/<section class="help-topic" aria-labelledby="related-help-title"[^>]*>([^]*?)<\/section>/)?.[1]
  assert.ok(related)
  assert.deepEqual([...related.matchAll(/<a href="([^"]+)">/g)].map(match => match[1]), ['/help/codex-credits', '/help/renewal-before-expiry'])
  assert.equal((related.match(/aria-hidden="true">›<\/span>/g) ?? []).length, 2)
})

test('every help article has category navigation, reading time and existing order support', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  for (const article of publicArticles) {
    const response = await s.get('/help/' + article.slug)
    assert.equal(response.status, 200, article.slug)
    const html = await response.text()
    assert.ok(html.includes('href="/help/#help-' + article.category + '"'), article.slug)
    assert.match(html, /约 \d+ 分钟读完/, article.slug)
    assert.match(html, /aria-label="浏览帮助分类"/, article.slug)
    assert.match(html, /<section[^>]*aria-labelledby="help-article-support-title"/, article.slug)
    assert.match(html, /href="\/orders">查看或找回订单/, article.slug)
    const sameCategory = publicArticles.filter(item => item.category === article.category)
    const position = sameCategory.indexOf(article)
    const previous = sameCategory[position - 1]
    const next = sameCategory[position + 1]
    assert.equal(html.includes('rel="prev"'), Boolean(previous), article.slug)
    assert.equal(html.includes('rel="next"'), Boolean(next), article.slug)
    if (previous) assert.ok(html.includes(`rel="prev" href="/help/${previous.slug}"`), article.slug)
    if (next) assert.ok(html.includes(`rel="next" href="/help/${next.slug}"`), article.slug)
    assert.doesNotMatch(html, /<script[^>]+src=|payforchat\.com/, article.slug)
  }
})

test('Session troubleshooting distinguishes an empty response from JSON boundaries', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const html = await (await s.get('/help/session-expired')).text()
  assert.match(html, /只显示 <code>\{\}<\/code>/)
  assert.match(html, /从开头的 <code>\{<\/code> 到结尾的 <code>\}<\/code>/)
})

test('help center renders category headings and direct article links before search script runs', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const response = await s.get('/help/')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<h1>帮助中心<\/h1>/)
  assert.match(html, /href="\/help-center-v2.css"/)
  assert.doesNotMatch(html, /help-article-v2\.css/)
  assert.match(html, /<form class="help-search" action="\/help\/" method="get" data-help-search role="search">/)
  assert.match(html, /id="help-activation">充值与到账/)
  assert.match(html, /href="\/help\/completed-still-free"/)
  assert.match(html, /id="help-account">账号与安全/)
  assert.match(html, /href="\/help\/save-session"/)
  assert.match(html, /href="\/help\/retry-original-order"/)
  assert.match(html, /<script src="\/help-search.js" defer><\/script>/)
  assert.doesNotMatch(html, /data-help-(?:article|group)[^>]*\bhidden\b/)
  assert.equal(response.headers.get('Set-Cookie'), null)
})

test('help search submits on the same site and filters results without JavaScript', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  const query = encodeURIComponent('显示 Free')
  const response = await s.get('/help/?q=' + query)
  const html = await response.text()
  assert.match(response.headers.get('Content-Security-Policy')!, /form-action 'self'/)
  assert.match(response.headers.get('X-Robots-Tag')!, /noindex/)
  assert.match(html, /rel="canonical" href="https:\/\/shop.example.invalid\/help\/"/)
  assert.match(html, /role="status">找到 1 个相关问题/)
  assert.match(html, /data-help-article data-search="充值与到账 订单已完成/)
  assert.match(html, /aria-labelledby="help-buying" hidden>/)
  const article = await s.get('/help/completed-still-free')
  assert.match(article.headers.get('Content-Security-Policy')!, /form-action 'none'/)
  assert.equal(response.headers.get('Set-Cookie'), null)
  const empty = await s.get('/help/?q=' + encodeURIComponent('“<b>未知</b>”'))
  const emptyHtml = await empty.text()
  assert.match(emptyHtml, /没找到相关问题/)
  assert.doesNotMatch(emptyHtml, /<b>未知<\/b>/)
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

test('current price and paused state reach bootstrap; visibility changes invalidate public routes and sitemap', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.db.prepare("UPDATE catalog_plans SET price_cents=33333,enabled=0 WHERE product_id='chatgpt'").run()
  const paused = await (await s.get('/product/chatgpt')).text()
  const plans = bootstrap(paused).plans.filter((plan: { product_id: string }) => plan.product_id === 'chatgpt')
  assert.ok(plans.length > 0)
  for (const plan of plans) { assert.equal(plan.price_cents, 33333); assert.equal(plan.enabled, 0) }
  // Use the actual public visibility API so the fixture follows real storage rules.
  const settings = await (await s.request('/api/admin/product-visibility', undefined, s.admin)).json()
  assert.ok(settings.hiddenProductIds)
  const saved = await worker.fetch(new Request(origin + '/api/admin/product-visibility', { method: 'POST', headers: { Origin: origin, Cookie: s.admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenProductIds: ['chatgpt'], version: settings.version, note: '本地 SEO 验收下架测试' }) }), s.env)
  assert.equal(saved.status, 200, await saved.clone().text())
  const coldGuide = await (await s.get('/help/recharge-or-account')).text()
  const productLink = coldGuide.match(/<a href="([^"]+)">查看商品与教程<\/a>/)?.[1]
  assert.ok(productLink)
  assert.ok(bootstrap(await (await s.get('/')).text()).hiddenProductIds.includes('chatgpt'))
  assert.equal((await s.get('/product/chatgpt')).status, 404)
  const sitemap = await (await s.get('/sitemap.xml')).text()
  assert.doesNotMatch(sitemap, /\/product\/chatgpt</)
  const hiddenProductJump = await s.get(productLink + '&next=https://external.example.invalid')
  assert.equal(hiddenProductJump.status, 302)
  assert.equal(hiddenProductJump.headers.get('Location'), '/')
  assert.equal(hiddenProductJump.headers.get('Cache-Control'), 'no-store')
  assert.equal((await s.get('/product/nonexistent?from=help')).status, 404)
  assert.doesNotMatch(await (await s.get('/help/recharge-or-account')).text(), /查看商品与教程/)
})

test('SEO errors do not prevent the legacy app and do not expose internal failures', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.INTEREST_DB = { prepare() { throw new Error('PRIVATE DATABASE DETAIL') }, batch() { throw new Error('write') } }
  const r = await s.get('/')
  assert.equal(r.status, 200); assert.match(r.headers.get('X-Robots-Tag')!, /noindex/)
  assert.equal(await r.text(), template.replace('<html', `<html data-public-help="true" data-public-origin="${origin}"`))
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

test('public help stays discoverable on the main shop when the catalog cannot render', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.SEO_CATALOG_LIMITER = { limit: async () => ({ success: false }) }
  for (const path of ['/', '/product/chatgpt']) {
    const response = await s.get(path)
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.match(html, /data-public-help="true" data-public-origin="https:\/\/shop.example.invalid"/)
    assert.match(response.headers.get('X-Robots-Tag')!, /noindex/)
    assert.doesNotMatch(html, /data-public-seo|rel="canonical"/)
  }
  const partner = await s.get('/r/ABC123')
  assert.doesNotMatch(await partner.text(), /data-public-help|data-public-seo/)
  const help = await s.get('/help/')
  assert.match(await help.text(), /<h1>帮助中心<\/h1>/)
})

test('discovery failures are retryable errors, never a successful HTML sitemap', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.INTEREST_DB = { prepare() { throw new Error('PRIVATE FAILURE') }, batch() { throw new Error('write') } }
  const r = await s.get('/sitemap.xml')
  assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '120')
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.doesNotMatch(await r.text(), /<html|PRIVATE FAILURE/)
})

test('public GETs never call external suppliers, payment services or mail providers', async t => {
  const s = await fixture(); t.after(() => s.db.close())
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('External network forbidden in SEO') })
  for (const path of ['/', '/product/chatgpt', '/help/', '/help/after-sales', '/sitemap.xml']) assert.equal((await s.get(path)).status, 200)
  assert.equal(calls, 0)
})

test('a stalled public catalog falls back within its deadline while buyer initialization still works', { timeout: 4500 }, async t => {
  const s = await fixture(); t.after(() => s.db.close())
  s.env.INTEREST_DB = {
    prepare() { return { bind() { return this }, first: async () => new Promise<never>(() => {}), all: async () => new Promise<never>(() => {}), run: async () => { throw new Error('write forbidden') } } },
    batch: async () => { throw new Error('batch forbidden') },
  }
  const pending = s.get('/')
  const client = await worker.fetch(new Request(origin + '/api/orders/client', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }), s.env)
  assert.equal(client.status, 200)
  assert.match(client.headers.get('Set-Cookie')!, /HttpOnly/)
  const response = await pending
  assert.equal(response.status, 200)
  assert.match(response.headers.get('X-Robots-Tag')!, /noindex/)
  assert.equal(await response.text(), template.replace('<html', `<html data-public-help="true" data-public-origin="${origin}"`))
})
