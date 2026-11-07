-- Extend the existing manual display value with an optional post-activation
-- count. Keep this migration after 0052 and before the separate 0053 release.
ALTER TABLE platform_marketing_metric ADD COLUMN auto_count_since INTEGER
  CHECK (auto_count_since IS NULL OR auto_count_since > 0);
