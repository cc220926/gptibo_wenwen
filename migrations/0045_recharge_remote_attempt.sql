-- Local submissions include requests rejected before a platform task exists.
-- Preserve their sequence/history and bind the platform's attempt number only
-- when a matching signed task response supplies it. Do not infer old values.
ALTER TABLE recharge_redemptions ADD COLUMN remote_attempt_no INTEGER
  CHECK(remote_attempt_no IS NULL OR remote_attempt_no > 0);
CREATE UNIQUE INDEX recharge_remote_attempt_number
  ON recharge_redemptions(order_id,remote_attempt_no)
  WHERE remote_attempt_no IS NOT NULL;

-- Order and task polling can succeed in different requests. Keep each durable
-- notification watermark so neither a lost result nor perpetual queue priority
-- follows from their independent polling deadlines.
ALTER TABLE recharge_orders ADD COLUMN order_checked_notify_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recharge_orders ADD COLUMN redemption_checked_notify_version INTEGER NOT NULL DEFAULT 0;
UPDATE recharge_orders
SET order_checked_notify_version=checked_notify_version,
    redemption_checked_notify_version=checked_notify_version;
