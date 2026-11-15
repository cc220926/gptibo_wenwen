-- A delisted self-owned spec is hidden from the storefront and refuses new orders.
-- Unlike enabled=0 (shown as "paused"), delisted specs are not displayed at all.
-- Existing orders, payments and deliveries for the spec are untouched.
ALTER TABLE catalog_plans ADD COLUMN delisted INTEGER NOT NULL DEFAULT 0 CHECK(delisted IN (0,1));
