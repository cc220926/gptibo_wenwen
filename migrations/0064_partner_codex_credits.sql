-- Enable resale of the two existing Codex tiers. The platform supply prices are
-- authoritative; retain every existing partner retail and all order snapshots.
INSERT INTO partner_default_prices(plan,cost_cents)
SELECT id,price_cents FROM catalog_plans WHERE id IN ('codex-credits-250','codex-credits-500')
ON CONFLICT(plan) DO NOTHING;
UPDATE catalog_plans SET partner_enabled=1,version=version+1,updated_at=unixepoch()*1000
WHERE id IN ('codex-credits-250','codex-credits-500') AND partner_enabled<>1;
INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents)
SELECT p.id,c.id,d.cost_cents,c.price_cents FROM partners p CROSS JOIN catalog_plans c
JOIN partner_default_prices d ON d.plan=c.id
WHERE c.id IN ('codex-credits-250','codex-credits-500')
ON CONFLICT(partner_id,plan) DO NOTHING;
