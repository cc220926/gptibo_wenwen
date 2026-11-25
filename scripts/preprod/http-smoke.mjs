import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const [origin, variant, mode] = process.argv.slice(2)
assert.ok(mode === undefined || mode === '--functional-only', 'Unknown smoke-test mode')
assert.ok(['baseline', 'candidate'].includes(variant), 'Expected baseline or candidate')
const url = new URL(origin)
assert.ok(url.protocol === 'https:' && /^gptibo-seo-rehearsal-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname), 'Only isolated rehearsal hostnames are allowed')
assert.equal(url.origin, origin)
const checks = [], times = {}
async function get(path, init) {
  const start = performance.now()
  assert.ok(path.startsWith('/') && !path.startsWith('//') && new URL(path, origin).origin === origin, 'Requests must remain on the isolated host')
  const response = await fetch(origin + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) })
  assert.ok(response.status < 300 || response.status >= 400, 'Do not follow redirects out of the rehearsal')
  assert.equal(new URL(response.url).origin, origin)
  const text = await response.text()
  return { response, text, ms: Math.round(performance.now() - start) }
}
const home = await get('/')
assert.equal(home.response.status, 200)
assert.match(home.response.headers.get('content-type'), /text\/html/)
if (variant === 'candidate') {
  assert.match(home.text, /data-public-seo="true"/)
  assert.match(home.text, /rel="canonical"/)
} else assert.doesNotMatch(home.text, /data-public-seo/)
checks.push('homepage-artifact')
const script = home.text.match(/<script[^>]+src="([^"]+)"/)?.[1]
assert.ok(script)
const asset = await get(script)
assert.equal(asset.response.status, 200)
assert.match(asset.response.headers.get('content-type'), /javascript/)
checks.push('entry-script-mime')
const ordersPage = await get('/orders')
assert.equal(ordersPage.response.status, 200)
assert.match(ordersPage.text, /noindex/)
const client = await get('/api/orders/client', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
assert.equal(client.response.status, 200)
const cookie = client.response.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie)
const orders = await get('/api/orders', { headers: { Cookie: cookie } })
assert.equal(orders.response.status, 200)
assert.ok(Array.isArray(JSON.parse(orders.text).orders))
checks.push('buyer-cookie-and-order-query')
const catalog = await get('/api/catalog')
assert.equal(catalog.response.status, 200)
assert.equal(JSON.parse(catalog.text).testingEnabled, false)
checks.push('live-mode-catalog')
const verification = await get('/api/orders/verification')
// The remote rehearsal intentionally has no provider secret, so the unchanged
// checkout verification must fail closed instead of silently bypassing CAPTCHA.
assert.equal(verification.response.status, 503)
checks.push('turnstile-missing-secret-fails-closed')
if (variant === 'candidate') {
  const help = await get('/help/order-recovery'), sitemap = await get('/sitemap.xml')
  assert.equal(help.response.status, 200)
  assert.match(help.text, /data-public-document/)
  assert.equal(sitemap.response.status, 200)
  assert.match(sitemap.response.headers.get('content-type'), /application\/xml/)
  const missing = await get('/product/does-not-exist')
  assert.equal(missing.response.status, 404)
  checks.push('help-sitemap-missing-product')
}
// Fixed, small staged workload. This is a comparative smoke test, not a
// production capacity guarantee or a stress test of shared provider services.
for (const [name, path, count] of mode === '--functional-only' ? [] : [['html', '/', 20], ['asset', script, 20], ['buyerApi', '/api/catalog', 10]]) {
  const samples = []
  for (let start = 0; start < count; start += 5) {
    const batch = await Promise.all(Array.from({ length: Math.min(5, count - start) }, () => get(path)))
    for (const value of batch) { assert.equal(value.response.status, 200); samples.push(value.ms) }
  }
  samples.sort((a, b) => a - b)
  times[name] = { count, concurrency: 5, p50Ms: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))], maxMs: samples.at(-1), failures: 0 }
}
console.log(JSON.stringify({ origin, variant, checks, times, workloadRun: mode !== '--functional-only', realProviderCallsTested: false, productionCapacityClaimed: false }, null, 2))
