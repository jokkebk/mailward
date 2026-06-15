CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`account_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_ids` text,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text,
	`reason` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_proposals_run` ON `proposals` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_proposals_run_rule_thread` ON `proposals` (`run_id`,`rule_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `rule_dispositions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'proposing' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rule_dispositions_rule_action` ON `rule_dispositions` (`rule_id`,`action`);--> statement-breakpoint
ALTER TABLE `threads` ADD `has_unsubscribe` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `threads` ADD `is_calendar_invite` integer DEFAULT false;