# sentry-harness

A self-hosted harness that, once a day per registered project, pulls the latest Sentry issues, decides which are worth fixing, has a coding agent write a fix in a clone of the project's repository, builds and tests it, and opens a draft pull request. Everything is recorded in SQLite and shown in a local dashboard. A human reviews and merges.

The design is in [`docs/PLAN.md`](docs/PLAN.md). The central rule: **deterministic code owns control flow and every side effect; agents own judgment.** Agents do two bounded jobs, triage and fix (plus revisions of a fix after review), each returning Zod-validated JSON. An agent never commits, pushes, calls `gh`, or reaches the network beyond the read-only Sentry MCP server.

## Status by milestone

| Milestone | State | Notes |
|---|---|---|
| M0 Scaffold | ✅ done | Next.js 16 + Tailwind 4, worker, Drizzle/SQLite (WAL), Zod config, shell wrapper, Vitest |
| M1 Projects | ✅ done, verified on Hymnal | Add form, clone job, preset detection, settings page, job queue, global lock |
| M2 Triage (dry run) | ✅ code + tests; ⏳ live run needs `SENTRY_AUTH_TOKEN` | Agent runner, triage agent, upserts, snapshots, groups, scoring, selection, `/issues`, `/runs` |
| M3 Fix one issue | ✅ code + tests; ⏳ first real PR waits for the owner | Worktrees, fix agent, verify with one repair round, publish, `/issues/[id]`, Fix now |
| M4 Daily loop | ✅ code + tests | Cron, reconcile, shipped-fix verification, caps, crash recovery |
| M4b PR feedback | ✅ code + tests | Polling, `pr_feedback`, revision jobs, replies, limits |
| M5 Notifications | ✅ | Notifications for every §6.8 event, bell, overview, health checks, Pin/Ignore/Retry/Cancel |
| M6 Deployment | ✅ files written; ⏳ not installed | `ops/` plists, install script, log rotation, [setup checklist](ops/SETUP.md) |

## Running it

```sh
npm install
cp .env.example .env && chmod 600 .env    # fill in tokens (see below)
npm run db:migrate                         # creates data/harness.db
npm run worker                             # pipeline process (scheduler + job queue)
npm run dev                                # dashboard on http://127.0.0.1:3100
```

Two processes share `data/harness.db`. The web process only reads and inserts "please do X" rows; the worker does all the work, one job at a time under a machine-wide lock (`data/worker.lock`).

Other scripts:

| Script | What it does |
|---|---|
| `npm test` | Unit and pipeline tests (no model calls: a fake agent runner drives the pipeline) |
| `npm run typecheck` | `next typegen` + `tsc` |
| `npm run build` / `npm start` | Production dashboard |
| `npm run project:add -- owner/name <sentry-org> <sentry-project>` | CLI equivalent of the Add project form |
| `npm run db:generate` | Generate a migration after editing `src/db/schema.ts` |

### Credentials (`.env`)

| Variable | Used by | Notes |
|---|---|---|
| `HARNESS_GITHUB_TOKEN` | harness code only (`git` over HTTPS, `gh`) | Fine-grained, limited to registered repos, Contents + Pull requests read/write |
| `SENTRY_AUTH_TOKEN` | the local `@sentry/mcp-server` (stdio) | Read-only scopes. Written to a per-session 600 file, not a command line. This is the `default` Sentry connection |
| `SENTRY_AUTH_TOKEN_<NAME>` (optional, any number) | same | One per additional Sentry account (e.g. a client's). Becomes the connection `<name>` that a project selects; optional `SENTRY_HOST_<NAME>` |
| `CLAUDE_CODE_OAUTH_TOKEN` | agent sessions | From `claude setup-token`. Unset = the machine's interactive login |
| `DASHBOARD_PASSWORD` | dashboard | Required when `DASHBOARD_HOST` is not loopback |

Never set `ANTHROPIC_API_KEY` for the worker: it would bill the API instead of the subscription.

**Several Sentry accounts.** One token can read every org its user belongs to, so projects in different orgs of the same account all use `default`. For a separate Sentry account (a client's own login), add `SENTRY_AUTH_TOKEN_ACME=…` to `.env`, restart both processes, and choose the `acme` connection on the project (dashboard form, or `npm run project:add -- owner/name <org> <project> --sentry=acme`). The project row stores only the name; each agent session gets only its own project's token. Health checks verify each token and list which projects use it.

## How a run works

`reconcile → triage → verify shipped fixes → select → fix → verify → publish → notify`, in `src/pipeline/run.ts`.

- **Reconcile** fetches the clone, reads the app version on the default branch, and checks every open harness PR (`gh pr view`). Merged → `awaiting_release` with the ship version read at the merge commit; closed → `pr_closed`.
- **Triage** is one Claude Code session (`claude -p`, `src/agents/runner.ts`) in the clone, with Sentry MCP read tools, file read tools and read-only git. It returns every active issue with copied facts, a classification (`candidate`, `not_in_repo`, `not_actionable`, `likely_fixed_unreleased`), groups of issues that share a root cause, release data, and per-issue verification counts. `applyTriage` upserts, snapshots, and moves statuses; groups stay stable and locked groups are never touched.
- **Verify shipped fixes** (`src/pipeline/verification.ts`): expected events = baseline per day × days since a release ≥ V first had events. Zero events with ≥ 5 expected over ≥ 3 days → `verified_fixed (confirmed)`; ≥ 30 days → `presumed`; any event in a release ≥ V → `regressed`.
- **Select** (`src/pipeline/select.ts`): `impact = users14d × severity × trend`, groups as one unit, drops ignored / busy-group / exhausted / unlikely / below-threshold, pinned first, capped by `max_fixes_per_run` and open PRs. Every candidate gets a recorded reason (shown on `/runs/[id]`).
- **Fix** (`src/pipeline/fix-stage.ts`): a worktree on `autofix/<shortid>-<n>`, a fix session allowed to edit only inside it and to run only the generated build/test wrapper scripts. The harness then builds and tests (`verify.ts`), checks the diff (size, lockfiles, CI, secrets, signing/version keys in `project.pbxproj`), gives the agent one repair round on failure, then commits, pushes and opens a draft PR with the body template.
- **PR feedback** (`feedback.ts`, `revise.ts`): polled every `feedback_poll_minutes` while PRs are open. Comments from `review_authors` that are requests queue one revision job (2-minute debounce); the revision resumes the fix session, verifies, pushes a new commit (never force), and posts one reply quoting each comment. The harness posts as the owner's GitHub user, so it recognises its own comments by an HTML marker, not by author.

## Findings from building it (worth reading)

1. **The release filter in PLAN §3 does not work in issue search.** `release.version:>=6.0.0` is rewritten by the Sentry MCP to `release:>=6.0.0`, which returns nothing for `himnario-mobile`; `release.package:com.bleext.hymnal` does not exclude the legacy React Native issues either (FG and 9 still appear). Hymnal's `sentry_query_filter` is therefore left empty and triage's `not_in_repo` classification separates the legacy app. The triage prompt also asks for each issue's releases, so the agent sees `5.x` releases directly.
2. **Hymnal's Unit plan has timing-sensitive tests.** On a clean worktree of `main` (Xcode 16.3, iPhone 16 Pro / iOS 18.4) the first configuration test ran 186 tests: 184 passed, `SheetNoteStoreTests.rateLimitedWaitsAsTold` (relies on two `Task.yield()` calls reaching a sleep) and `SupportStoreTests.expiringEndsIt` (StoreKit test session) failed. A second run with `-retry-tests-on-failure -test-iterations 3` (now part of the Xcode preset) still failed both, so they fail consistently in this environment rather than flaking. Until this is resolved, "Test configuration" fails for Hymnal, the project cannot be enabled, and every fix would end `verify_failed`. See "Open questions".
3. **Build and test times.** Clean build ≈ 2.5 minutes, Unit tests ≈ 2.5 minutes (SPM packages resolved over the network on the first build; DerivedData is cached per project under `data/derived-data/`).
4. **Claude Code flags verified on 2.1.322:** `-p`, `--output-format stream-json --verbose`, `--json-schema` (the result carries `structured_output`), `--strict-mcp-config --mcp-config`, `--tools`, `--allowedTools`/`--disallowedTools` with path rules (`Read(./**)`, `Edit(./**)`) and exact Bash commands, `--permission-mode dontAsk` (everything not allowed is denied), `--setting-sources ""`, `--max-budget-usd`, `--resume`. There is no `--max-turns` flag, so the wall-clock timeout and budget are the session limits. Permission denials and `rate_limit_event` messages appear in the stream and are logged.
5. **Sentry MCP (`@sentry/mcp-server@0.49.0`)** takes `SENTRY_AUTH_TOKEN` (the older `SENTRY_ACCESS_TOKEN` is deprecated), and supports scoping to one `org/project` and to the read-only `inspect` skill. Both are used.

## Security model and residual risk (PLAN §7.1)

What is in place:

- Every child process gets an explicit minimal environment (`src/core/shell.ts`); tests assert a child cannot see `GH_TOKEN`, the Sentry token or the Claude token. Build and test commands, setup commands and the agent process never receive the GitHub token.
- Git uses HTTPS with an inline credential helper reading the token from that one child's environment; nothing is written to `.git/config`, and SSH is disabled (`GIT_SSH_COMMAND=false`). Repo hooks are disabled for harness git calls.
- `gh` runs with an isolated config directory and `GH_TOKEN`, so the owner's own `gh` login is never used.
- Agents run with `--permission-mode dontAsk`, an explicit tool allow-list, path-scoped file rules, `--strict-mcp-config` and `--setting-sources ""`. Prompts mark Sentry data and PR comments as untrusted.
- Only `review_authors` can steer revisions; strangers' comments are stored and ignored.
- The add-project flow checks the token can read and push before cloning, with an exact message when it cannot. Health checks report the token's access per repository and warn about unprotected default branches.

Known limits:

- **Project code runs as the harness user.** A malicious build script or test can read anything that user can read, including `.env`. The controls above bound the damage to "the scoped GitHub token and a read-only Sentry token leak"; branch protection keeps `main` safe even then. Running under the dedicated account (ops/SETUP.md step 1) is what keeps the owner's own files out of reach.
- **Claude Code's Bash sandbox could not be verified on the development machine.** `--settings '{"sandbox":{"enabled":true}}'` is passed, but in testing a sandboxed `touch ../outside.txt` still succeeded (possibly because the test itself ran inside another sandbox). Tool-level confinement does work (verified: reads and writes outside the worktree and unlisted Bash commands are denied). Re-test on the deployment account; until then treat the Bash sandbox as absent.
- The agent can Read the per-session MCP config file if it guesses its path (it is outside the worktree, and `Read` is limited to `./**`, so this needs a permission bypass). The token in it is read-only.

## Development notes

- The dashboard reads SQLite synchronously; every data function calls `await connection()` first and pages render inside `<Suspense>` (Cache Components is on). See `app/lib/data.ts`.
- Next.js 16 conventions differ from older versions: `proxy.ts` instead of middleware, async `params`/`searchParams`, `refresh()` in server actions. The guides ship in `node_modules/next/dist/docs/`.
- Tests: `tests/pipeline.test.ts` drives full runs with a fake agent and a throwaway git repo; `tests/feedback.test.ts` covers the M4b acceptance cases; `tests/shell.test.ts` covers secret isolation.
- `data/` (database, clones, worktrees, transcripts, logs) is git-ignored.

## Open questions for the owner

1. **First real PR (M3).** Nothing has been sent to GitHub. Which issue should be the first "Fix now"? Candidates from today's Sentry data: `HIMNARIO-MOBILE-XV` (missing `PlayerCoordinator` environment object: a crash with app frames, likely fixable), `HIMNARIO-MOBILE-Y3` (escalating 13 s hang), or `HIMNARIO-MOBILE-XQ` (`SupportStore.ProductsError`).
2. **Failing Hymnal tests.** The two tests fail on `main` even with retries (they may pass in your own Xcode setup: StoreKit configuration or timing can differ). Should the harness (a) quarantine known-failing tests by recording a baseline at "Test configuration" and only fail verification on new failures, or (b) should they be fixed in the repo first?
3. **GitHub identity.** PRs and replies appear as your own user, so you cannot "Request changes" on them (they arrive as "commented", which is handled). A separate machine account would allow it.
4. Defaults kept from PLAN §11: draft PRs, Sentry notes off, 06:00 daily, 2 fixes/run, 5 open PRs, 2 attempts, 3 revisions, act only on your comments, poll every 5 minutes.
