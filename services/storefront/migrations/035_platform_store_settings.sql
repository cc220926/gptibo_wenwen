CREATE TABLE platform_branding (
 id smallint PRIMARY KEY CHECK(id=1),
 name text NOT NULL DEFAULT '' CHECK(char_length(name)<=32),
 logo text NOT NULL DEFAULT '' CHECK(octet_length(logo)<=350000),
 page_title text NOT NULL DEFAULT '' CHECK(char_length(page_title)<=80),
 headline text NOT NULL DEFAULT '' CHECK(char_length(headline)<=80),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=200),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0)
);
INSERT INTO platform_branding(id) VALUES(1);

CREATE TABLE platform_announcements (
 id smallint PRIMARY KEY CHECK(id=1),
 enabled boolean NOT NULL DEFAULT false,
 placement text NOT NULL DEFAULT 'home' CHECK(placement IN ('home','product','both')),
 title text NOT NULL DEFAULT '站点公告' CHECK(char_length(title)<=80),
 content text NOT NULL DEFAULT '' CHECK(char_length(content)<=5000),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0)
);
INSERT INTO platform_announcements(id) VALUES(1);
