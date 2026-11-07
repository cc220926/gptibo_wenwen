-- Local submission ordinals include definitely rejected requests. The supplier
-- increments its attempt number only after creating a fulfillment task.
ALTER TABLE recharge_redemptions ADD COLUMN remote_attempt_no bigint
  CHECK (remote_attempt_no BETWEEN 1 AND 9007199254740991);

-- Older replies could omit attempt_no, even when a remote ID was accepted.
-- Leave these ordinals unknown until the original task is queried and verified.
CREATE UNIQUE INDEX recharge_remote_attempt_identity
  ON recharge_redemptions(order_id,remote_attempt_no) WHERE remote_id IS NOT NULL;
