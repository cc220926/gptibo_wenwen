import test from 'node:test'
import assert from 'node:assert/strict'
import { pushIndexing, sitemapUrls } from '../scripts/seo/push-indexing.mjs'

const origin = 'https://shop.example.invalid'
const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const sitemap = `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/help/a?x=1&amp;y=2</loc></url><url><loc>https://other.example/</loc></url><url><loc>${origin}/pricing</loc></url></urlset>`
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const route = Object.keys(routes).find(prefix => url.startsWith(prefix))
    if (!route) throw new Error('Unexpected network call: ' + url)
    return routes[route](init)
  }
  return { fetch, calls }
}
const quiet = () => {}

test('sitemap parsing keeps unique same-host https URLs', () => {
  assert.deepEqual(sitemapUrls(sitemap, origin), [`${origin}/`, `${origin}/pricing`, `${origin}/help/a?x=1&y=2`])
})

test('IndexNow submission verifies the served key and posts the sitemap URLs', async () => {
  const { fetch, calls } = mockFetch({
    [origin + '/sitemap.xml']: () => new Response(sitemap),
    [`${origin}/${key}.txt`]: () => new Response(key + '\n'),
    'https://api.indexnow.org/indexnow': () => new Response(null, { status: 202 }),
  })
  const logs: string[] = []
  const result = await pushIndexing({ origin, indexNowKey: key, fetch, log: (line: string) => logs.push(line) })
  assert.equal(result.results.indexNow, 202)
  const post = calls.find(call => call.url === 'https://api.indexnow.org/indexnow')!
  assert.deepEqual(JSON.parse(post.init!.body as string), { host: 'shop.example.invalid', key, keyLocation: `${origin}/${key}.txt`, urlList: result.urls })
  assert.ok(!logs.join('\n').includes(key), 'The key is never logged')
})

test('submission stops before contacting IndexNow when the key file is missing or different', async () => {
  for (const keyFile of [() => new Response('nope', { status: 404 }), () => new Response('different-key-123')]) {
    const { fetch, calls } = mockFetch({ [origin + '/sitemap.xml']: () => new Response(sitemap), [`${origin}/${key}.txt`]: keyFile })
    await assert.rejects(pushIndexing({ origin, indexNowKey: key, fetch, log: quiet }), /key file is not served/)
    assert.ok(!calls.some(call => call.url.includes('indexnow.org')))
  }
})

test('dry run and invalid input submit nothing', async () => {
  const { fetch, calls } = mockFetch({ [origin + '/sitemap.xml']: () => new Response(sitemap), [`${origin}/${key}.txt`]: () => new Response(key) })
  const result = await pushIndexing({ origin, indexNowKey: key, baiduToken: 'tok', dryRun: true, fetch, log: quiet })
  assert.deepEqual(result.results, { indexNow: 'dry-run', baidu: 'dry-run' })
  assert.ok(!calls.some(call => /indexnow\.org|baidu\.com/.test(call.url)))
  await assert.rejects(pushIndexing({ origin, fetch, log: quiet }), /INDEXNOW_KEY/)
  await assert.rejects(pushIndexing({ origin, indexNowKey: 'short', fetch, log: quiet }), /8-128/)
  await assert.rejects(pushIndexing({ origin: 'http://shop.example.invalid', indexNowKey: key, fetch, log: quiet }), /https/)
  const empty = mockFetch({ [origin + '/sitemap.xml']: () => new Response('<urlset></urlset>') })
  await assert.rejects(pushIndexing({ origin, indexNowKey: key, fetch: empty.fetch, log: quiet }), /no URLs/)
  const down = mockFetch({ [origin + '/sitemap.xml']: () => new Response('x', { status: 503 }) })
  await assert.rejects(pushIndexing({ origin, indexNowKey: key, fetch: down.fetch, log: quiet }), /503/)
})

test('Baidu push sends newline-separated URLs and surfaces quota errors', async () => {
  const { fetch, calls } = mockFetch({
    [origin + '/sitemap.xml']: () => new Response(sitemap),
    'http://data.zz.baidu.com/urls': () => Response.json({ success: 3, remain: 97 }),
  })
  const logs: string[] = []
  await pushIndexing({ origin, baiduToken: 'secret-token', fetch, log: (line: string) => logs.push(line) })
  const post = calls.find(call => call.url.startsWith('http://data.zz.baidu.com/urls'))!
  assert.equal(new URL(post.url).searchParams.get('site'), origin)
  assert.equal(post.init!.body, sitemapUrls(sitemap, origin).join('\n'))
  assert.ok(logs.some(line => /3 accepted, 97 remaining/.test(line)))
  assert.ok(!logs.join('\n').includes('secret-token'))
  const over = mockFetch({ [origin + '/sitemap.xml']: () => new Response(sitemap), 'http://data.zz.baidu.com/urls': () => Response.json({ error: 400, message: 'over quota' }, { status: 400 }) })
  await assert.rejects(pushIndexing({ origin, baiduToken: 'secret-token', fetch: over.fetch, log: quiet }), /over quota/)
})
