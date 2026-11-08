-- Keep only a validated date hint, never the supplier's arbitrary error prose.
-- This wall-clock value has no known time zone and must not schedule retries.
ALTER TABLE recharge_redemptions ADD COLUMN subscription_expires_hint TEXT
  CHECK(subscription_expires_hint IS NULL OR length(subscription_expires_hint)=16);
