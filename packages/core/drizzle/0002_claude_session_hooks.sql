ALTER TABLE `claude_sessions` ADD `last_worktree_hash` text;--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `testing_tool_use_id` text;--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `last_stop_at` text;--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `turns_since_nudge` integer;