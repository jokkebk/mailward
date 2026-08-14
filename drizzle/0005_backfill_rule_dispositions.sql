-- Existing rules were created before rule_dispositions was introduced. Seed the
-- missing current-version dispositions without touching any rows that already
-- carry a human decision (auto/proposing/manual-only).
WITH current_dispositions AS (
	SELECT
		r.id AS rule_id,
		json_each.value AS action
	FROM rules r
	INNER JOIN rule_versions rv ON rv.id = r.current_version_id
	CROSS JOIN json_each(
		CASE
			WHEN rv.tier = 'ai' THEN rv.action
			ELSE json_array(rv.action)
		END
	)
)
INSERT INTO rule_dispositions (
	id,
	rule_id,
	action,
	status,
	manual_only,
	created_at,
	updated_at
)
SELECT
	lower(hex(randomblob(16))),
	cd.rule_id,
	cd.action,
	'proposing',
	0,
	strftime('%s', 'now') * 1000,
	strftime('%s', 'now') * 1000
FROM current_dispositions cd
WHERE NOT EXISTS (
	SELECT 1
	FROM rule_dispositions rd
	WHERE rd.rule_id = cd.rule_id
		AND rd.action = cd.action
);
