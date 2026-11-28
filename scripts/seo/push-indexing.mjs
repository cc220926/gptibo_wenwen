#!/usr/bin/env node
// Notify search engines after a release or price change.
//
//   INDEXNOW_KEY=... node scripts/seo/push-indexing.mjs --origin https://<main store> [--dry-run]
//   BAIDU_PUSH_TOKEN=... adds Baidu's ordinary-indexing push.
//
// Reads the live sitemap, verifies the IndexNow ownership file served by the
// Worker, then submits the same-origin URLs. Runs from an operator machine; the
// Worker never calls these services. Keys and tokens are never printed.
import { pathToFileURL } from 'node:url'

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls'
const mask = value => value.slice(0, 4) + '…' + `(${value.length})`

export function sitemapUrls(xml, origin) {
  const host = new URL(origin).host
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim()
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
  return [...new Set(urls)].filter(url => { try { const u = new URL(url); return u.protocol === 'https:' && u.host === host } catch { return false } })
}

export async function pushIndexing({ origin, indexNowKey, baiduToken, dryRun = false, fetch = globalThis.fetch, log = console.log }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search) throw new Error('--origin must be the https main-store root, the same value as STOREFRONT_SEO_ORIGIN')
  if (!indexNowKey && !baiduToken) throw new Error('Set INDEXNOW_KEY and/or BAIDU_PUSH_TOKEN')
  if (indexNowKey && !/^[A-Za-z0-9-]{8,128}$/.test(indexNowKey)) throw new Error('INDEXNOW_KEY must be 8-128 characters of a-z, A-Z, 0-9 or -')
  const site = base.origin
  const sitemap = await fetch(site + '/sitemap.xml')
  if (!sitemap.ok) throw new Error(`sitemap.xml returned ${sitemap.status}; retry later`)
  const urls = sitemapUrls(await sitemap.text(), site)
  if (!urls.length) throw new Error('sitemap.xml contains no URLs for ' + base.host)
  log(`sitemap: ${urls.length} URLs`)
  const results = {}
  if (indexNowKey) {
    const keyLocation = `${site}/${indexNowKey}.txt`
    const keyFile = await fetch(keyLocation)
    const served = keyFile.ok ? (await keyFile.text()).trim() : ''
    if (served !== indexNowKey) throw new Error(`IndexNow key file is not served (${keyFile.ok ? 'the URL returned other content' : 'HTTP ' + keyFile.status}); set the same INDEXNOW_KEY on the production Worker and deploy first`)
    log(`IndexNow key ${mask(indexNowKey)} verified at /${'*'.repeat(8)}.txt`)
    if (dryRun) results.indexNow = 'dry-run'
    else {
      const response = await fetch(INDEXNOW_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host: base.host, key: indexNowKey, keyLocation, urlList: urls }) })
      results.indexNow = response.status
      if (![200, 202].includes(response.status)) throw new Error(`IndexNow rejected the submission: HTTP ${response.status}`)
      log(`IndexNow: HTTP ${response.status} ${response.status === 202 ? '(accepted, key validation pending)' : '(received)'}`)
    }
  }
  if (baiduToken) {
    if (dryRun) results.baidu = 'dry-run'
    else {
      const response = await fetch(`${BAIDU_ENDPOINT}?site=${encodeURIComponent(site)}&token=${encodeURIComponent(baiduToken)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: urls.join('\n') })
      const body = await response.json().catch(() => ({}))
      results.baidu = response.status
      if (!response.ok || body.error) throw new Error(`Baidu push failed: HTTP ${response.status} ${body.message ?? ''}`.trim())
      log(`Baidu: ${body.success ?? 0} accepted, ${body.remain ?? '?'} remaining today${body.not_same_site?.length ? `, ${body.not_same_site.length} rejected as other site` : ''}`)
    }
  }
  if (dryRun) log('dry run: nothing was submitted')
  return { urls, results }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const origin = value('--origin')
  if (!origin) { console.error('push-indexing: --origin https://<main store> is required'); process.exit(1) }
  pushIndexing({ origin, indexNowKey: process.env.INDEXNOW_KEY, baiduToken: process.env.BAIDU_PUSH_TOKEN, dryRun: args.includes('--dry-run') })
    .catch(error => { console.error('push-indexing: ' + error.message); process.exitCode = 1 })
}
