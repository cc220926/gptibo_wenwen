CREATE TABLE platform_product_visibility (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hidden_product_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(hidden_product_ids) AND json_type(hidden_product_ids) = 'array'),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  change_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO platform_product_visibility(id) VALUES (1);
