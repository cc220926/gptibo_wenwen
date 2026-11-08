-- One encrypted, order-scoped request snapshot; never expose it through APIs.
CREATE TABLE recharge_saved_credentials (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  attempt_id TEXT NOT NULL REFERENCES recharge_redemptions(id),
  encrypted_request TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  credential_expires_at INTEGER,
  CHECK(retain_until>saved_at AND retain_until<=saved_at+2592000000)
);
CREATE INDEX recharge_saved_credentials_expiry ON recharge_saved_credentials(retain_until);
CREATE TRIGGER recharge_saved_clear_order AFTER UPDATE OF status,refunded_cents,redemption_blocked ON orders
WHEN NEW.status='success' OR NEW.refunded_cents>0 OR NEW.redemption_blocked=1
BEGIN DELETE FROM recharge_saved_credentials WHERE order_id=NEW.id; END;
CREATE TRIGGER recharge_saved_clear_refund AFTER UPDATE OF refunded_cents,payment_status ON recharge_orders
WHEN NEW.refunded_cents>0 OR NEW.payment_status IN ('partially_refunded','refunded')
BEGIN DELETE FROM recharge_saved_credentials WHERE order_id=NEW.order_id; END;
