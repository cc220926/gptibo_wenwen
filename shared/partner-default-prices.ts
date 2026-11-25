export type DefaultSupplyPlan = {
  id: string
  product_id: string
  name: string
  price_cents: number
  min_partner_price_cents?: number | null
  cost_cents: number
  catalog_version: number
  renewal_only: number
}
export type DefaultSupplySettings = { version: number; plans: DefaultSupplyPlan[] }
