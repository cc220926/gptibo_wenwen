-- A paused plan remains visible; this independent product switch hides all
-- its plans from the public catalog without touching existing orders.
ALTER TABLE service_products ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
