import { serializePublicBootstrap } from '../shared/public-bootstrap.ts'
import { commerce } from './commerce.ts'
import { secureResponse } from './security.ts'
import type { Database, Env, Statement } from './platform.ts'
import { publicProducts, type PublicCatalog } from '../shared/public-storefront.ts'
import { publicArticles, publicHelpCategories, publicHelpUpdated, type PublicArticle } from '../shared/public-help.ts'

export type SeoEnv = Env & { STOREFRONT_SEO_ORIGIN?: string; SEO_CATALOG_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> } }
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export function seoOrigin(value?: string) {
  if (!value) return null
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch { return null }
}
export function readOnlyDatabase(database: Database): Database {
  return {
    prepare(sql) {
      if (!/^\s*SELECT\b/i.test(sql) || sql.includes(';')) throw new Error('Public catalog accepts a single SELECT only')
      const statement = database.prepare(sql)
      const wrap = (source: Statement): Statement => ({
        bind: (...values) => wrap(source.bind(...values)),
        first: () => source.first(), all: () => source.all(),
        run: async () => { throw new Error('Public catalog cannot execute writes') },
      })
      return wrap(statement)
    },
    batch: async () => { throw new Error('Public catalog cannot execute batches') },
  }
}
const catalogTtlMs = 15000
const retryDelayMs = 5000
type CatalogSnapshot = { catalog: PublicCatalog; fetchedAt: number }
type CatalogState = { snapshot?: CatalogSnapshot; inFlight?: Promise<CatalogSnapshot>; retryAt: number; generation: number }
const catalogStates = new WeakMap<Database, Map<string, CatalogState>>()
function catalogState(env: SeoEnv, origin: string) {
  let origins = catalogStates.get(env.INTEREST_DB)
  if (!origins) { origins = new Map(); catalogStates.set(env.INTEREST_DB, origins) }
  let state = origins.get(origin)
  if (!state) { state = { retryAt: 0, generation: 0 }; origins.set(origin, state) }
  return state
}
function cachedCatalog(env: SeoEnv, origin: string) {
  const snapshot = catalogStates.get(env.INTEREST_DB)?.get(origin)?.snapshot
  return snapshot && Date.now() - snapshot.fetchedAt < catalogTtlMs ? snapshot.catalog : null
}
// Memory invalidation only; never changes the already completed admin response.
export function invalidatePublicCatalog(env: Env) {
  for (const state of catalogStates.get(env.INTEREST_DB)?.values() ?? []) {
    state.snapshot = undefined; state.retryAt = 0; state.generation++
  }
}
async function publicCatalog(env: SeoEnv, origin: string): Promise<{ catalog: PublicCatalog; fetchedAt: number; fresh: boolean }> {
  const state = catalogState(env, origin)
  if (state.snapshot && Date.now() - state.snapshot.fetchedAt < catalogTtlMs) return { ...state.snapshot, fresh: false }
  if (!state.inFlight) {
    if (Date.now() < state.retryAt || !env.SEO_CATALOG_LIMITER) throw new Error('Public catalog budget unavailable')
    const generation = state.generation
    // One key across paths, query strings and clients; separate from buyer API quota.
    const operation = (async () => {
      if (!(await env.SEO_CATALOG_LIMITER!.limit({ key: 'public-catalog:' + origin })).success) throw new Error('Public catalog budget exhausted')
      const response = await commerce(new Request(origin + '/api/catalog'), { ...env, INTEREST_DB: readOnlyDatabase(env.INTEREST_DB) })
      if (!response.ok) throw new Error('Public catalog unavailable')
      const catalog = await response.json() as PublicCatalog
      if (!Array.isArray(catalog.plans) || !catalog.platformBranding) throw new Error('Public catalog incomplete')
      const snapshot = { catalog, fetchedAt: Date.now() }
      if (generation === state.generation) state.snapshot = snapshot
      return snapshot
    })()
    state.inFlight = operation
    // A response deadline does not cancel D1: keep the same in-flight operation
    // until it really settles, so stalled readers cannot start another batch.
    void operation.then(() => { state.inFlight = undefined }, () => { state.inFlight = undefined; state.retryAt = Date.now() + retryDelayMs })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const snapshot = await Promise.race([
    state.inFlight,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Public catalog deadline')), 1500) }),
  ]).finally(() => clearTimeout(timer))
  return { ...snapshot, fresh: true }
}
const privatePath = (path: string) => /^\/(?:api|admin|orders|partner|join|r|s)(?:\/|$)/.test(path) || path.startsWith('/__preview/')
const assetPath = (path: string) => /^\/(?:assets|brands|fonts|images)\//.test(path) || /\.[a-z\d]{1,8}$/i.test(path)
// This is a loading view for everyone, not a second storefront or crawler-only
// product document. The unchanged React entry replaces it when it commits.
// Recovery links remain usable when the application bundle cannot execute.
const startupShell = (brand: string) => `<main class="storefront-startup" data-storefront-startup aria-labelledby="storefront-startup-title"><p class="storefront-startup-brand">${escape(brand)}</p><p id="storefront-startup-title" class="storefront-startup-title" role="status">正在加载页面…</p><div class="storefront-startup-skeleton" aria-hidden="true"><span></span><div><i></i><i></i><i></i><i></i></div></div><p class="storefront-startup-recovery">如果页面没有继续打开，可以<a href="">重新加载</a>，或<a href="/help/">查看购买指南</a>。</p><noscript><p>当前浏览器未启用 JavaScript，启用后即可选购。</p></noscript></main>`
function relatedHelpArticles(article: PublicArticle) {
  const links = publicArticles.filter(item => item.category === article.category && item.slug !== article.slug)
  if (!links.length) return ''
  return `<aside><h2>相关问题</h2><ul>${links.map(item => `<li><a href="/help/${item.slug}">${escape(item.title)}</a></li>`).join('')}</ul></aside>`
}
function helpCenter(query: string) {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
  const terms = normalize(query).split(/[\s,，、。？！?!：:]+/).filter(Boolean)
  let count = 0
  const groups = publicHelpCategories.map(category => {
    const articles = publicArticles.filter(article => article.category === category.id).map(article => {
      const search = [category.title, article.title, article.answer, article.keywords ?? ''].join(' ')
      const text = normalize(search)
      return { article, search, visible: terms.every(term => text.includes(term)) }
    })
    const visibleCount = articles.filter(item => item.visible).length
    count += visibleCount
    return `<section class="help-topic" data-help-group aria-labelledby="help-${category.id}"${visibleCount ? '' : ' hidden'}>
      <h2 id="help-${category.id}">${escape(category.title)}</h2>
      <ul>${articles.map(({ article, search, visible }) => `<li data-help-article${visible ? '' : ' hidden'} data-search="${escape(search)}"><a href="/help/${article.slug}">${escape(article.title)}<span aria-hidden="true">›</span></a></li>`).join('')}</ul>
    </section>`
  }).join('')
  const result = count ? `找到 ${count} 个相关问题` : '没找到相关问题。试试「查单」「付款」或「Session」。'
  return `<div class="help-center">
    <div class="help-intro">
      <h1>帮助中心</h1>
      <form class="help-search" action="/help/" method="get" data-help-search role="search">
        <label class="help-visually-hidden" for="help-search-input">搜索帮助</label>
        <input type="search" id="help-search-input" name="q" value="${escape(query)}" maxlength="120" autocomplete="off" placeholder="搜索问题，例如 Session 过期" aria-controls="help-topics">
        <button type="submit">搜索</button>
      </form>
    </div>
    <nav class="help-quick-links" aria-label="常用问题"><a href="/help/order-recovery">找回订单</a><a href="/help/session-expired">Session 过期</a><a href="/help/completed-still-free">已完成但未显示会员</a></nav>
    <p class="help-results" data-help-results role="status"${terms.length ? '' : ' hidden'}>${terms.length ? result : ''}</p>
    <div class="help-topics" id="help-topics">${groups}</div>
    <p class="help-order-action">已经下单？ <a href="/orders">回到我的订单</a></p>
  </div><script src="/help-search.js" defer></script>`
}
function htmlResponse(request: Request, body: string, status = 200, index = true) {
  const formAction = new URL(request.url).pathname === '/help/' ? 'self' : 'none'
  const response = new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Robots-Tag': index ? 'index, follow' : 'noindex, nofollow',
    'Content-Security-Policy': `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action '${formAction}'`,
  } })
  return secureResponse(request, response)
}
function document(title: string, description: string, canonical: string, body: string, brand: string, index: boolean) {
  return `<!doctype html><html lang="zh-CN" data-public-document><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="robots" content="${index ? 'index, follow' : 'noindex, nofollow'}"><link rel="canonical" href="${escape(canonical)}"><link rel="icon" href="/brands/shop.svg"><link rel="stylesheet" href="/help-center-v2.css"></head><body><header class="public-document-header"><a class="public-store-back" href="/"><span aria-hidden="true">‹</span>返回商店</a><nav aria-label="页面导航"><a href="/orders">我的订单</a></nav></header><main class="public-document">${body}</main>${brand ? `<footer class="public-document-footer">${escape(brand)} · 独立服务商</footer>` : ''}</body></html>`
}
function notFound(request: Request) {
  return htmlResponse(request, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="robots" content="noindex, nofollow"><title>页面不存在</title></head><body><main><h1>页面不存在</h1><p>商品可能已下架，或链接有误。</p><a href="/">返回商店</a> <a href="/orders">查询已有订单</a></main></body></html>', 404, false)
}
export async function publicStorefront(request: Request, env: SeoEnv): Promise<Response | null> {
  const origin = seoOrigin(env.STOREFRONT_SEO_ORIGIN), url = new URL(request.url)
  if (!origin || url.origin !== origin || !['GET', 'HEAD'].includes(request.method) || privatePath(url.pathname)) return null
  const path = url.pathname
  if (path === '/robots.txt') {
    const body = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /orders\nDisallow: /partner\nDisallow: /join\nDisallow: /r/\nDisallow: /s/\nDisallow: /__preview/\n\nSitemap: ${origin}/sitemap.xml\n`
    return secureResponse(request, new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }))
  }
  if (path !== '/sitemap.xml' && path !== '/index.html' && assetPath(path)) return null
  const isHelp = path === '/help' || path.startsWith('/help/')
  const normalized = path.replace(/\/$/, '') || '/'
  const article = publicArticles.find(a => '/help/' + a.slug === normalized)
  const validRoute = ['/', '/index.html', '/help', '/sitemap.xml'].includes(normalized) || article || /^\/product\/[a-z0-9_-]+$/i.test(normalized)
  if (!validRoute) return notFound(request)
  if (isHelp) {
    const cached = cachedCatalog(env, origin)
    const brand = cached?.platformBranding?.name ?? ''
    const products = cached ? publicProducts(cached) : []
    const canonicalPath = article ? '/help/' + article.slug : '/help/'
    if (path !== canonicalPath) return secureResponse(request, new Response(null, { status: 308, headers: { Location: canonicalPath + url.search, 'Cache-Control': 'no-store' } }))
    const query = article ? '' : (url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const index = !query
    const body = article ? `<nav aria-label="当前位置"><a href="/help/">帮助中心</a></nav><h1>${escape(article.title)}</h1><p class="public-answer">${escape(article.answer)}</p><p class="public-date">内容核对日期：<time datetime="${publicHelpUpdated}">${publicHelpUpdated}</time> · ${escape(brand || '本站')} 服务说明</p>${article.sections.map(s => `<section><h2>${escape(s.title)}</h2>${s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section>`).join('')}${article.related && products.some(p => p.path === article.related) ? `<p><a href="${article.related}">查看对应商品与现有教程</a></p>` : ''}<p><a href="/orders">查看或找回订单</a></p>${relatedHelpArticles(article)}` : helpCenter(query)
    const title = article?.title ?? '帮助中心'
    return htmlResponse(request, document(brand ? title + ' · ' + brand : title, article?.answer ?? '商品选择、付款后操作、订单找回及售后说明。', origin + canonicalPath, body, brand, index), 200, index)
  }
  const { catalog, fetchedAt, fresh } = await publicCatalog(env, origin)
  const branding = catalog.platformBranding!, products = publicProducts(catalog)
  const brand = branding.name || '商店'
  const product = products.find(p => p.path === normalized)
  if (normalized.startsWith('/product/') && !product) return notFound(request)
  const canonicalPath = normalized === '/index.html' ? '/' : normalized === '/help' ? '/help/' : normalized
  if (path !== canonicalPath) return secureResponse(request, new Response(null, { status: 308, headers: { Location: canonicalPath + url.search, 'Cache-Control': 'no-store' } }))
  if (path === '/sitemap.xml') {
    const paths = ['/', ...products.map(p => p.path), '/help/', ...publicArticles.map(a => '/help/' + a.slug)]
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + paths.map(p => `<url><loc>${escape(origin + p)}</loc></url>`).join('') + '</urlset>'
    return secureResponse(request, new Response(request.method === 'HEAD' ? null : xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' } }))
  }
  const title = product ? product.name + ' · ' + brand : branding.pageTitle || brand
  const description = product?.description ?? branding.description
  const bootstrap = fresh ? `<script id="storefront-public-catalog" type="application/json">${serializePublicBootstrap(catalog, origin, fetchedAt)}</script>` : ''
  const asset = await env.ASSETS.fetch(new Request(origin + '/', { method: 'GET' }))
  if (!asset.ok) throw new Error('Storefront asset unavailable')
  let html = await asset.text()
  if (!/<div id="root"><\/div>/.test(html)) throw new Error('Unexpected storefront shell')
  html = html.replace(/<html\b/, `<html data-public-seo="true" data-public-origin="${escape(origin)}"`)
    .replace(/<title>[^]*?<\/title>/, () => `<title>${escape(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escape(description)}">`)
    .replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="index, follow">')
    .replace('</head>', () => `<link rel="canonical" href="${escape(origin + canonicalPath)}"><link rel="stylesheet" href="/storefront-startup.css">${bootstrap}</head>`)
    .replace('<div id="root"></div>', () => `<div id="root">${startupShell(brand)}</div>`)
  return htmlResponse(request, html)
}

// Orders can restore public metadata when navigating back to the shop.
// A catalog fallback may link to standalone help without enabling SEO metadata.
export async function noindexNavigationShell(request: Request, env: SeoEnv, response: Response, catalogFallback = false) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== seoOrigin(env.STOREFRONT_SEO_ORIGIN) || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response
  const marker = /^\/orders\/?$/.test(url.pathname) ? 'data-public-seo'
    : catalogFallback && (['/', '/index.html'].includes(url.pathname) || /^\/product\/[a-z0-9_-]+\/?$/i.test(url.pathname)) ? 'data-public-help'
    : null
  if (!marker) return response
  const html = (await response.text()).replace(/<html\b/, `<html ${marker}="true" data-public-origin="${escape(url.origin)}"`)
  const headers = new Headers(response.headers)
  for (const key of ['ETag', 'Content-Length', 'Last-Modified', 'Content-Encoding']) headers.delete(key)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(html, { status: response.status, statusText: response.statusText, headers })
}
