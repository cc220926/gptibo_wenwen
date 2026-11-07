-- Event discovery is deliberately opt-in at runtime, with an explicit launch
-- cutoff. Applying this migration does not backfill or send historical email.
CREATE TABLE order_email_notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  event_id TEXT NOT NULL,
  refund_case_id TEXT REFERENCES refund_cases(id),
  attempt_id TEXT REFERENCES recharge_redemptions(id),
  kind TEXT NOT NULL CHECK(kind IN ('payment','recharge_success','recharge_failed','refund')),
  event_created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','manual_review')),
  next_attempt_at INTEGER NOT NULL,
  first_attempt_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  provider_message_id TEXT,
  delivered_at INTEGER,
  closed_reason TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT NOT NULL DEFAULT ''
);
CREATE INDEX order_email_notifications_due ON order_email_notifications(next_attempt_at)
  WHERE status='pending';
CREATE INDEX order_email_notifications_order ON order_email_notifications(order_id,event_created_at);
CREATE INDEX order_events_email_discovery ON order_events(created_at,id)
  WHERE action IN ('payment-confirmed','recharge-status','platform-fulfillment-completed');
CREATE INDEX refund_events_email_discovery ON refund_events(created_at,id) WHERE status='refunded';
