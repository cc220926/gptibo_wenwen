// Only the main store's public presentation DTO may cross into HTML. Never copy
// unknown catalog fields, procurement costs, orders, sessions or credentials.
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function pick(value: unknown, keys: readonly string[]) {
  if (!record(value)) return value === null ? null : undefined
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key) && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))).map(key => [key, value[key]]))
}
export function publicBootstrapCatalog(value: unknown) {
  if (!record(value) || !Array.isArray(value.plans)) throw new Error('Invalid public catalog')
  const result = pick(value, ['checkoutEnabled', 'testingEnabled', 'mode'])!
  for (const key of ['hiddenProductIds', 'productOrder']) if (Array.isArray(value[key])) result[key] = value[key].filter((id: unknown) => typeof id === 'string' && /^[a-z0-9_-]{1,96}$/i.test(id))
  if (record(value.completedOrdersByProduct)) result.completedOrdersByProduct = Object.fromEntries(Object.entries(value.completedOrdersByProduct).filter(([id, count]) => /^[a-z0-9_-]{1,96}$/i.test(id) && Number.isSafeInteger(count) && Number(count) >= 0))
  result.plans = value.plans.map(plan => pick(plan, ['id', 'product_id', 'name', 'price_cents', 'enabled', 'renewal_only', 'version', 'delisted', 'supply_kind', 'delivery_provider', 'delivery_type', 'product_name', 'category', 'description', 'stock_available', 'has_coupons', 'supports_warranty', 'partner_enabled', 'purchase_note', 'delivery_instructions']))
  result.platformBranding = pick(value.platformBranding, ['name', 'logo', 'pageTitle', 'headline', 'description', 'version'])
  result.supportContacts = pick(value.supportContacts, ['wechat', 'qq', 'email'])
  result.announcement = pick(value.announcement, ['enabled', 'placement', 'title', 'content', 'version'])
  result.marketingMetric = pick(value.marketingMetric, ['enabled', 'displayText', 'displayCount'])
  if (Array.isArray(value.paymentMethods)) result.paymentMethods = value.paymentMethods.map(option => pick(option, ['method', 'name', 'feeBps']))
  return result
}
export function serializePublicBootstrap(catalog: unknown, origin: string, fetchedAt: number) {
  return JSON.stringify({ version: 1, origin, fetchedAt, catalog: publicBootstrapCatalog(catalog) })
    .replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
export function parsePublicBootstrap<T>(text: string, origin: string, now: number): T | null {
  try {
    const data: unknown = JSON.parse(text)
    if (!record(data) || data.version !== 1 || data.origin !== origin || typeof data.fetchedAt !== 'number' || !Number.isFinite(data.fetchedAt) || Math.abs(now - data.fetchedAt) > 5000 || !record(data.catalog)) return null
    const c = data.catalog
    if ('partner' in c || !Array.isArray(c.plans) || typeof c.checkoutEnabled !== 'boolean' || typeof c.testingEnabled !== 'boolean' || !record(c.supportContacts) || !record(c.platformBranding)) return null
    if (!c.plans.every(p => record(p) && typeof p.id === 'string' && typeof p.product_id === 'string' && typeof p.name === 'string' && Number.isSafeInteger(p.price_cents) && Number(p.price_cents) > 0 && typeof p.enabled === 'number' && typeof p.version === 'number')) return null
    return c as T
  } catch { return null }
}
