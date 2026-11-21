import { commerce } from './commerce.ts'
import { secureResponse } from './security.ts'
import type { Database, Env, Statement } from './platform.ts'
import { publicProducts, publicPrice, type PublicCatalog, type PublicProduct } from '../shared/public-storefront.ts'
import { publicArticles, publicHelpUpdated } from '../shared/public-help.ts'

export type SeoEnv = Env & { STOREFRONT_SEO_ORIGIN?: string }
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
async function publicCatalog(env: SeoEnv, origin: string): Promise<PublicCatalog> {
  // No inbound cookies, buyer token, query string, partner or forwarded headers.
  // Reuse the existing public retail catalog; don't duplicate pricing or supply logic.
  let timer: ReturnType<typeof setTimeout> | undefined
  const response = await Promise.race([
    commerce(new Request(origin + '/api/catalog'), { ...env, INTEREST_DB: readOnlyDatabase(env.INTEREST_DB) }),
    new Promise<Response>((_, reject) => { timer = setTimeout(() => reject(new Error('Public catalog deadline')), 1500) }),
  ]).finally(() => clearTimeout(timer))
  if (!response.ok) throw new Error('Public catalog unavailable')
  const catalog = await response.json() as PublicCatalog
  if (!Array.isArray(catalog.plans) || !catalog.platformBranding) throw new Error('Public catalog incomplete')
  return catalog
}
const privatePath = (path: string) => /^\/(?:api|admin|orders|partner|join|r|s)(?:\/|$)/.test(path) || path.startsWith('/__preview/')
const assetPath = (path: string) => /^\/(?:assets|brands|fonts|images)\//.test(path) || /\.[a-z\d]{1,8}$/i.test(path)
const offerRows = (product: PublicProduct) => product.offers.map(p => `<tr><th scope="row">${escape(p.name)}</th><td>¥${publicPrice(p.price_cents)}</td><td>${p.enabled ? p.renewal_only ? '仅续费' : '可选购' : '暂停售卖'}</td></tr>`).join('')
const productBlock = (product: PublicProduct) => `<section><h2><a href="${escape(product.path)}">${escape(product.name)}</a></h2><p>${escape(product.description)}</p><table><thead><tr><th>规格</th><th>价格</th><th>状态</th></tr></thead><tbody>${offerRows(product)}</tbody></table></section>`
const helpLinks = () => publicArticles.map(a => `<li><a href="/help/${a.slug}">${escape(a.title)}</a></li>`).join('')
function htmlResponse(request: Request, body: string, status = 200, index = true) {
  const response = new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Robots-Tag': index ? 'index, follow' : 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
  } })
  return secureResponse(request, response)
}
function document(title: string, description: string, canonical: string, body: string, brand: string) {
  return `<!doctype html><html lang="zh-CN" data-public-document><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="robots" content="index, follow"><link rel="canonical" href="${escape(canonical)}"><link rel="icon" href="/brands/shop.svg"><link rel="stylesheet" href="/public-content.css"></head><body><header class="public-document-header"><a href="/">${escape(brand)}</a><nav aria-label="页面导航"><a href="/help/">购买指南</a><a href="/orders">我的订单</a></nav></header><main class="public-document">${body}</main><footer class="public-document-footer">${escape(brand)} · 独立服务商</footer></body></html>`
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
  const catalog = await publicCatalog(env, origin)
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
  if (isHelp) {
    const body = article ? `<nav aria-label="当前位置"><a href="/help/">购买指南</a></nav><h1>${escape(article.title)}</h1><p class="public-answer">${escape(article.answer)}</p><p class="public-date">内容核对日期：<time datetime="${publicHelpUpdated}">${publicHelpUpdated}</time> · ${escape(brand)} 服务说明</p>${article.sections.map(s => `<section><h2>${escape(s.title)}</h2>${s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section>`).join('')}${article.related && products.some(p => p.path === article.related) ? `<p><a href="${article.related}">查看对应商品与现有教程</a></p>` : ''}<p><a href="/orders">查看或找回订单</a></p><aside><h2>其他购买问题</h2><ul>${helpLinks()}</ul></aside>` : `<h1>购买指南</h1><p class="public-answer">先确认商品和交付方式，再按原订单继续操作。</p><ul class="public-help-list">${publicArticles.map(a => `<li><h2><a href="/help/${a.slug}">${escape(a.title)}</a></h2><p>${escape(a.answer)}</p></li>`).join('')}</ul>`
    return htmlResponse(request, document(article ? article.title + ' · ' + brand : '购买指南 · ' + brand, article?.answer ?? '商品选择、付款后操作、订单找回及售后说明。', origin + canonicalPath, body, brand))
  }
  const title = product ? product.name + ' · ' + brand : branding.pageTitle || brand
  const description = product?.description ?? branding.description
  const body = product ? `<nav><a href="/">全部商品</a></nav><h1>${escape(product.name)}</h1><p>${escape(product.description)}</p>${productBlock(product)}<p>实际可购状态和最终金额以订单确认为准。请先查看购买须知。</p><p><a href="/help/">购买指南</a> · <a href="/orders">我的订单</a></p>` : `<h1>${escape(branding.headline || brand)}</h1><p>${escape(description)}</p>${products.map(productBlock).join('')}<nav aria-label="购买帮助"><a href="/help/">购买指南</a> · <a href="/orders">我的订单</a></nav>`
  const asset = await env.ASSETS.fetch(new Request(origin + '/', { method: 'GET' }))
  if (!asset.ok) throw new Error('Storefront asset unavailable')
  let html = await asset.text()
  if (!/<div id="root"><\/div>/.test(html)) throw new Error('Unexpected storefront shell')
  html = html.replace(/<html\b/, `<html data-public-seo="true" data-public-origin="${escape(origin)}"`)
    .replace(/<title>[^]*?<\/title>/, () => `<title>${escape(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escape(description)}">`)
    .replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="index, follow">')
    .replace('</head>', () => `<link rel="canonical" href="${escape(origin + canonicalPath)}"><link rel="stylesheet" href="/public-content.css"></head>`)
    .replace('<div id="root"></div>', () => `<div id="root"><main class="public-seo-fallback">${body}</main></div>`)
  return htmlResponse(request, html)
}

// A direct visit to orders must stay noindex. The public-origin marker contains
// no buyer data and lets the existing SPA restore metadata when returning home.
export async function privateNavigationShell(request: Request, env: SeoEnv, response: Response) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || !['/orders', '/orders/'].includes(url.pathname) || url.origin !== seoOrigin(env.STOREFRONT_SEO_ORIGIN) || response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response
  const html = (await response.text()).replace(/<html\b/, `<html data-public-seo="true" data-public-origin="${escape(url.origin)}"`)
  const headers = new Headers(response.headers)
  for (const key of ['ETag', 'Content-Length', 'Last-Modified', 'Content-Encoding']) headers.delete(key)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(html, { status: response.status, statusText: response.statusText, headers })
}
