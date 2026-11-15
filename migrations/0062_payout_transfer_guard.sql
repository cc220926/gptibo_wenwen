-- Keep pending status throughout transfer/reconciliation so existing reservations
-- and refund exclusion remain effective. There is intentionally no lock timeout.
ALTER TABLE partner_payouts ADD COLUMN transfer_state TEXT NOT NULL DEFAULT 'idle'
  CHECK(transfer_state IN ('idle','transferring','unknown','succeeded','not_sent'));
ALTER TABLE partner_payouts ADD COLUMN transfer_id TEXT;
ALTER TABLE partner_payouts ADD COLUMN transfer_started_at INTEGER;
ALTER TABLE partner_payouts ADD COLUMN transfer_resolved_at INTEGER;
CREATE UNIQUE INDEX partner_payout_transfer_id ON partner_payouts(transfer_id) WHERE transfer_id IS NOT NULL;
-- Old approved records might already have been transferred outside the site.
UPDATE partner_payouts SET transfer_state='unknown',transfer_id='legacy-'||id,
  transfer_started_at=reviewed_at,version=version+1 WHERE status='pending' AND reviewed_at IS NOT NULL;
UPDATE partner_payouts SET transfer_state='succeeded',transfer_resolved_at=handled_at WHERE status='paid';
CREATE TABLE partner_transfer_receipts (
  reference TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL REFERENCES partner_payouts(id),
  created_at INTEGER NOT NULL
);
-- Reserve old references even if legacy records used a reference more than once.
INSERT INTO partner_transfer_receipts(reference,payout_id,created_at)
  SELECT UPPER(TRIM(reference)),MIN(id),MIN(COALESCE(handled_at,created_at))
  FROM partner_payouts WHERE status='paid' AND TRIM(reference)<>'' GROUP BY UPPER(TRIM(reference));
