-- Existing products retain their original adapters. New products choose a delivery type.
CREATE TABLE service_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE catalog_plans ADD COLUMN delivery_type TEXT NOT NULL DEFAULT 'legacy'
  CHECK(delivery_type IN ('legacy','stock','manual'));

CREATE TABLE inventory_key (
  id INTEGER PRIMARY KEY CHECK(id=1),
  fingerprint TEXT NOT NULL
);
CREATE TABLE cdk_stock (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL REFERENCES catalog_plans(id),
  fingerprint TEXT NOT NULL UNIQUE,
  encrypted_value TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','delivered','quarantined')),
  order_id TEXT UNIQUE REFERENCES orders(id),
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(cost_cents>=0),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  CHECK(state<>'available' OR order_id IS NULL),
  CHECK(state NOT IN ('reserved','delivered') OR order_id IS NOT NULL)
);
CREATE INDEX cdk_stock_available ON cdk_stock(plan,state,created_at,id);

CREATE TABLE fulfillment_tasks (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('stock','manual')),
  state TEXT NOT NULL CHECK(state IN ('reserved','queued','running','delivered','expired','review')),
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  stock_id TEXT REFERENCES cdk_stock(id),
  encrypted_value TEXT,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  updated_at INTEGER NOT NULL,
  mail_state TEXT NOT NULL DEFAULT 'pending' CHECK(mail_state IN ('pending','sending','sent','review')),
  encrypted_mail TEXT,
  mail_first_attempt_at INTEGER,
  mail_next_attempt_at INTEGER NOT NULL DEFAULT 0,
  mail_attempts INTEGER NOT NULL DEFAULT 0,
  mail_provider_id TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  CHECK(kind<>'stock' OR stock_id IS NOT NULL)
);
CREATE INDEX fulfillment_tasks_due ON fulfillment_tasks(state,mail_state,mail_next_attempt_at);
-- Once a code was disclosed it is never returned to sellable inventory, including refunds.
CREATE TRIGGER cdk_stock_no_recycle BEFORE UPDATE ON cdk_stock
WHEN OLD.state IN ('delivered','quarantined') AND (NEW.state='available' OR NEW.order_id IS NOT OLD.order_id)
BEGIN SELECT RAISE(ABORT,'disclosed inventory cannot be recycled'); END;

-- Use the cost of the exact unit sold; changing future inventory does not change old margins.
DROP VIEW accounting_candidates;
CREATE VIEW accounting_candidates AS
SELECT o.id order_id,o.plan,o.plan_name,'order' kind,o.price_cents sale_cents,
  CASE WHEN f.kind='stock' THEN s.cost_cents WHEN o.plan='gmail-account' THEN k.actual_cost_cents WHEN n.order_id IS NOT NULL THEN n.actual_cost_cents ELSE c.cost_cents END cost_cents,
  MAX(o.refunded_cents,COALESCE(t.refunded_cents,0)) refund_cents,o.created_at
FROM orders o LEFT JOIN recharge_orders t ON t.order_id=o.id LEFT JOIN accounting_costs c ON c.plan=o.plan LEFT JOIN account_supplier_orders k ON k.order_id=o.id LEFT JOIN delivery_supplier_orders n ON n.order_id=o.id LEFT JOIN fulfillment_tasks f ON f.order_id=o.id LEFT JOIN cdk_stock s ON s.id=f.stock_id AND s.order_id=o.id
WHERE o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.status='success'
  AND o.refund_hold=0 AND COALESCE(t.financial_hold,0)=0
  AND NOT EXISTS(SELECT 1 FROM accounting_items i WHERE i.order_id=o.id AND i.kind='order')
UNION ALL
SELECT o.id,o.plan,o.plan_name,'refund',0,0,
  MAX(o.refunded_cents,COALESCE(t.refunded_cents,0))-(SELECT SUM(i.refund_cents) FROM accounting_items i WHERE i.order_id=o.id),o.created_at
FROM orders o LEFT JOIN recharge_orders t ON t.order_id=o.id
WHERE o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND COALESCE(t.financial_hold,0)=0
  AND EXISTS(SELECT 1 FROM accounting_items i WHERE i.order_id=o.id AND i.kind='order')
  AND MAX(o.refunded_cents,COALESCE(t.refunded_cents,0))>(SELECT SUM(i.refund_cents) FROM accounting_items i WHERE i.order_id=o.id);
