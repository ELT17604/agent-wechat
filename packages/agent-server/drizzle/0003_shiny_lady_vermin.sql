PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`chat_id` text NOT NULL,
	`content_type` text NOT NULL,
	`content_text` text,
	`sender_name` text,
	`is_outgoing` integer DEFAULT false,
	`timestamp_display` text,
	`timestamp_parsed` text,
	`adjacent_text_before` text,
	`adjacent_text_after` text,
	`is_downloaded` integer DEFAULT false,
	`download_path` text,
	`metadata` text,
	`created_at` text DEFAULT '(datetime(''now''))',
	`updated_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "session_id", "chat_id", "content_type", "content_text", "sender_name", "is_outgoing", "timestamp_display", "timestamp_parsed", "adjacent_text_before", "adjacent_text_after", "is_downloaded", "download_path", "metadata", "created_at", "updated_at") SELECT "id", "session_id", "chat_id", "content_type", "content_text", "sender_name", "is_outgoing", "timestamp_display", "timestamp_parsed", "adjacent_text_before", "adjacent_text_after", "is_downloaded", "download_path", "metadata", "created_at", "updated_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_messages_chat` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_time` ON `messages` (`chat_id`,`timestamp_parsed`);--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`);