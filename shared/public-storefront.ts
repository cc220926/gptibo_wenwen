import { STOREFRONT_PRODUCTS } from './product-order.ts'
import { serviceProductRoute } from './service-presentation.ts'

export type PublicOffer = {
  id: string; product_id: string; name: string; price_cents: number; enabled: number
  product_name?: string; description?: string; supply_kind?: string | null
  delisted?: number; delivery_type?: string; renewal_only?: number
}
export type PublicCatalog = {
  plans: PublicOffer[]; hiddenProductIds?: readonly string[]
  platformBranding?: { name: string; pageTitle: string; headline: string; description: string } | null
}
export type PublicProduct = { id: string; path: string; name: string; description: string; offers: PublicOffer[] }
const descriptions: Record<string, string> = {
  chatgpt: '使用自己的账号购买 ChatGPT 订阅。先选择套餐并确认购买须知，付款后按原订单指引连接账号。',
  'codex-credits': 'Codex 一次性点数包，与月度订阅及接码服务分别销售。付款后按原订单指引连接账号并查看进度。',
  'codex-sms': '付款确认后交付接码 CDK，按订单中的兑换说明获取手机号和验证码。此服务与订阅、点数包分别销售。',
}
export function publicProducts(catalog: PublicCatalog): PublicProduct[] {
  const hidden = new Set(catalog.hiddenProductIds ?? [])
  const groups = new Map<string, PublicProduct>()
  const offers = catalog.plans.filter(p => !hidden.has(p.product_id) && !p.delisted && /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(p.product_id) && Number.isSafeInteger(p.price_cents) && p.price_cents >= 0)
  // Match the storefront's SMS card: mapped supply replaces its legacy spec.
  const sms = offers.filter(p => p.supply_kind === 'codex-sms').sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || a.price_cents - b.price_cents)[0]
  for (const offer of offers) {
    if (sms && offer.product_id === 'codex-sms' && offer.supply_kind !== 'codex-sms') continue
    const id = offer.supply_kind === 'codex-sms' ? 'codex-sms' : offer.product_id
    if (hidden.has(id)) continue
    const known = STOREFRONT_PRODUCTS.find(p => p.id === id)
    if (known && 'upcoming' in known) continue
    const custom = !known
    if (custom && !['stock', 'manual'].includes(offer.delivery_type ?? '')) continue
    const path = id === 'codex-sms' ? '/product/codex-sms' : custom ? '/' + serviceProductRoute(offer) : '/product/' + id
    const name = known?.name ?? offer.product_name ?? '商品'
    const product = groups.get(path) ?? { id, path, name, description: descriptions[id] ?? offer.description ?? '选择规格前，请查看商品详情中的购买须知、交付方式和售后范围。', offers: [] }
    product.offers.push(offer)
    groups.set(path, product)
  }
  return [...groups.values()]
}
// Search-facing titles for the main store; the storefront name stays unchanged.
const productTitles: Record<string, string> = {
  chatgpt: 'ChatGPT Plus / Pro 代充 · 支付宝付款',
  'codex-credits': 'Codex 点数充值 · 250 / 500 点',
  'codex-sms': 'Codex 接码 CDK',
}
export function publicProductTitle(product: PublicProduct, brand: string) { return (productTitles[product.id] ?? product.name) + ' · ' + brand }
export function publicPrice(cents: number) { return (cents / 100).toFixed(cents % 100 ? 2 : 0) }

export function publicPageMetadata(page: string, catalog: PublicCatalog, homeTitle: string, homeDescription: string) {
  const brand = catalog.platformBranding?.name || '商店'
  if (page === 'store') return { title: homeTitle, description: homeDescription, path: '/' }
  const product = publicProducts(catalog).find(p => 'product/' + p.path.slice('/product/'.length) === page)
  return product ? { title: publicProductTitle(product, brand), description: product.description, path: product.path } : null
}
