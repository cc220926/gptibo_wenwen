-- Freeze the exact provider request before the first invitation attempt.
-- Historical attempted rows without this snapshot must not be retried with a new body.
ALTER TABLE telegram_partner_applications ADD COLUMN mail_body TEXT;
