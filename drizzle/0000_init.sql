CREATE TABLE `attempt_issues` (
	`attempt_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`covered` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_issues_pk` ON `attempt_issues` (`attempt_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `attempt_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`commit_sha` text,
	`summary` text,
	`reply_comment_url` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`transcript_path` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`run_id` integer,
	`number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`base_sha` text,
	`base_version` text,
	`branch` text,
	`worktree_path` text,
	`pr_number` integer,
	`pr_url` text,
	`pr_state` text,
	`merge_sha` text,
	`merged_at` text,
	`ship_version` text,
	`root_cause` text,
	`fix_summary` text,
	`files_changed` text,
	`confidence` text,
	`build_ok` integer,
	`tests_ok` integer,
	`verify_log_path` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`transcript_path` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `issue_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`reasoning` text NOT NULL,
	`created_by` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`events_14d` integer NOT NULL,
	`users_14d` integer NOT NULL,
	`last_seen` text,
	`last_release_seen` text,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_issue_run` ON `issue_snapshots` (`issue_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`sentry_id` text NOT NULL,
	`short_id` text NOT NULL,
	`title` text NOT NULL,
	`culprit` text,
	`level` text,
	`category` text,
	`sentry_url` text,
	`first_seen` text,
	`last_seen` text,
	`events_14d` integer DEFAULT 0 NOT NULL,
	`users_14d` integer DEFAULT 0 NOT NULL,
	`substatus` text,
	`first_release` text,
	`last_release_seen` text,
	`status` text DEFAULT 'new' NOT NULL,
	`status_reason` text,
	`expected_version` text,
	`fixed_by_commit` text,
	`classification` text,
	`impact_score` real,
	`fixability` text,
	`triage_summary` text,
	`relevant_files` text,
	`group_id` integer,
	`pinned` integer DEFAULT false NOT NULL,
	`ignored` integer DEFAULT false NOT NULL,
	`baseline_events_per_day` real,
	`verification_confidence` text,
	`last_seen_run_id` integer,
	`last_triaged_at` text,
	`next_review_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `issue_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_project_sentry` ON `issues` (`project_id`,`sentry_id`);--> statement-breakpoint
CREATE INDEX `issues_status` ON `issues` (`status`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`project_id` integer,
	`run_id` integer,
	`payload` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`result` text,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`issue_id` integer,
	`attempt_id` integer,
	`run_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pr_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`github_id` text NOT NULL,
	`kind` text NOT NULL,
	`author` text NOT NULL,
	`review_state` text,
	`path` text,
	`line` integer,
	`diff_hunk` text,
	`body` text,
	`created_at` text NOT NULL,
	`actionable` integer DEFAULT false NOT NULL,
	`revision_id` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `attempt_revisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_feedback_github_id_unique` ON `pr_feedback` (`github_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`repo_slug` text NOT NULL,
	`repo_url` text NOT NULL,
	`default_branch` text,
	`local_path` text,
	`clone_status` text DEFAULT 'pending' NOT NULL,
	`clone_error` text,
	`sentry_org` text NOT NULL,
	`sentry_project` text NOT NULL,
	`sentry_query_filter` text,
	`preset` text,
	`preset_info` text,
	`setup_cmd` text,
	`build_cmd` text,
	`test_cmd` text,
	`version_cmd` text,
	`schedule_cron` text DEFAULT '0 6 * * *' NOT NULL,
	`max_fixes_per_run` integer DEFAULT 2 NOT NULL,
	`max_budget_usd_per_attempt` real DEFAULT 5 NOT NULL,
	`max_open_prs` integer DEFAULT 5 NOT NULL,
	`max_attempts_per_issue` integer DEFAULT 2 NOT NULL,
	`impact_threshold` real DEFAULT 5 NOT NULL,
	`max_diff_lines` integer DEFAULT 400 NOT NULL,
	`model` text DEFAULT 'claude-opus-5-5' NOT NULL,
	`pr_draft` integer DEFAULT true NOT NULL,
	`sentry_notes` integer DEFAULT false NOT NULL,
	`review_authors` text,
	`max_revisions_per_pr` integer DEFAULT 3 NOT NULL,
	`feedback_poll_minutes` integer DEFAULT 5 NOT NULL,
	`config_tested_at` text,
	`config_test_ok` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer,
	`job_id` integer,
	`issue_id` integer,
	`attempt_id` integer,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`stage` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`requested_issue_id` integer,
	`dry_run` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`summary` text,
	`counts` text,
	`selection` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
