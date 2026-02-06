DROP TABLE IF EXISTS `messages`;--> statement-breakpoint
DROP TABLE IF EXISTS `chats`;--> statement-breakpoint
CREATE TABLE `wechat_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`account_dir` text NOT NULL,
	`db_name` text NOT NULL,
	`hex_key` text NOT NULL,
	`verified_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_wechat_keys` ON `wechat_keys` (`session_id`,`account_dir`,`db_name`);--> statement-breakpoint
CREATE INDEX `idx_wechat_keys_session_account` ON `wechat_keys` (`session_id`,`account_dir`);
