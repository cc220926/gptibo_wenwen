import { DEFAULT_PRODUCT_ORDER, type StorefrontProductId } from '../shared/product-order.ts'
import { ApiError, type Env } from './platform.ts'

/** A deployment-level sales scope. Legacy deployments without it retain their
 * existing catalog; production declares its scope explicitly in Wrangler. */
export function partnerProductIds(env: Env): readonly StorefrontProductId[] {
  if (env.PARTNER_PRODUCT_IDS === undefined) return DEFAULT_PRODUCT_ORDER
  const ids = env.PARTNER_PRODUCT_IDS.split(',').map(id => id.trim()).filter(Boolean)
  if (ids.some(id => !DEFAULT_PRODUCT_ORDER.some(known => known === id))) throw new ApiError('分站商品范围配置无效，请联系平台。', 503)
  return [...new Set(ids)] as StorefrontProductId[]
}

export const partnerProductAllowed = (env: Env, id: string) => partnerProductIds(env).some(allowed => allowed === id)
export function partnerExcludedProducts(env: Env) {
  const allowed = partnerProductIds(env)
  return DEFAULT_PRODUCT_ORDER.filter(id => !allowed.includes(id))
}
