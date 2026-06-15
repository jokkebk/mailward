CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`account_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`rule_id` text,
	`rule_version_id` text,
	`rule_name` text,
	`batch_index` integer,
	`batch_total` integer,
	`current` integer DEFAULT 0,
	`total` integer,
	`matched_count` integer,
	`claimed_count` integer,
	`body_fetch_count` integer,
	`ai_batch_count` integer,
	`duration_ms` integer,
	`error` text,
	`metadata` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_steps_run` ON `run_steps` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_steps_run_status` ON `run_steps` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_run_steps_run_rule` ON `run_steps` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE TABLE `ai_call_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`account_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`batch_index` integer NOT NULL,
	`batch_total` integer NOT NULL,
	`thread_count` integer NOT NULL,
	`prompt_chars` integer DEFAULT 0 NOT NULL,
	`response_chars` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`response_tokens` integer,
	`total_tokens` integer,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ai_call_logs_run` ON `ai_call_logs` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_call_logs_run_rule` ON `ai_call_logs` (`run_id`,`rule_id`);
