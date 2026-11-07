-- Short-lived browser activity only. These rows are not purchases or customers.
CREATE TABLE checkout_presence (
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL CHECK(product_id = 'chatgpt'),
  owner_hash TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (shop_id, product_id, owner_hash, tab_id)
);
CREATE INDEX checkout_presence_live ON checkout_presence(shop_id, product_id, last_seen_at, owner_hash) WHERE closed_at IS NULL;
CREATE INDEX checkout_presence_stale ON checkout_presence(last_seen_at) WHERE closed_at IS NULL;
CREATE INDEX checkout_presence_closed ON checkout_presence(closed_at) WHERE closed_at IS NOT NULL;
