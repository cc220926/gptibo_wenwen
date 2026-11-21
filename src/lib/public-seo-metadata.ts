import { publicPageMetadata, type PublicCatalog } from '../../shared/public-storefront.ts'

// Metadata only: never touches routing, history, checkout, cookies or requests.
export function syncPublicPageMetadata(page: string, catalog: PublicCatalog, homeTitle: string, description: string, ready: boolean) {
  const root = document.documentElement
  if (root.dataset.publicSeo !== 'true' || root.dataset.publicOrigin !== location.origin) return
  const metadata = publicPageMetadata(page, catalog, homeTitle, description)
  if (metadata && !ready) return
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
  if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.append(robots) }
  robots.content = metadata ? 'index, follow' : 'noindex, nofollow'
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!metadata) {
    canonical?.remove()
    document.title = page === 'orders' ? '我的订单 · ' + (catalog.platformBranding?.name || homeTitle) : homeTitle
    return
  }
  document.title = metadata.title
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', metadata.description)
  const link = canonical ?? document.createElement('link')
  link.rel = 'canonical'; link.href = root.dataset.publicOrigin + metadata.path
  if (!canonical) document.head.append(link)
}
