ALTER TABLE v3_policies ADD COLUMN sections TEXT;
--> statement-breakpoint
CREATE TABLE v3_recipes (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES tokens(id), key TEXT NOT NULL, version INTEGER NOT NULL,
 spec TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', position INTEGER NOT NULL DEFAULT 0,
 source TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_v3_recipes_account_key_version ON v3_recipes(account_id, key, version);
--> statement-breakpoint
-- The calendar rule used to be code. Accounts that already have a policy keep
-- it as an adopted recipe at the same key and version, so cached verdicts match.
INSERT INTO v3_recipes (id, account_id, key, version, spec, status, position, source, created_by, created_at, updated_at)
SELECT lower(hex(randomblob(16))), account_id, 'calendar-rsvp', 1,
 '{"key":"calendar-rsvp","title":"Calendar replies","description":"Accepted, declined or maybe replies with no note from the person.","action":"trash","reason":"Bare calendar response · no human note","match":[{"field":"calendar.responseOnly","is":true},{"field":"calendar.note","is":null},{"field":"clipped","is":false},{"field":"attachmentsNotRead","is":false}]}',
 'active', 0, 'library:calendar-rsvp@1', 'migration', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (SELECT DISTINCT account_id FROM v3_policies);
