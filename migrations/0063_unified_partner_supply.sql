-- Deploy the unified-price writer before this data migration. Preserve each
-- partner's retail and every order/payout snapshot. Existing retail >= cost
-- CHECK is intentional: reject the migration rather than silently raise retail.
INSERT INTO partner_default_prices(plan,cost_cents)
SELECT id,price_cents FROM catalog_plans WHERE 1 ON CONFLICT(plan) DO NOTHING;
UPDATE partner_prices SET cost_cents=(SELECT d.cost_cents FROM partner_default_prices d WHERE d.plan=partner_prices.plan),version=version+1
WHERE EXISTS(SELECT 1 FROM partner_default_prices d WHERE d.plan=partner_prices.plan AND d.cost_cents<>partner_prices.cost_cents);
UPDATE partner_default_price_settings SET version=version+1,change_id='unified-supply-0063',updated_at=unixepoch()*1000 WHERE id=1;
INSERT INTO admin_audit(id,target_id,action,note,created_at)
VALUES ('unified-supply-0063','partner-default-prices','partner-supply-unified','启用总站统一供货价，同步全部已有代理；代理售价、历史订单及收益快照保持不变。',unixepoch()*1000);
