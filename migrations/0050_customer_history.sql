-- Owner-supplied historical paid-customer display masks. These are not orders,
-- unique people, or live activity, and never enter payment or fulfillment logic.
CREATE TABLE customer_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  masked_email TEXT NOT NULL CHECK(length(masked_email) <= 254 AND instr(masked_email, '***') > 0 AND instr(masked_email, '@') > 0),
  UNIQUE(shop_id, masked_email)
);
CREATE INDEX customer_history_page ON customer_history(shop_id, id);
