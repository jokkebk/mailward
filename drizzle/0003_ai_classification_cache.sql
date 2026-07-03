CREATE TABLE `ai_classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_ids` text,
	`action` text NOT NULL,
	`confidence` text NOT NULL,
	`reason` text,
	`source_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `ai_classifications` (
	`id`,
	`account_id`,
	`rule_id`,
	`rule_version_id`,
	`thread_id`,
	`message_ids`,
	`action`,
	`confidence`,
	`reason`,
	`source_run_id`,
	`created_at`,
	`updated_at`
)
SELECT
	p.`id`,
	p.`account_id`,
	p.`rule_id`,
	p.`rule_version_id`,
	p.`thread_id`,
	p.`message_ids`,
	p.`action`,
	COALESCE(p.`confidence`, 'low'),
	p.`reason`,
	p.`run_id`,
	p.`created_at`,
	COALESCE(p.`decided_at`, p.`created_at`)
FROM `proposals` p
WHERE
	p.`source` = 'ai'
	AND p.`rowid` = (
		SELECT p2.`rowid`
		FROM `proposals` p2
		WHERE
			p2.`source` = 'ai'
			AND p2.`account_id` = p.`account_id`
			AND p2.`rule_version_id` = p.`rule_version_id`
			AND p2.`thread_id` = p.`thread_id`
		ORDER BY p2.`created_at` DESC, p2.`rowid` DESC
		LIMIT 1
	);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_classifications_account_rule_thread` ON `ai_classifications` (`account_id`,`rule_version_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `idx_ai_classifications_rule_version` ON `ai_classifications` (`rule_version_id`);
