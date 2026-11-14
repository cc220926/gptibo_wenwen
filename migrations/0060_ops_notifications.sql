-- Operator push alerts (Feishu, WeCom, ServerChan, admin email). Discovery is
-- opt-in with an explicit OPS_NOTIFICATIONS_SINCE cutoff; applying this
-- migration sends nothing and never backfills history.
CREATE TABLE ops_notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK(channel IN ('feishu','wecom','serverchan','email')),
  kind TEXT NOT NULL CHECK(kind IN ('paid','refund_requested')),
  order_id TEXT NOT NULL REFERENCES orders(id),
  source_id TEXT NOT NULL,
  event_created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  next_attempt_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at INTEGER,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ops_notifications_due ON ops_notifications(next_attempt_at) WHERE status='pending';
CREATE INDEX refund_cases_ops_discovery ON refund_cases(created_at);
