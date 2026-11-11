# Setting up the deployment MacBook

Do these in order. Everything after step 1 happens **inside the dedicated harness account**, never in your personal one (PLAN §7.1).

## 1. Dedicated macOS account
- [ ] System Settings → Users & Groups → Add User: a **Standard** (not admin) account, e.g. `harness`.
- [ ] Users & Groups → Automatic login → `harness`. (FileVault blocks automatic login; if FileVault is on, the machine needs a manual unlock after every reboot. Decide which you prefer.)
- [ ] Log in as `harness`. Do **not** copy SSH keys, your keychain, browser profiles or other repositories into it.

## 2. Keep it awake
- [ ] System Settings → Energy (or Battery → Options): prevent automatic sleeping when the display is off; enable "Start up automatically after a power failure" if offered; turn on "Wake for network access".
- [ ] Optional: an admin runs `sudo pmset -c sleep 0 disksleep 0` to rule out sleep on power.

## 3. Xcode
- [ ] Xcode ≥ 16.3 installed (an admin installs it; it lives in /Applications for everyone).
- [ ] As an admin: `sudo xcodebuild -license accept` and `sudo xcodebuild -runFirstLaunch`.
- [ ] As `harness`: Xcode → Settings → Components: install the iOS simulator runtime the project targets (Hymnal: iOS 18.4).
- [ ] `xcrun simctl list devices available | grep iPhone` shows at least one device.

## 4. Node and CLIs
- [ ] Node ≥ 22.15 (nvm or Homebrew), `git`, `gh`.
- [ ] Claude Code: `curl -fsSL https://claude.ai/install.sh | bash` (or your preferred install), then `claude --version`.

## 5. GitHub: fine-grained token
- [ ] github.com → Settings → Developer settings → Fine-grained tokens → Generate:
  - Repository access: **Only select repositories** → each repository the harness works on.
  - Permissions: **Contents: Read and write**, **Pull requests: Read and write**. Nothing else.
  - The harness creates the `autofix` label when it opens its first PR. If that fails with the token above (label creation can need Issues: write), create the label once by hand instead of widening the token: `gh label create autofix --repo owner/name`.
- [ ] Put it in `.env` as `HARNESS_GITHUB_TOKEN`. Each time you register a new repository, add it to the token's repository list first.
- [ ] No SSH key on this account (`ls ~/.ssh` is empty). The harness refuses SSH remotes.

## 6. Branch protection
- [ ] For every registered repository: Settings → Branches (or Rules) → protect the default branch, **require a pull request before merging**. With this, a leaked token still cannot change `main`.

## 7. Claude credential
- [ ] As `harness`: `claude setup-token` and follow the prompts (needs a Claude subscription). Put the token it prints in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
- [ ] Make sure `ANTHROPIC_API_KEY` is **not** set anywhere for this account (it takes precedence and bills the API). `ops/install.sh` refuses to install if it is in `.env`.
- [ ] Usage limits are shared with your interactive Claude use. A run that hits the limit stops, records it, and notifies you.

## 8. Sentry: read-only token
- [ ] sentry.io → Settings → Account → Personal Tokens (User Auth Tokens) → create with scopes `org:read`, `project:read`, `event:read`. (Add `event:write` only if you switch on Sentry notes for a project.)
- [ ] Put it in `.env` as `SENTRY_AUTH_TOKEN`.
- [ ] For each other Sentry account (e.g. a client's), create a token the same way while logged in to that account and add it as `SENTRY_AUTH_TOKEN_<NAME>` (e.g. `SENTRY_AUTH_TOKEN_ACME`). Pick that connection on the project's settings.

## 9. Install
```sh
git clone <this repo> ~/sentry-harness && cd ~/sentry-harness
cp .env.example .env && chmod 600 .env   # fill in the three tokens
./ops/install.sh
```
- [ ] Ask an admin to install log rotation once: `sudo cp ops/newsyslog.conf /etc/newsyslog.d/sentry-harness.conf`.
- [ ] Open http://127.0.0.1:3100 → Settings → **Run health checks**. Everything should be ✅ except items you chose to skip.
- [ ] Projects → add the repository → wait for `ready` → review commands → **Test configuration** → when it passes, tick **Enabled**.

## 10. Remote access (optional)
- [ ] Install Tailscale, sign in, and note the machine's tailnet name.
- [ ] In `.env`: `DASHBOARD_HOST=0.0.0.0` (or the Tailscale IP) and a long `DASHBOARD_PASSWORD`. The dashboard refuses to serve without a password when not bound to localhost.
- [ ] `./ops/install.sh` again to restart with the new settings.

## 11. Reboot test
- [ ] Reboot the Mac. After automatic login, `launchctl list | grep sentry-harness` shows both agents, the dashboard's header shows "worker up", and the next scheduled run happens on its own.

## Operations
- Logs: `data/logs/worker.log`, `data/logs/web.log`; agent transcripts: `data/transcripts/`; build/test logs: `data/logs/verify-*.log`.
- Restart: `launchctl kickstart -k gui/$(id -u)/dev.sentry-harness.worker` (or `.web`).
- Uninstall: `./ops/install.sh uninstall`.
- Note on rotation: launchd keeps the log file open, so after newsyslog rotates a file the agent keeps writing to the rotated copy until it restarts. The worker restarts rarely; if logs grow, `kickstart -k` it after rotation.
