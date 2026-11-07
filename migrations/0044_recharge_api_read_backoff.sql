-- Store timing metadata only. Never cache supplier replies or credentials.
CREATE TABLE recharge_api_reads (
  account TEXT NOT NULL,
  resource TEXT NOT NULL,
  next_allowed_at INTEGER NOT NULL,
  PRIMARY KEY (account, resource)
);
