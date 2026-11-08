type ServiceOffer = { id: string; product_id: string; product_name?: string; name: string }

export function isMuseOffer(offer: ServiceOffer) {
  return offer.id.startsWith('custom-') && /\bmuse(?:ai)?\b/i.test(`${offer.product_name ?? ''} ${offer.name}`)
}

export function serviceProductRoute(offer: ServiceOffer) {
  return isMuseOffer(offer) ? 'product/muse' : `product/${offer.product_id}`
}

export function museQuota(name: string) {
  const amount = /(\d+)\s*亿/.exec(name)?.[1]
  return amount ? `${amount} 亿 Token` : '以所选规格说明为准'
}
