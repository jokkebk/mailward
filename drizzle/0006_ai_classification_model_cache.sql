ALTER TABLE `ai_classifications` ADD COLUMN `cache_key` text NOT NULL DEFAULT 'legacy';
--> statement-breakpoint
DROP INDEX `idx_ai_classifications_account_rule_thread`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_classifications_account_rule_thread_model` ON `ai_classifications` (`account_id`,`rule_version_id`,`thread_id`,`cache_key`);
