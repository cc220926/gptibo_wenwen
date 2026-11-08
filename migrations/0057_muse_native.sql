-- Supplier-backed specs keep the existing generic delivery envelope. The mapping
-- is immutable; old local-stock/manual orders are never reinterpreted.
CREATE TABLE muse_plans (
  plan TEXT PRIMARY KEY REFERENCES catalog_plans(id),
  product_code TEXT NOT NULL,
  max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents>0 AND max_cost_cents<=10000000)
);
CREATE TABLE muse_orders (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  key_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  expected_cost_cents INTEGER NOT NULL CHECK(expected_cost_cents>=0),
  raw_body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  remote_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','creating','unknown','pending','succeeded','failed','review')),
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)),
  actual_cost_cents INTEGER,
  failure_code TEXT NOT NULL DEFAULT '',
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX muse_orders_due ON muse_orders(state,next_attempt_at,lease_until);
CREATE TRIGGER muse_intent_immutable BEFORE UPDATE ON muse_orders
WHEN NEW.key_id IS NOT OLD.key_id OR NEW.product_code IS NOT OLD.product_code
  OR NEW.raw_body IS NOT OLD.raw_body OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.expected_cost_cents IS NOT OLD.expected_cost_cents
  OR NEW.order_id IS NOT OLD.order_id OR NEW.attempted<OLD.attempted
  OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id)
BEGIN SELECT RAISE(ABORT,'supplier intent is immutable'); END;

DROP VIEW accounting_candidates;
CREATE VIEW accounting_candidates AS
SELECT o.id order_id,o.plan,o.plan_name,'order' kind,o.price_cents sale_cents,
  CASE WHEN m.order_id IS NOT NULL THEN m.actual_cost_cents WHEN f.kind='stock' THEN s.cost_cents WHEN o.plan='gmail-account' THEN k.actual_cost_cents WHEN n.order_id IS NOT NULL THEN n.actual_cost_cents ELSE c.cost_cents END cost_cents,
  MAX(o.refunded_cents,COALESCE(t.refunded_cents,0)) refund_cents,o.created_at
FROM orders o LEFT JOIN muse_orders m ON m.order_id=o.id LEFT JOIN recharge_orders t ON t.order_id=o.id LEFT JOIN accounting_costs c ON c.plan=o.plan LEFT JOIN account_supplier_orders k ON k.order_id=o.id LEFT JOIN delivery_supplier_orders n ON n.order_id=o.id LEFT JOIN fulfillment_tasks f ON f.order_id=o.id LEFT JOIN cdk_stock s ON s.id=f.stock_id AND s.order_id=o.id
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

CREATE TABLE muse_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES muse_orders(order_id),
  body_hash TEXT NOT NULL,
  wake_token TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE muse_rate_limits (
  key_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY(key_id,bucket)
);
