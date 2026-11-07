CREATE TABLE platform_branding (
  id INTEGER PRIMARY KEY CHECK(id=1),
  name TEXT NOT NULL DEFAULT '' CHECK(length(name)<=32),
  logo TEXT NOT NULL DEFAULT '' CHECK(length(logo)<=350000),
  page_title TEXT NOT NULL DEFAULT '' CHECK(length(page_title)<=80),
  headline TEXT NOT NULL DEFAULT '' CHECK(length(headline)<=80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=200),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  change_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO platform_branding(id) VALUES(1);

CREATE TABLE platform_announcements (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  placement TEXT NOT NULL DEFAULT 'home' CHECK(placement IN ('home','product','both')),
  title TEXT NOT NULL DEFAULT '站点公告' CHECK(length(title)<=80),
  content TEXT NOT NULL DEFAULT '' CHECK(length(content)<=5000),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  change_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO platform_announcements(id) VALUES(1);
