import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerFixture } from './customer-fixture.ts'

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const worker = (await import('../' + config.main)).default
const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const origin = 'https://shop.example.invalid'

for (const path of ['/', '/product/chatgpt']) {
  test(`first paint at ${path} has a recoverable loading view, never a second product table`, async t => {
    const s = await customerFixture(); t.after(() => s.db.close())
    const env = { ...s.env, STOREFRONT_SEO_ORIGIN: origin, SEO_CATALOG_LIMITER: { limit: async () => ({ success: true }) },
      ASSETS: { fetch: async () => new Response(template, { headers: { 'Content-Type': 'text/html' } }) } }
    const roots: string[] = []
    for (const agent of ['Mozilla/5.0', 'Googlebot', 'OAI-SearchBot']) {
      const response = await worker.fetch(new Request(origin + path, { headers: { 'User-Agent': agent } }), env)
      assert.equal(response.status, 200)
      const html = await response.text()
      const root = html.match(/<div id="root">([\s\S]*)<\/div>\s*<script/)?.[1]
      assert.ok(root, 'The initial HTML must retain the real application mount point')
      assert.doesNotMatch(root, /<table\b|public-seo-fallback|<th\b|¥|>可选购<|>暂停售卖</, 'A visible product table before the application loads is a regression')
      assert.match(root, /data-storefront-startup/)
      assert.match(root, /role="status"/)
      assert.match(root, /href=""[^>]*>重新加载<\/a>/, 'Reload works even when the application script fails')
      assert.match(root, /href="\/help\/"/)
      assert.match(root, /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/)
      assert.doesNotMatch(root, /<script\b|on(?:click|load|error)=|style="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i)
      assert.match(html, /rel="canonical"/)
      assert.match(html, /<script type="module" src="\/src\/main.tsx"/)
      roots.push(root)
    }
    assert.equal(new Set(roots).size, 1, 'People and crawlers must receive the same loading view')
  })
}
