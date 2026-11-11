import { sql } from "drizzle-orm";
import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Timestamps are ISO 8601 UTC text (PLAN §5).
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const id = () => integer("id").primaryKey({ autoIncrement: true });
const bool = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const CLONE_STATUSES = ["pending", "cloning", "ready", "error"] as const;
export const PRESETS = ["xcode", "node", "generic"] as const;

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  /** owner/name on GitHub. Cloned over HTTPS with the scoped token (PLAN §7.1). */
  repoSlug: text("repo_slug").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch"),
  localPath: text("local_path"),
  cloneStatus: text("clone_status", { enum: CLONE_STATUSES }).notNull().default("pending"),
  cloneError: text("clone_error"),
  /** Name of the Sentry login to use (SENTRY_AUTH_TOKEN[_<NAME>] in .env); never the token itself. */
  sentryConnection: text("sentry_connection").notNull().default("default"),
  sentryOrg: text("sentry_org").notNull(),
  sentryProject: text("sentry_project").notNull(),
  sentryQueryFilter: text("sentry_query_filter"),
  preset: text("preset", { enum: PRESETS }),
  /** Detected facts (schemes, test plans, simulators) shown on the settings page. */
  presetInfo: json<Record<string, unknown>>("preset_info"),
  setupCmd: text("setup_cmd"),
  buildCmd: text("build_cmd"),
  testCmd: text("test_cmd"),
  versionCmd: text("version_cmd"),
  scheduleCron: text("schedule_cron").notNull().default("0 6 * * *"),
  maxFixesPerRun: integer("max_fixes_per_run").notNull().default(2),
  maxBudgetUsdPerAttempt: real("max_budget_usd_per_attempt").notNull().default(5),
  maxOpenPrs: integer("max_open_prs").notNull().default(5),
  maxAttemptsPerIssue: integer("max_attempts_per_issue").notNull().default(2),
  impactThreshold: real("impact_threshold").notNull().default(5),
  maxDiffLines: integer("max_diff_lines").notNull().default(400),
  model: text("model").notNull().default("claude-opus-5-5"),
  prDraft: bool("pr_draft").notNull().default(true),
  sentryNotes: bool("sentry_notes").notNull().default(false),
  reviewAuthors: json<string[]>("review_authors"),
  maxRevisionsPerPr: integer("max_revisions_per_pr").notNull().default(3),
  feedbackPollMinutes: integer("feedback_poll_minutes").notNull().default(5),
  /** Set when "Test configuration" last passed; a project cannot be enabled before. */
  configTestedAt: text("config_tested_at"),
  configTestOk: bool("config_test_ok"),
  enabled: bool("enabled").notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const ISSUE_STATUSES = [
  "new",
  "triaged",
  "not_in_repo",
  "not_actionable",
  "low_impact",
  "fixed_unreleased",
  "ignored",
  "queued",
  "fixing",
  "pr_open",
  "merged",
  "awaiting_release",
  "verified_fixed",
  "regressed",
  "pr_closed",
  "attempt_failed",
  "needs_human",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const issueGroups = sqliteTable("issue_groups", {
  id: id(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  reasoning: text("reasoning").notNull(),
  createdBy: text("created_by", { enum: ["triage", "owner"] }).notNull(),
  locked: bool("locked").notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const issues = sqliteTable(
  "issues",
  {
    id: id(),
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sentryId: text("sentry_id").notNull(),
    shortId: text("short_id").notNull(),
    title: text("title").notNull(),
    culprit: text("culprit"),
    level: text("level"),
    category: text("category"),
    sentryUrl: text("sentry_url"),
    firstSeen: text("first_seen"),
    lastSeen: text("last_seen"),
    events14d: integer("events_14d").notNull().default(0),
    users14d: integer("users_14d").notNull().default(0),
    substatus: text("substatus"),
    firstRelease: text("first_release"),
    lastReleaseSeen: text("last_release_seen"),
    status: text("status", { enum: ISSUE_STATUSES }).notNull().default("new"),
    statusReason: text("status_reason"),
    /** Expected version for fixed_unreleased / awaiting_release (PLAN §5 rules). */
    expectedVersion: text("expected_version"),
    fixedByCommit: text("fixed_by_commit"),
    classification: text("classification"),
    impactScore: real("impact_score"),
    fixability: text("fixability", { enum: ["likely", "uncertain", "unlikely"] }),
    triageSummary: text("triage_summary"),
    relevantFiles: json<string[]>("relevant_files"),
    groupId: integer("group_id").references((): AnySQLiteColumn => issueGroups.id, { onDelete: "set null" }),
    pinned: bool("pinned").notNull().default(false),
    ignored: bool("ignored").notNull().default(false),
    baselineEventsPerDay: real("baseline_events_per_day"),
    verificationConfidence: text("verification_confidence", { enum: ["confirmed", "presumed"] }),
    /** Run id of the last triage that saw the issue in Sentry; older means unseen. */
    lastSeenRunId: integer("last_seen_run_id"),
    lastTriagedAt: text("last_triaged_at"),
    nextReviewAt: text("next_review_at"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("issues_project_sentry").on(t.projectId, t.sentryId), index("issues_status").on(t.status)],
);

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export const runs = sqliteTable("runs", {
  id: id(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
  requestedIssueId: integer("requested_issue_id").references(() => issues.id, { onDelete: "set null" }),
  dryRun: bool("dry_run").notNull().default(false),
  status: text("status", { enum: RUN_STATUSES }).notNull().default("queued"),
  cancelRequested: bool("cancel_requested").notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  summary: text("summary"),
  counts: json<Record<string, number>>("counts"),
  /** Selection table: why each candidate was or was not picked (PLAN §6.4.5). */
  selection: json<SelectionRow[]>("selection"),
  costUsd: real("cost_usd").notNull().default(0),
  error: text("error"),
});

export type SelectionRow = {
  issueId: number;
  shortId: string;
  groupId: number | null;
  score: number;
  selected: boolean;
  reason: string;
};

export const issueSnapshots = sqliteTable(
  "issue_snapshots",
  {
    id: id(),
    issueId: integer("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    capturedAt: text("captured_at").notNull().default(now),
    events14d: integer("events_14d").notNull(),
    users14d: integer("users_14d").notNull(),
    lastSeen: text("last_seen"),
    lastReleaseSeen: text("last_release_seen"),
  },
  (t) => [uniqueIndex("snapshots_issue_run").on(t.issueId, t.runId)],
);

export const ATTEMPT_STATUSES = [
  "running",
  "no_fix",
  "verify_failed",
  "pr_open",
  "merged",
  "closed_unmerged",
  "error",
] as const;

export const attempts = sqliteTable("attempts", {
  id: id(),
  issueId: integer("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
  number: integer("number").notNull(),
  status: text("status", { enum: ATTEMPT_STATUSES }).notNull().default("running"),
  baseSha: text("base_sha"),
  baseVersion: text("base_version"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  prState: text("pr_state"),
  mergeSha: text("merge_sha"),
  mergedAt: text("merged_at"),
  shipVersion: text("ship_version"),
  rootCause: text("root_cause"),
  fixSummary: text("fix_summary"),
  filesChanged: json<string[]>("files_changed"),
  confidence: text("confidence", { enum: ["high", "medium", "low"] }),
  buildOk: bool("build_ok"),
  testsOk: bool("tests_ok"),
  verifyLogPath: text("verify_log_path"),
  costUsd: real("cost_usd").notNull().default(0),
  turns: integer("turns").notNull().default(0),
  sessionId: text("session_id"),
  transcriptPath: text("transcript_path"),
  startedAt: text("started_at").notNull().default(now),
  finishedAt: text("finished_at"),
  error: text("error"),
});

export const attemptIssues = sqliteTable(
  "attempt_issues",
  {
    attemptId: integer("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
    issueId: integer("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    covered: bool("covered"),
  },
  (t) => [uniqueIndex("attempt_issues_pk").on(t.attemptId, t.issueId)],
);

export const attemptRevisions = sqliteTable("attempt_revisions", {
  id: id(),
  attemptId: integer("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  status: text("status", { enum: ["running", "pushed", "replied_only", "verify_failed", "error"] })
    .notNull()
    .default("running"),
  commitSha: text("commit_sha"),
  summary: text("summary"),
  replyCommentUrl: text("reply_comment_url"),
  costUsd: real("cost_usd").notNull().default(0),
  turns: integer("turns").notNull().default(0),
  sessionId: text("session_id"),
  transcriptPath: text("transcript_path"),
  startedAt: text("started_at").notNull().default(now),
  finishedAt: text("finished_at"),
  error: text("error"),
});

export const prFeedback = sqliteTable("pr_feedback", {
  id: id(),
  attemptId: integer("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
  githubId: text("github_id").notNull().unique(),
  kind: text("kind", { enum: ["review", "review_comment", "issue_comment"] }).notNull(),
  author: text("author").notNull(),
  reviewState: text("review_state"),
  path: text("path"),
  line: integer("line"),
  diffHunk: text("diff_hunk"),
  body: text("body"),
  createdAt: text("created_at").notNull(),
  /** False when the author is not in review_authors or is the harness itself: stored, never acted on. */
  actionable: bool("actionable").notNull().default(false),
  revisionId: integer("revision_id").references(() => attemptRevisions.id, { onDelete: "set null" }),
});

export const runEvents = sqliteTable(
  "run_events",
  {
    id: id(),
    runId: integer("run_id").references(() => runs.id, { onDelete: "cascade" }),
    jobId: integer("job_id"),
    issueId: integer("issue_id"),
    attemptId: integer("attempt_id"),
    ts: text("ts").notNull().default(now),
    stage: text("stage").notNull(),
    level: text("level", { enum: ["debug", "info", "warn", "error"] }).notNull().default("info"),
    message: text("message").notNull(),
    data: json<unknown>("data"),
  },
  (t) => [index("run_events_run").on(t.runId, t.id)],
);

export const notifications = sqliteTable("notifications", {
  id: id(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  issueId: integer("issue_id"),
  attemptId: integer("attempt_id"),
  runId: integer("run_id"),
  createdAt: text("created_at").notNull().default(now),
  readAt: text("read_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value"),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * Work queue shared by web and worker. The web process only inserts rows here
 * (or `runs` rows); the worker claims and executes them under the global lock.
 * Not in PLAN §5 explicitly; it is the "rows the worker picks up" of PLAN §9.
 */
export const JOB_KINDS = [
  "clone_project",
  "test_config",
  "run",
  "feedback_poll",
  "revise_pr",
  "health_check",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => runs.id, { onDelete: "cascade" }),
    payload: json<Record<string, unknown>>("payload"),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    result: json<unknown>("result"),
    error: text("error"),
  },
  (t) => [index("jobs_status").on(t.status, t.id)],
);

export type Project = typeof projects.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type IssueGroup = typeof issueGroups.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
