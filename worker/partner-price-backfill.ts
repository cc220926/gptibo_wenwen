import type { Env } from './platform.ts'

/** Run after the successful settings audit, inside the same transaction.
 * Existing retail, cost and version remain untouched; no order data is written. */
export function backfillPartnerPrices(env: Env, auditId: string, planId: string | null = null) {
  return env.INTEREST_DB.prepare(`INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents)
    SELECT p.id,c.id,COALESCE(d.cost_cents,c.price_cents),MAX(c.price_cents,COALESCE(d.cost_cents,c.price_cents))
    FROM partners p CROSS JOIN catalog_plans c LEFT JOIN partner_default_prices d ON d.plan=c.id
    WHERE c.partner_enabled=1 AND (? IS NULL OR c.id=?)
      AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?)
      AND NOT EXISTS(SELECT 1 FROM partner_prices pp WHERE pp.partner_id=p.id AND pp.plan=c.id)
    ON CONFLICT(partner_id,plan) DO NOTHING`).bind(planId, planId, auditId)
}
