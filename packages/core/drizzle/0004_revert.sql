ALTER TABLE `change_log` ADD `group_id` integer;--> statement-breakpoint
ALTER TABLE `change_log` ADD `revertible` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `change_log_group_idx` ON `change_log` (`group_id`);