CREATE TABLE partner_payout_accounts (
  partner_id TEXT PRIMARY KEY REFERENCES partners(id),
  phone TEXT NOT NULL CHECK(length(phone)=11 AND phone NOT GLOB '*[^0-9]*' AND substr(phone,1,1)='1' AND substr(phone,2,1) BETWEEN '3' AND '9'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 50 AND name=trim(name)),
  version INTEGER NOT NULL CHECK(version >= 1),
  last_event_id TEXT NOT NULL
);
