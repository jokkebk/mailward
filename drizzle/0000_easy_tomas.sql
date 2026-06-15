CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`account_id` text NOT NULL,
	`rule_id` text,
	`rule_version_id` text,
	`thread_id` text NOT NULL,
	`message_ids` text,
	`action` text NOT NULL,
	`prior_state` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text,
	`mode` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`verdict` text,
	`note` text,
	`error` text,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	`rolled_back_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_actions_run` ON `actions` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_actions_run_rule` ON `actions` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE TABLE `rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`priority` integer NOT NULL,
	`match_criteria` text NOT NULL,
	`intent` text,
	`action` text NOT NULL,
	`tier` text DEFAULT 'deterministic' NOT NULL,
	`needs_body` integer DEFAULT false,
	`created_by` text DEFAULT 'human' NOT NULL,
	`change_note` text,
	`is_current` integer DEFAULT true,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rule_versions_rule` ON `rule_versions` (`rule_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'proposing' NOT NULL,
	`current_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`scope` text,
	`status` text DEFAULT 'running' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`from` text NOT NULL,
	`from_domain` text NOT NULL,
	`to` text,
	`subject` text,
	`snippet` text,
	`received_at` integer NOT NULL,
	`is_unread` integer DEFAULT true,
	`label_ids` text,
	`message_ids` text,
	`raw_headers` text,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`run_id` text,
	`verdict` text NOT NULL,
	`exclude_from_metric` integer DEFAULT false,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_verdicts_thread_version` ON `verdicts` (`thread_id`,`rule_version_id`);