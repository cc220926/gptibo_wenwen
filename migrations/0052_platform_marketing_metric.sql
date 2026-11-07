CREATE TABLE platform_marketing_metric (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  display_text TEXT NOT NULL DEFAULT '活动展示数：{count}' CHECK (length(display_text) BETWEEN 1 AND 120),
  display_count INTEGER NOT NULL DEFAULT 0 CHECK (display_count BETWEEN 0 AND 999999),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  change_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO platform_marketing_metric(id) VALUES (1);
