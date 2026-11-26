ALTER TABLE `project_repos` ADD `default_branch` text;--> statement-breakpoint
ALTER TABLE `project_repos` ADD `last_seen_commit_at` text;--> statement-breakpoint
ALTER TABLE `project_repos` ADD `backfilled_at` text;--> statement-breakpoint
ALTER TABLE `project_repos` ADD `docs_github_sha` text;--> statement-breakpoint
ALTER TABLE `project_repos` ADD `docs_commits` text;--> statement-breakpoint
ALTER TABLE `project_repos` ADD `last_sync_error` text;