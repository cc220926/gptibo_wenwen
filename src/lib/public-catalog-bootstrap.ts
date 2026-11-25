import { parsePublicBootstrap } from '../../shared/public-bootstrap.ts'

// Consume only on the first main-store refresh. Private initialization, order
// reads, mutations, retries and subsequent price refreshes retain their loaders.
export function consumePublicCatalogBootstrap<T>(source: { textContent: string | null; remove(): void } | null, origin: string, shopSlug?: string, now = Date.now()): T | null {
  if (!source || shopSlug) return null
  source.remove()
  return parsePublicBootstrap<T>(source.textContent ?? '', origin, now)
}
export function readPublicCatalog<T>(load: () => Promise<T>, shopSlug?: string): Promise<T> {
  if (typeof document === 'undefined' || typeof location === 'undefined' || document.documentElement.dataset.publicSeo !== 'true' || document.documentElement.dataset.publicOrigin !== location.origin) return load()
  const data = consumePublicCatalogBootstrap<T>(document.getElementById('storefront-public-catalog'), location.origin, shopSlug)
  return data === null ? load() : Promise.resolve(data)
}
