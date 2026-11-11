# Sentry Autofix Harness: Implementation Plan

Audience: the agent implementing this project. Read the whole document before writing code. Sections 1–3 explain what we are building and why; sections 4–9 are the design; section 10 is the build order with acceptance criteria.

Project root: `/Users/crysfel/Workspace/ai/sentry-harness` (empty apart from this `docs/` folder).

---

## 1. Goal

A self-hosted harness that, once a day and for each registered project:

1. Pulls the latest issues from Sentry (through the Sentry MCP server).
2. Decides which issues are worth working on today, based on impact, and recognises the ones that are already fixed, already in progress, or not fixable by a code change.
3. For each selected issue, has a coding agent write a fix in a clone of the project's GitHub repository, verifies the fix builds and passes tests, and opens a pull request.
4. Records everything (issues, status, attempts, the app version each fix was tried on, logs, cost) in SQLite.
5. Notifies the owner inside a web dashboard, which also shows the status of every issue with links to the Sentry issue and the PR.

The harness is project-agnostic. Projects are added from the dashboard by giving a GitHub repository; the harness clones it and works on it. The first project is the Hymnal iOS app (section 3).

A day with nothing to do is a normal outcome. The run is still recorded, with the reason.

### Non-goals for v1

- Merging PRs, releasing apps, or resolving Sentry issues automatically. A human reviews and merges.
- Multi-user accounts and roles. There is one owner.
- Outbound notifications (email, Slack, push). The notification layer should make these easy to add later, but v1 is dashboard-only.
- Running on anything other than one macOS machine.

---

## 2. Decisions already made

These are settled. Do not revisit them without asking the owner.

| Area | Decision | Why |
|---|---|---|
| Language | TypeScript, Node (the machine has Node 26) | Owner's stack |
| Web | Next.js App Router + Tailwind, one app | Owner's stack |
| Database | SQLite via `better-sqlite3` + Drizzle ORM, WAL mode | Owner asked for SQLite; single machine; two processes read and write it |
| Agent runtime | The locally installed Claude Code CLI in headless mode (`claude -p`), spawned by the worker and using the machine's subscription login | Owner's choice; file tools, bash, MCP, permissions and sessions are built in. The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the same engine as a library and is the fallback |
| Sentry access | Sentry MCP server, used by the agent | Owner's requirement |
| GitHub access | `git` over HTTPS and the `gh` CLI, called by harness code, both using one fine-grained token limited to the registered repositories (section 7.1) | Deterministic, and the token limits what a compromised run can reach. No GitHub MCP server is used |
| PR review feedback | The worker polls open harness PRs for the owner's review comments and revises the PR (section 6.9) | The machine is not reachable from the internet, so polling replaces a webhook |
| Scheduling | A long-lived worker process with an in-process cron, kept alive by `launchd` | Lets the dashboard trigger runs through the same queue |
| Process layout | Two processes: `web` (Next.js) and `worker` (pipeline), sharing the SQLite file | Agent runs take many minutes and must not live inside a web request |
| Deployment | An Apple Silicon MacBook Pro with Xcode, always on | Needed to build and test iOS apps |

There is an unrelated older project at `/Users/crysfel/Workspace/ai/harness` (OpenAI, MySQL, website prospecting). Do not import from it or modify it. Its `README.md` and `docs/architecture.md` are worth a skim only for the "workflows are deterministic code, agents do bounded steps" idea, which this project also follows.

### The central design rule

**Deterministic code owns control flow and every side effect. Agents own judgment.**

- Code decides when a run starts, which stage is next, how state changes, what gets committed, pushed and opened as a PR.
- Agents are called for exactly two bounded jobs, triage and fix, and each returns a structured result validated with Zod.
- An agent never runs `git push`, `gh`, or anything else that leaves the machine. Sentry event data (messages, breadcrumbs, tags) is written by end users' devices and must be treated as untrusted input that could contain instructions. Keeping credentials and outward actions out of the agent's hands is what makes that safe.

---

## 3. First project: Hymnal iOS (facts verified on 2026-11-10)

Use these to configure the first project and as test data. Do not hard-code any of it; it all belongs in the project's row.

- Local working copy (the owner's, do not touch it): `/Users/crysfel/Workspace/Mobile Native Apps/hymnal`. The harness works on its own clone.
- Remote: `git@github.com:crysfel/hymnal-ios.git`, default branch `main`.
- Native Swift app, `hymnal.xcodeproj`, scheme `hymnal`, deployment target iOS 18.4, Swift packages (Sentry, KSCrash) resolved through SPM, so the first build needs network.
- Test plans in `TestPlans/`: `Unit`, `E2E-Smoke`, `E2E-Release`, `E2E-Spanish`, `Screenshots`. Only `Unit` is usable by the harness. The E2E plans need a test account and are out of scope.
- Version: `MARKETING_VERSION` in `hymnal.xcodeproj/project.pbxproj`, currently `6.3.3` on `main`. The owner bumps the version on `main` right after a release ("Bumping version to 6.3.3"), so the version on `main` at merge time is the version the fix will ship in.
- The repo has a `CLAUDE.md` describing its layout. The fix agent should pick it up automatically from the worktree.
- `sentry.properties` is git-ignored and will not exist in the harness's clone. It is only used for dSYM upload in Xcode Cloud; builds do not need it.
- Xcode Cloud builds only when something merges to `main`, not on pull requests. Harness PRs therefore cost no CI time, and there is no CI result on a PR: the harness's own build and test run (6.6) is the only automated check before the owner merges.
- Sentry: organization `peacefulhymns-backend`, project `himnario-mobile`. Release names look like `com.bleext.hymnal@6.3.2+21` (`bundleId@version+build`). Latest release with events: `6.3.2+21`.
- Sentry setup lives in `hymnal/Helpers/CrashReporting.swift`. Debug builds report nothing; production only.

### Two things about this Sentry project that shape triage

**It contains two different apps.** The same Sentry project receives events from the old React Native app (releases `5.x`, including Android) and the new native iOS app (releases `6.0.0` and later). Issues such as `IllegalArgumentException … com.swmansion.reanimated` or anything mentioning `rn-fetch-blob` come from code that is not in this repository. The project therefore needs a configurable Sentry query filter, and triage needs a `not_in_repo` outcome. For Hymnal the filter should restrict to releases ≥ 6.0.0 (Sentry search supports semver filters such as `release.version:>=6.0.0`; confirm the exact syntax against the live MCP before relying on it).

**Many top issues are app hangs and watchdog terminations.** These often have idle or system-only stack traces and no single-line fix. The agent must be free to conclude "not actionable from this evidence" without that counting as a failure.

Top unresolved issues by users over 14 days, as a reference for what triage should produce:

| Short ID | Title | Users | Expected triage |
|---|---|---|---|
| HIMNARIO-MOBILE-WK | App Hang Non Fully Blocked, 2.4–3.2 s | 128 | Investigate; check whether commits on `main` after 6.3.2 already address it |
| HIMNARIO-MOBILE-Y3 | App Hang Fully Blocked, 13 s (escalating, new in 6.3.2) | 31 | High priority: new and escalating |
| HIMNARIO-MOBILE-XQ | `SupportStore.ProductsError: noneReturned` | 18 | Candidate; may be an App Store configuration problem rather than code |
| HIMNARIO-MOBILE-FG | `IllegalArgumentException` in `com.swmansion.reanimated` | 16 | `not_in_repo` (legacy Android app) |
| HIMNARIO-MOBILE-WN | Fatal App Hang Fully Blocked | 14 | Candidate |
| HIMNARIO-MOBILE-R | SIGSEGV | 7 | Candidate if the stack has app frames |
| HIMNARIO-MOBILE-X1 | WatchdogTermination (RAM) | 5 | Likely `not_actionable` |
| HIMNARIO-MOBILE-9 | "The Internet connection appears to be offline" via `rn-fetch-blob` | 5 | `not_in_repo` |

`main` already contains unreleased fixes aimed at hangs ("Disabling autocorrect to prevent hangs", "Debouncing the search", "Taking disk and keychain writes off the launch path"). Recognising that an issue is probably fixed by a commit that has not shipped yet is a core requirement, not an edge case.

---

## 4. Architecture

```
                    ┌──────────────────────────── Mac (launchd, user session) ───────────────────────────┐
                    │                                                                                    │
  Browser ── HTTP ──┤  web  (Next.js)  ── reads/writes ──┐                                               │
                    │   dashboard, server actions        │                                               │
                    │   inserts "run requested" rows     ▼                                               │
                    │                              SQLite (WAL)   data/harness.db                        │
                    │                                    ▲                                               │
                    │  worker (Node)   ── reads/writes ──┘                                               │
                    │   cron tick → queue run                                                            │
                    │   pipeline:  reconcile → triage → fix → verify → publish → notify                  │
                    │        │            │                │         │                                   │
                    │        │            └─ Agent SDK ────┘         └─ git push, gh pr create           │
                    │        │                 ├─ Sentry MCP (read)                                      │
                    │        │                 └─ file tools + allow-listed bash in a git worktree       │
                    │        └─ gh pr view (PR state), Sentry (release data via triage)                  │
                    └────────────────────────────────────────────────────────────────────────────────────┘
```

### Repository layout

```
sentry-harness/
  docs/PLAN.md
  package.json                 one package; scripts for web, worker, db
  drizzle.config.ts
  drizzle/                     generated migrations (committed)
  data/                        git-ignored: harness.db, repos/, worktrees/, transcripts/, logs/
  src/
    db/        schema.ts, client.ts, queries/
    core/      config.ts (Zod env), logger.ts, shell.ts (spawn wrapper with timeout + captured output)
    projects/  clone.ts, presets.ts (xcode, node, generic), version.ts
    sentry/    mcp-config.ts
    agents/    runner.ts (Agent SDK wrapper), triage.ts, fix.ts, prompts/, schemas.ts
    pipeline/  run.ts, reconcile.ts, triage-stage.ts, select.ts, fix-stage.ts, verify.ts, publish.ts
    github/    git.ts, gh.ts
    notify/    notify.ts
    worker/    index.ts (scheduler + queue loop), lock.ts
  app/                         Next.js App Router (dashboard)
  tests/
  ops/                         launchd plists, install script, setup checklist
```

The web app imports from `src/db` and `src/projects` only. It never imports the pipeline or the agent code.

### Next.js caution

The version of Next.js that `npm` installs today is newer than most training data, and its conventions have changed. Before writing dashboard code, read the guides shipped in `node_modules/next/dist/docs/` and follow them over memory.

---

## 5. Data model (SQLite)

Drizzle schema, migrations generated and committed. Timestamps are ISO 8601 UTC text. Enable `journal_mode = WAL` and a `busy_timeout` on every connection, since two processes write.

**projects**: `id`, `name`, `repo_url` (SSH), `default_branch`, `local_path`, `clone_status` (`pending` | `cloning` | `ready` | `error`), `clone_error`, `sentry_org`, `sentry_project`, `sentry_query_filter` (extra search terms, e.g. the release filter), `preset` (`xcode` | `node` | `generic`), `setup_cmd`, `build_cmd`, `test_cmd`, `version_cmd`, `schedule_cron` (default `0 6 * * *`, local time), `max_fixes_per_run` (default 2), `max_budget_usd_per_attempt` (default 5), `max_open_prs` (default 5), `model`, `pr_draft` (default true), `enabled`.

**issues**: one row per Sentry issue per project. `project_id`, `sentry_id`, `short_id`, `title`, `culprit`, `level`, `category`, `sentry_url`, `first_seen`, `last_seen`, `events_14d`, `users_14d`, `substatus` (`new` | `ongoing` | `escalating` | `regressed`), `first_release`, `last_release_seen`, `status` (state machine below), `status_reason`, `impact_score`, `fixability` (`likely` | `uncertain` | `unlikely`), `triage_summary`, `pinned` (owner forces work on it), `ignored` (owner says never), `last_triaged_at`, `next_review_at`. Unique on (`project_id`, `sentry_id`).

**issue_snapshots**: `issue_id`, `run_id`, `captured_at`, `events_14d`, `users_14d`, `last_seen`, `last_release_seen`. One per issue per run. This is how the dashboard shows a trend and how the harness sees that an issue stopped occurring.

**attempts**: one row per fix attempt. `issue_id`, `run_id`, `number` (1, 2, … per issue), `status` (`running` | `no_fix` | `verify_failed` | `pr_open` | `merged` | `closed_unmerged` | `error`), `base_sha`, `base_version` (app version at the base commit: this is "the version the fix was tried on"), `branch`, `pr_number`, `pr_url`, `pr_state`, `merge_sha`, `merged_at`, `ship_version` (version the fix is expected to ship in), `root_cause`, `fix_summary`, `files_changed` (JSON), `confidence` (`high` | `medium` | `low`), `build_ok`, `tests_ok`, `verify_log_path`, `cost_usd`, `turns`, `session_id`, `transcript_path`, `started_at`, `finished_at`, `error`.

**runs**: `project_id`, `trigger` (`schedule` | `manual`), `requested_issue_id` (set when the owner asked for a specific issue), `dry_run`, `status` (`queued` | `running` | `succeeded` | `failed` | `cancelled`), `started_at`, `finished_at`, `summary` (one human sentence, e.g. "12 issues synced, 1 new, nothing worth fixing today"), `counts` (JSON), `cost_usd`, `error`.

**run_events**: the log. `run_id`, `issue_id?`, `attempt_id?`, `ts`, `stage`, `level`, `message`, `data` (JSON). Append-only. Every stage transition, every decision with its reason, every shell command with exit code and duration, and a line per agent tool call.

**notifications**: `project_id`, `kind`, `title`, `body`, `link` (dashboard path), `issue_id?`, `attempt_id?`, `run_id?`, `created_at`, `read_at`.

**settings**: key/value for global settings.

**issue_groups**: issues that triage believes share one root cause. `project_id`, `title`, `reasoning`, `created_by` (`triage` | `owner`), `locked` (the owner edited it; triage must not regroup). `issues.group_id` is a nullable reference to it.

**attempt_issues**: join table (`attempt_id`, `issue_id`, `covered`). An attempt has one primary issue (`attempts.issue_id`) and may cover every issue in its group. `covered` records whether the fix agent says its change actually addresses that issue.

**attempt_revisions**: one row per revision of an open PR in response to review feedback. `attempt_id`, `number`, `status` (`running` | `pushed` | `replied_only` | `verify_failed` | `error`), `commit_sha`, `summary`, `reply_comment_url`, `cost_usd`, `turns`, `session_id`, `transcript_path`, `started_at`, `finished_at`, `error`.

**pr_feedback**: every review comment the harness has seen on its PRs. `attempt_id`, `github_id` (unique), `kind` (`review` | `review_comment` | `issue_comment`), `author`, `review_state`, `path`, `line`, `diff_hunk`, `body`, `created_at`, `revision_id` (the revision that handled it, null while pending).

Additional columns implied by sections 6.3 and 6.9: on **issues**, `baseline_events_per_day` (frozen when the fix merges) and `verification_confidence` (`confirmed` | `presumed`); on **projects**, `review_authors` (JSON list of GitHub logins whose comments the harness acts on, default the repository owner), `max_revisions_per_pr` (default 3), `feedback_poll_minutes` (default 5).

### Issue state machine

```
                       ┌─────────────► not_in_repo        (code is not in this repository)
                       ├─────────────► not_actionable     (no code fix evident; re-reviewed later)
                       ├─────────────► low_impact         (below threshold; re-scored every run)
 new ──► triaged ──────┼─────────────► fixed_unreleased   (a commit on the default branch likely fixes it)
                       ├─────────────► ignored            (owner's decision; never touched again)
                       └──► queued ──► fixing ──► pr_open ──► merged ──► awaiting_release ──► verified_fixed
                                         │           │                                   └──► regressed ──► (back to triaged)
                                         │           └──► pr_closed  (owner rejected; no automatic retry)
                                         └──► attempt_failed  (retry allowed up to max attempts, then needs_human)
```

Rules:

- Only code changes `status`. The triage agent proposes; `select.ts` disposes.
- `fixed_unreleased` and `awaiting_release` both carry a version and both resolve the same way during reconcile (section 6.1).
- `not_actionable` and `low_impact` are not terminal. They are re-evaluated when the numbers change materially or `next_review_at` passes.
- An issue with an open PR is never selected again. Neither is any issue in the same group as one with an open PR.
- Issues in a group that an attempt covers move through `fixing`, `pr_open`, `merged` and `awaiting_release` together. From there each issue is verified on its own (6.3), since a fix may resolve some of them and not others.
- While a PR is being revised (6.9) the issue stays `pr_open`; the revision has its own status.
- `pr_closed` is a human "no". The issue is only retried if the owner presses Retry.
- Default maximum of 2 attempts per issue before `needs_human`.

---

## 6. The daily pipeline

One run per project. A global lock ensures one run at a time on the machine, because simulators and Xcode's build system do not share well. Every stage writes `run_events`.

### 6.1 Reconcile (deterministic, no agent)

1. `git fetch` the project's clone and fast-forward the default branch.
2. For each attempt with `pr_open`: `gh pr view <n> --json state,mergedAt,mergeCommit`.
   - Merged: set attempt `merged`, record `merge_sha` and `merged_at`, compute `ship_version` by running `version_cmd` at the merge commit, set issue `awaiting_release`. Notify.
   - Closed without merging: attempt `closed_unmerged`, issue `pr_closed`. Notify.
3. Verification of `awaiting_release` and `fixed_unreleased` issues happens after triage, because it needs the fresh Sentry data (6.3).

### 6.2 Triage (agent, read-only)

One agent session per run.

- Working directory: the project's clone at the tip of the default branch.
- Tools: Sentry MCP read tools only (`search_issues`, `get_sentry_resource`, `get_issue_details`, `get_event_stacktrace`, `get_issue_tag_values`, `find_releases`, `search_issue_events`), plus `Read`, `Grep`, `Glob`, and `Bash` restricted to read-only git (`git log`, `git show`, `git blame`, `git diff`).
- Input in the prompt: Sentry org and project, the query filter, the repo's current version and the last 30 commit subjects on the default branch, and the harness's current knowledge of every non-terminal issue (status, last attempt, PR link) so the agent does not rediscover it.
- Task: list unresolved issues active in the last 14 days (sorted by users, and separately those first seen in the last 24 hours and those escalating or regressed), list recent releases, and for each issue that is new to the harness or whose numbers changed, look at the stack trace and the code and classify it.
- Output (Zod-validated JSON):

```ts
{
  latestRelease: { version: string, firstEventAt: string } | null,
  issues: Array<{
    sentryId: string, shortId: string, title: string, url: string,
    culprit: string | null, level: string, substatus: string,
    events14d: number, users14d: number, firstSeen: string, lastSeen: string,
    firstRelease: string | null, lastReleaseSeen: string | null,
    classification: "candidate" | "not_in_repo" | "not_actionable" | "likely_fixed_unreleased",
    fixability: "likely" | "uncertain" | "unlikely",
    fixedByCommit: string | null,       // sha, when likely_fixed_unreleased
    reasoning: string,                  // 2–4 sentences, shown in the dashboard
    relevantFiles: string[],
  }>,
  groups: Array<{                       // issues believed to share one root cause
    title: string,
    sentryIds: string[],                // two or more
    reasoning: string,                  // what in the stack traces or code ties them together
  }>
}
```

**Grouping is required.** Sentry splits what is one bug into several issues, most visibly app hangs, which it groups by duration (WK, Y3 and WN in section 3 all report hangs at `HymnalApp.$main`). Without grouping the harness would open several PRs for one cause. The triage agent must compare stack traces, breadcrumbs and the code paths involved, and group issues only when it can state the shared cause; similar titles are not enough. The harness stores groups in `issue_groups`, keeps existing groups stable between runs (the prompt includes current groups), and never changes a group the owner has locked.

Facts (counts, dates, releases) come from Sentry and are copied, not estimated. The harness upserts `issues`, writes `issue_snapshots`, and marks issues that no longer appear as unseen for this run.

Keep the cost down: the agent should only open stack traces for issues that are new, changed, or due for review. Pass it the list that needs a deep look and tell it to copy numbers for the rest.

### 6.3 Verify shipped fixes (deterministic)

For each issue in `awaiting_release` or `fixed_unreleased`, with its expected version `V`:

- No Sentry release ≥ `V` has events yet: stay.
- The issue has events in a release ≥ `V`: `regressed`, back to `triaged` with the prior attempt attached as context. Notify, because it means a merged fix did not work.
- Otherwise, decide whether the silence is long enough to mean something. **The waiting period must scale with how often the issue used to occur**; a fixed number of days is wrong for rare issues.
  - `baseline_events_per_day` is the issue's average daily event count over the 14 days before the fix merged, taken from `issue_snapshots` and frozen at merge time.
  - `observed_days` is the number of days since a release ≥ `V` first had events.
  - `expected = baseline_events_per_day × observed_days` is how many events we would have seen by now if nothing had changed.
  - `expected ≥ 5` and `observed_days ≥ 3`, with no events in releases ≥ `V`: `verified_fixed` with `verification_confidence = confirmed`. (Seeing zero events when five were expected happens by chance less than 1% of the time.)
  - `observed_days ≥ 30` and still below 5 expected: `verified_fixed` with `verification_confidence = presumed`. The dashboard shows presumed fixes differently and says why.
  - Otherwise stay in `awaiting_release` and show progress ("2.1 of 5 expected events observed without a recurrence").
- This ignores how quickly users adopt the new release, so early days overstate `expected`. That is acceptable for v1 because of the 3-day minimum; note it in the code as the first thing to refine.

Compare versions as semver on the part between `@` and `+`. Keep the thresholds (5, 3 days, 30 days) in one tested module.

### 6.4 Select (deterministic)

1. Score every `candidate`:

   `impact = users14d × severity × trend`

   where `severity` is 3 for crashes and fatal hangs, 2 for non-fatal hangs, 1 otherwise; `trend` is 1.5 if `escalating`, `regressed`, or first seen in the latest release, else 1. Keep the weights in one small module with unit tests; they will be tuned.
   A group is selected as one unit. Its score is the sum of its candidates' scores (users may be counted twice across issues; that is fine for ranking), and its primary issue is the member with the highest score. One selected group uses one slot of `max_fixes_per_run` and produces one attempt and one PR.
2. Drop: `ignored`, has an open PR (or shares a group with one), attempts exhausted, `fixability = unlikely`, score below the project threshold (default 5).
3. `pinned` issues go first regardless of score.
4. Take the top `max_fixes_per_run`, reduced if the project already has `max_open_prs` open. Unreviewed PRs piling up is a signal to stop producing more.
5. Record for every candidate why it was or was not selected. If nothing is selected, the run ends as `succeeded` with a summary that says so.

### 6.5 Fix (agent, writes only inside a worktree)

For each selected issue, sequentially:

1. Create a worktree from the default branch tip: `data/worktrees/<project>/<shortId>-<attempt>` on branch `autofix/<shortid-lowercase>-<attempt>`. Insert the `attempts` row with `base_sha` and `base_version`.
2. Run `setup_cmd` if set.
3. Start a fix agent session.
   - Working directory: the worktree.
   - Tools: `Read`, `Edit`, `Write`, `Grep`, `Glob`; `Bash` allow-listed to the project's build and test commands and read-only git; Sentry MCP read tools so it can pull events, breadcrumbs and tag distributions for this one issue.
   - Explicitly denied: `git commit`, `git push`, `gh`, network tools, anything outside the worktree.
   - Limits: turn cap, `max_budget_usd_per_attempt`, wall-clock timeout (default 45 min).
   - Prompt content: the issue (link, numbers, triage reasoning), prior attempts on this issue and why they failed or were rejected, the build and test commands, and the rules below.
   - Rules given to the agent: find the root cause before editing; make the smallest change that fixes it; follow the repository's existing conventions and its `CLAUDE.md`; add or update a unit test when the code is testable; do not bump versions, touch dependencies, or reformat unrelated code; if the evidence does not support a confident fix, stop and say so instead of guessing.
   - When the issue belongs to a group, the prompt lists every issue in it, and the agent is told to fix the shared cause and to report which issues its change actually addresses. If it finds the issues do not share a cause, it fixes the primary one and says so; the harness then removes the others from the group.
   - Output: `{ outcome: "fixed" | "no_fix" | "needs_human", rootCause, summary, confidence, testsAdded: boolean, coveredSentryIds: string[], notes }`.
4. `no_fix` or `needs_human`: record it, remove the worktree, set the issue to `not_actionable` or `needs_human`. This is a normal result.

### 6.6 Verify (deterministic)

The harness, not the agent, runs `build_cmd` and then `test_cmd` in the worktree, with a timeout, capturing output to `verify_log_path`.

- Both pass and `git diff` is non-empty: continue to publish.
- Failure: resume the same agent session once with the tail of the failing output and ask it to repair. Verify again. A second failure ends the attempt as `verify_failed`; no PR is opened.
- Sanity checks on the diff before publishing: non-empty, under a size limit (default 400 changed lines), no changes to lockfiles, signing settings, CI scripts or secrets unless the project allows it. A violation ends the attempt as `verify_failed` with the reason.

### 6.7 Publish (deterministic)

1. `git add -A && git commit` in the worktree, authored as the machine's git user. Subject in the repository's style (Hymnal uses short gerund subjects such as "Debouncing the search"); body references the Sentry short ID.
2. `git push -u origin <branch>`.
3. `gh pr create` against the default branch, as a draft if `pr_draft`, with label `autofix` (create the label if missing). Body template:

   ```
   ## Sentry issue
   <SHORT-ID>: <title>
   <sentry url> · <users> users, <events> events in 14 days · first seen in <release>

   ## Root cause
   …
   ## Fix
   …
   ## Verification
   Build: passed · Tests: passed (<n> tests, <n> added)
   Based on <base_version> (<base_sha>) · Confidence: <level> · Attempt <n>

   Opened by sentry-harness. This fix has not been run on a device.
   ```
4. Update the attempt (`pr_open`, URL, number) and the issue. Remove the worktree; the branch lives on the remote.
5. Optional, off by default per project: add a note to the Sentry issue with the PR link (`add_issue_note`). Never resolve or assign Sentry issues.

### 6.8 Notify

Insert `notifications` rows for: PR opened, PR merged, PR closed, fix verified in a release, regression after a merged fix, attempt failed, run failed, and one daily summary per run (including quiet days). The notifier is a small interface with one implementation (database). Outbound channels can be added behind it later.

### 6.9 PR review feedback loop

The owner reviews harness PRs on GitHub like any other PR. When they leave comments, the harness revises the PR and replies. This runs outside the daily pipeline, as its own job type on the worker's queue, under the same global lock.

**Detection: polling, not a webhook.** GitHub can only deliver webhooks to a public URL, and the MacBook sits behind a home network. Polling a handful of open PRs every few minutes is simple, has no moving parts, and exposes nothing. Every `feedback_poll_minutes` the worker, for each attempt with `pr_open`:

1. Fetches reviews, inline review comments and top-level PR comments with `gh api` (`/pulls/{n}/reviews`, `/pulls/{n}/comments`, `/issues/{n}/comments`).
2. Stores any it has not seen in `pr_feedback`, keyed by GitHub's id.
3. Ignores comments written by the harness's own GitHub identity and by anyone not in the project's `review_authors`. Comment text goes into an agent prompt, so on a public repository an unknown commenter must never be able to steer the agent.
4. Queues a revision job when there is pending feedback that is a request: a submitted review in state "changes requested" or "commented", or a top-level comment. Wait until the newest pending comment is at least 2 minutes old, so a review written as several separate comments is handled once.

An approval with no comments is not feedback. Merging and closing are handled by reconcile (6.1); run the reconcile PR-state check on this same poll so merges are noticed within minutes instead of the next morning.

A real webhook can be added later without changing anything else: a route in the web app that verifies GitHub's signature and queues the same poll immediately, exposed through something like Tailscale Funnel. Do not build it in v1.

**Revision job:**

1. Create a worktree from the PR's remote branch. Insert an `attempt_revisions` row.
2. Run the fix agent with the same tools and restrictions as 6.5. Resume the attempt's original session if it can still be resumed; otherwise start a new one with the root cause, fix summary and current diff. The prompt contains each pending comment with its file, line and diff hunk.
3. The agent addresses every comment, either by changing code or by explaining why it should not change. Output: `{ outcome: "revised" | "reply_only" | "needs_human", summary, responses: Array<{ githubId, action: "changed" | "declined" | "answered", reply }> }`.
4. If code changed, verify exactly as in 6.6. On failure after one repair round, push nothing.
5. Publish: commit on top of the branch and push (never force-push; the owner may have the branch checked out). Then post one PR comment summarising what changed and replying to each comment by quoting it. If verification failed, say so in the comment instead of pushing broken code.
6. Mark the handled `pr_feedback` rows with the revision id. Notify ("PR revised" or "Revision failed").

**Limits:** at most `max_revisions_per_pr` revisions per PR. After that the harness comments once that it has stopped, sets the issue to `needs_human`, and notifies. A revision job never changes which issues the attempt covers.

### Failure handling

- Any stage can throw. The run is marked `failed` with the error, the attempt (if any) `error`, worktrees are cleaned up in a `finally`, and a notification is written.
- On worker start, any `running` run or attempt left by a crash is marked `failed` with "interrupted", and stale worktrees are removed. Do not try to resume mid-run in v1; the next scheduled run picks the issue up again.
- Every shell command goes through one wrapper that enforces a timeout, captures output, and never interpolates untrusted strings into a shell line (pass argument arrays).

---

## 7. Agent runtime

Wrap the `claude` CLI in `src/agents/runner.ts` so the rest of the code depends on a small interface:

```ts
runAgent({
  cwd, systemPrompt, prompt, model,
  mcpServers, allowedTools, disallowedTools,
  outputSchema,            // Zod; the runner validates and returns typed output
  maxTurns, maxBudgetUsd, timeoutMs,
  resumeSessionId?,        // for the repair round
  onEvent,                 // each SDK message → run_events + transcript file
}): Promise<{ output, sessionId, costUsd, turns }>
```

Implementation notes:

- **Read `claude --help` and the Claude Code headless documentation first** and take flag names and the stream format from them, not from memory. The capabilities this plan depends on are: setting the working directory (spawn with `cwd`), passing MCP server configuration, allow and deny lists for tools including per-command Bash rules, a non-interactive permission mode, turn and budget limits, structured output against a JSON schema, session resume, and a stream of messages that includes tool calls and a final result.
- These flags were confirmed present on the dev machine (Claude Code 2.1.322): `claude -p` with `--output-format stream-json`, `--json-schema`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--max-budget-usd`, `--model`, `--resume`. Their exact behaviour was not exercised; test each one in M2.
- The Agent SDK (`https://code.claude.com/docs/en/agent-sdk`) offers the same capabilities in-process and can replace the CLI behind the same `runAgent` interface if needed.
- Do not load the user's global MCP servers or settings into harness sessions. Pass the Sentry MCP config explicitly and use the strict option so sessions are reproducible.
- Model: default `claude-opus-5-5` for both agents, stored per project so the owner can change it.
- Save each session's full message stream as JSONL under `data/transcripts/` and link it from the attempt. Write a condensed line per tool call to `run_events` so the dashboard can show progress live.
- Tests never call the model. Put a fake `runAgent` behind the interface and drive the pipeline with canned outputs.

### Authentication on the deployment machine

Three credentials, all set up once by the owner (see `ops/` checklist in milestone 6):

- **Claude**: the owner wants to use the Claude Code installation and subscription login on the machine, not an API key. Implement `runAgent` by spawning the local `claude` CLI in headless mode (`claude -p`, flags listed above), which uses whatever login that machine has. For the unattended worker, the owner runs `claude setup-token` once on the MacBook (it creates a long-lived token and requires a Claude subscription); check `claude setup-token --help` and the Claude Code docs for how the token is supplied to a non-interactive process, and put it in the worker's environment in the launchd plist. Make sure `ANTHROPIC_API_KEY` is not set in the worker's environment, or it will take precedence and bill the API instead. Keep the `runAgent` interface so an API key or the Agent SDK can be swapped in later.
  - Subscription usage limits are shared with the owner's interactive use. When a session ends because a limit was hit, record the attempt as `error` with that reason, stop the run without retrying, and notify. The per-attempt dollar cap may not be meaningful under a subscription, so the turn cap and wall-clock timeout are the limits that matter.
- **Sentry MCP**: the hosted server at `https://mcp.sentry.dev/mcp` uses an interactive OAuth login, which is awkward for an unattended process. The `@sentry/mcp-server` npm package can run as a local stdio server with a Sentry user auth token; that is the expected choice here. Verify its current flags and required token scopes in its README. Read-only scopes are enough unless Sentry notes are enabled.
- **GitHub**: one fine-grained personal access token, described in 7.1. Not the owner's SSH key and not a classic `repo`-scoped token.

Secrets live in `.env` (git-ignored, mode 600), never in SQLite, never in logs, and never in a prompt.

### 7.1 Isolation requirements

Keeping `git push` and `gh` out of the agent's tool list is not enough on its own. The harness builds the project and runs its tests after the agent has edited them, and those run as ordinary processes on the Mac. A build script or a unit test can read any file the harness's user can read. Since the agent's input includes Sentry data written by end users' devices, assume that one day a run will execute code nobody intended. The requirement is that such a run can reach very little.

1. **Dedicated macOS account.** The harness runs under its own standard (non-admin) user, created for this purpose and set as the auto-login account. The owner's personal account, SSH keys, keychain, browser sessions and other repositories are not on it. The `ops/` checklist creates this account first.
2. **Scoped GitHub token.** A fine-grained personal access token restricted to the registered repositories, with read/write on Contents and Pull requests and nothing else (confirm against GitHub's docs whether creating the `autofix` label needs Issues write; if so, have the owner create the label once instead of widening the token). The worker uses it for both `git` (HTTPS remote with a credential helper that reads the token from the environment) and `gh` (`GH_TOKEN`). No SSH key is installed on the account.
3. **Token access is checked when a project is added.** The token must be extended by the owner each time a repository is registered. The add-project flow verifies access before cloning and gives an exact message when it is missing.
4. **Branch protection.** The setup checklist asks the owner to protect each default branch (require a pull request). With that in place, the token cannot change `main` even if it leaks.
5. **Scrubbed environment for anything that runs project code.** The shell wrapper starts `setup_cmd`, `build_cmd`, `test_cmd` and the agent process with an explicit, minimal environment: no `GH_TOKEN`, no Sentry token, no harness `.env`. The agent process receives only its Claude credential and the Sentry MCP's read-only token.
6. **Read-only Sentry token.** Scopes limited to reading issues, events and releases, unless the project has Sentry notes switched on.
7. **Confinement of the agent.** In addition to the tool allow-list, use Claude Code's sandboxing for Bash if the installed version offers it, restricted to the worktree and the build cache. Check the Claude Code docs; if it is not available on macOS, record that in the README as a known limit.

State the residual risk plainly in the README: project code runs as the harness user and can read that user's files, including the `.env`. The points above bound the damage to "the scoped token and a read-only Sentry token leak"; they do not make it impossible.

Tests for this section: the shell wrapper test asserts that a child process cannot see `GH_TOKEN`; the health check page reports the token's repository list and warns if a default branch is unprotected.

---

## 8. Projects and presets

Adding a project from the dashboard:

1. Form: GitHub repository (`owner/name` or URL), Sentry organization and project slugs, optional Sentry query filter.
2. The web app inserts the row with `clone_status = pending`. The worker first checks that the GitHub token can read and push to the repository (7.1), then clones it into `data/repos/<id>` over HTTPS and detects the default branch. `review_authors` defaults to the repository owner's login.
3. The worker detects a preset and pre-fills commands, which the owner confirms or edits in the project's settings page:
   - **xcode** (an `.xcodeproj` or `.xcworkspace` exists): list schemes and test plans with `xcodebuild -list`; propose build and test commands against an available simulator; `version_cmd` reads `MARKETING_VERSION`.
   - **node** (`package.json`): `npm ci`, `npm run build` if present, `npm test`; version from `package.json`.
   - **generic**: empty commands the owner must fill in.
4. "Test configuration" button: queues a job that runs setup, build and test on a clean worktree and reports the result. A project cannot be enabled until this passes once.

Proposed Hymnal commands, to be validated by actually running them in milestone 3:

```
build:   xcodebuild build -project hymnal.xcodeproj -scheme hymnal \
           -destination 'platform=iOS Simulator,name=iPhone 16 Pro' CODE_SIGNING_ALLOWED=NO
test:    xcodebuild test -project hymnal.xcodeproj -scheme hymnal -testPlan Unit \
           -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -parallel-testing-enabled NO
version: read MARKETING_VERSION for the hymnal target
filter:  release.version:>=6.0.0
```

Use a per-project `-derivedDataPath` under `data/` so builds are cached between runs and do not collide with the owner's own Xcode use.

---

## 9. Dashboard

Server components reading SQLite directly; server actions for mutations; client-side polling every few seconds on pages that show a live run. Tailwind for styling. Dense, readable, table-first. It is an operations tool, not a marketing page.

| Route | Contents |
|---|---|
| `/` | Per project: last run and its summary sentence, next scheduled run, counts by status, items needing attention (open PRs awaiting review, failed attempts, regressions). "Run now" button. |
| `/issues` | Table of all issues across projects: short ID (links to Sentry), title, status badge, users and events (14 d) with trend from snapshots, impact score, last attempt, PR link, version (base or ship). Filters by project and status; search; sort. |
| `/issues/[id]` | Header with Sentry and PR links. Triage reasoning. Group: the related issues and why they are grouped, with Remove from group and Add to group (either locks the group). Timeline of status changes. Each attempt: base version and commit, issues covered, root cause, fix summary, files changed, build and test results, cost, link to transcript and verify log; under it, each revision with the review comments it answered and the reply posted. For `awaiting_release`: verification progress (expected events observed so far). Actions: Pin, Ignore, Retry, Fix now. |
| `/runs` | The daily log: one row per run with date, trigger, status, summary, counts, cost, duration. Quiet days appear here. |
| `/runs/[id]` | Stage-by-stage event log, live while running. Selection table showing why each candidate was or was not picked. Cancel button. |
| `/projects` | List, add form, clone status. |
| `/projects/[id]` | Settings: Sentry slugs and filter, commands, schedule, caps, model, draft PRs, enabled. "Test configuration". |
| `/notifications` | List with read/unread; a bell with unread count in the header on every page; "mark all read". |
| `/settings` | Health checks run by the worker: `claude` reachable, Sentry MCP reachable, `gh` authenticated, `git` SSH works, Xcode and simulator present, disk space. Global defaults. |

Actions the dashboard can request (all are rows the worker picks up; the web process never runs the pipeline): run now, dry run (reconcile and triage only), fix a specific issue now, retry, cancel run, test project configuration.

Access: bind to localhost by default. For access from other devices, the owner will put the machine on Tailscale; add a single shared password (env var, cookie session) that is required whenever the bind address is not localhost.

---

## 10. Milestones

Build in this order. Each milestone ends with the listed checks passing and a short entry in `README.md` describing how to run what exists. Commit at the end of each milestone.

### M0. Scaffold
Next.js + Tailwind app, worker entry point, Drizzle + SQLite with the full schema from section 5, Zod-validated env config, shell wrapper, Vitest.
- `npm run dev` serves an empty dashboard shell; `npm run worker` starts, logs a heartbeat and exits cleanly on SIGTERM.
- `npm run db:migrate` creates the database; schema tests pass.

### M1. Projects
Add-project form, clone job, preset detection, project settings page, worker job queue and global lock.
- Adding `crysfel/hymnal-ios` clones it and shows `ready` with detected scheme, test plans and proposed commands.
- A bad repository URL ends in `error` with a readable message.

### M2. Triage, read-only
Agent runner, Sentry MCP config, triage agent, upserts and snapshots, scoring and selection, runs and run events, `/issues`, `/runs`, `/runs/[id]`. Dry-run mode only: nothing is fixed.
- A dry run against Hymnal fills `/issues` with real issues, each with a classification and reasoning. Legacy React Native issues are `not_in_repo`.
- Running it twice the same day creates no duplicate issues and a second set of snapshots.
- Related issues are grouped with a stated shared cause, groups are stable across two runs, and a group the owner edited is left alone. Review with the owner whether the hang issues (WK, Y3, WN) were grouped sensibly.
- Child processes started through the shell wrapper cannot see harness secrets (7.1, point 5).
- Unit tests cover scoring, selection rules and every state transition using a fake agent runner.

### M3. Fix one issue, by hand
Worktrees, fix agent, verify, publish, attempts, `/issues/[id]`, the "Fix now" action.
- First validate Hymnal's build and test commands on a clean worktree and correct section 8 if needed.
- "Fix now" on one chosen issue produces either a draft PR on GitHub with the body template filled in, or a recorded `no_fix` with a reason. Confirm the specific issue with the owner before the first real PR is opened.
- A deliberately broken fix (test with the fake runner) ends as `verify_failed` and opens no PR.
- The isolation requirements in 7.1 are in place before the first real PR: fine-grained token, HTTPS remote, scrubbed environment. On the development machine the dedicated account can wait until M6, but nothing may depend on the owner's SSH key.
- A selected group produces one attempt and one PR that lists every covered issue.

### M4. The daily loop
Cron scheduling, reconcile, shipped-fix verification, attempt caps, open-PR cap, crash recovery.
- A scheduled run goes end to end without interaction.
- Merging a harness PR on GitHub moves the issue to `awaiting_release` on the next run with the right `ship_version`; closing one moves it to `pr_closed`.
- Transitions to `verified_fixed` and `regressed` are covered by tests using fabricated release data, including: a frequent issue confirmed after 3 days, a rare issue still waiting after 3 days, a rare issue presumed fixed at 30 days, and one issue of a group regressing while the others verify.
- A run with nothing to do finishes `succeeded` with a clear summary.

### M4b. PR review feedback
Feedback polling, `pr_feedback`, revision jobs, replies on the PR (section 6.9).
- A "changes requested" review with two inline comments on a harness PR results, within a few minutes, in one new commit on the same branch and one reply comment that answers both.
- A comment from a GitHub user outside `review_authors` is stored but never acted on.
- A revision whose build fails pushes nothing and says so on the PR.
- The fourth request on one PR gets the "stopped" reply and sets `needs_human`.
- Merging or closing a PR is reflected in the dashboard within one poll interval.

### M5. Notifications and overview
Notifications table and UI, header bell, `/` overview, `/settings` health checks, Pin, Ignore, Retry, Cancel.
- Every event listed in 6.8 produces exactly one notification with a working link.

### M6. Deployment
`ops/` with two `launchd` LaunchAgent plists (web on a fixed port, worker), an install script, log rotation, and a setup checklist for the MacBook.
- Use LaunchAgents in the logged-in user's session, not LaunchDaemons: simulators and the keychain need the GUI session. The checklist must cover automatic login, preventing sleep, and the fact that `launchd` does not load the shell profile, so `PATH` (nvm's Node, `gh`, `claude`) must be set in the plists.
- Checklist items, in order: create the dedicated non-admin macOS account and do everything else inside it (7.1); Xcode at least 16.3 with the iOS simulator runtime installed and licence accepted; Node; `gh` and the fine-grained GitHub token; branch protection on each default branch; `claude setup-token`; read-only Sentry token; Tailscale; dashboard password.
- After a reboot, both processes come back and the next scheduled run happens on its own.

---

## 11. Things to confirm with the owner

Defaults are chosen so work can proceed; raise these at the milestone noted.

1. **Claude credential**: decided. The machine's Claude Code login (section 7).
2. **Draft PRs** (M3): default is draft. Switch to ready-for-review if the owner prefers.
3. **Notes on Sentry issues** (M3): default off.
4. **Run time** (M4): default 06:00 local.
5. **Caps** (M4): default 2 fixes per run, 5 open harness PRs per project, 5 USD per attempt, 2 attempts per issue.
6. **Dashboard exposure** (M6): Tailscale plus a password is assumed.
7. **Review feedback** (M4b): default is to act on comments from the repository owner only, poll every 5 minutes, and stop after 3 revisions per PR.
8. **GitHub identity** (M3): PRs and replies will appear as the owner's own GitHub user, because the fine-grained token belongs to them. GitHub does not let a user request changes on their own PR, so the owner's reviews will arrive as "commented", which 6.9 handles. A separate machine account would allow "request changes"; ask whether the owner wants one.
