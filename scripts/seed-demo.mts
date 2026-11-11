/**
 * Seed a demo database (never the real one) by driving the real pipeline with a
 * fake agent. Usage: HARNESS_DB_PATH=data/demo.db npx tsx scripts/seed-demo.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config, ensureDataDirs } from "../src/core/config";
import { db, runMigrations } from "../src/db/client";
import { projects, runs, issues } from "../src/db/schema";
import { setAgentRunner, type AgentRunner } from "../src/agents/runner";
import { TriageOutput, FixOutput } from "../src/agents/schemas";
import { executeRun } from "../src/pipeline/run";

if (!process.env.HARNESS_DB_PATH?.includes("demo")) throw new Error("Refusing: set HARNESS_DB_PATH to a demo database");
fs.rmSync(config().dbPath, { force: true });
ensureDataDirs();
const d = db();
runMigrations(d);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "demo-repo-"));
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo }).toString().trim();
g("init", "-q", "-b", "main"); g("config", "user.email", "d@e.x"); g("config", "user.name", "D");
fs.writeFileSync(path.join(repo, "App.swift"), "let x = 1\n"); g("add", "-A"); g("commit", "-qm", "Initial");

const p = d.insert(projects).values({
  name: "hymnal-ios", repoSlug: "crysfel/hymnal-ios", repoUrl: "https://github.com/crysfel/hymnal-ios.git",
  sentryOrg: "peacefulhymns-backend", sentryProject: "himnario-mobile", cloneStatus: "ready", localPath: repo,
  defaultBranch: "main", preset: "xcode", versionCmd: "echo 6.3.3", buildCmd: "true", testCmd: "true", configTestOk: true, enabled: true,
  presetInfo: { scheme: "hymnal", testPlan: "Unit", simulator: "iPhone 16 Pro" }, reviewAuthors: ["crysfel"],
}).returning().get();

const base = { url: "", culprit: null, level: "error", substatus: "ongoing", firstRelease: "com.bleext.hymnal@6.3.0+18", lastReleaseSeen: "com.bleext.hymnal@6.3.2+21", category: null, fixedByCommit: null, relevantFiles: [] as string[], firstSeen: "2026-10-28T10:24:11Z", lastSeen: "2026-11-10T23:55:39Z" };
const iss = (shortId: string, sentryId: string, title: string, users14d: number, events14d: number, classification: "candidate" | "not_in_repo" | "not_actionable" | "likely_fixed_unreleased", fixability: "likely" | "uncertain" | "unlikely", reasoning: string, extra = {}) =>
  ({ ...base, shortId, sentryId, title, users14d, events14d, classification, fixability, reasoning, url: `https://peacefulhymns-backend.sentry.io/issues/${shortId}`, ...extra });

const triage = {
  latestRelease: { version: "com.bleext.hymnal@6.3.2+21", firstEventAt: "2026-11-05T00:00:00Z" },
  releases: [{ version: "com.bleext.hymnal@6.3.2+21", firstEventAt: "2026-11-05T00:00:00Z" }],
  issues: [
    iss("HIMNARIO-MOBILE-WK", "1", "App Hang Fully Blocked: App hanging between 503.4 and 504.2 seconds.", 128, 183, "likely_fixed_unreleased", "uncertain", "Hang at HymnalApp.$main during launch while keychain and disk writes run on the main thread. Commit 4f2a1c0 'Taking disk and keychain writes off the launch path' on main moves them off; it has not shipped yet.", { culprit: "HymnalApp.$main", fixedByCommit: "4f2a1c0" }),
    iss("HIMNARIO-MOBILE-Y3", "2", "App Hang Fully Blocked: App hanging between 13.0 and 13.8 seconds.", 31, 35, "candidate", "uncertain", "New in 6.3.2 and escalating. Main thread blocked in SearchViewModel.filter while typing; the debounce on main covers the hymn list but not the sheet-note search.", { culprit: "HymnalApp.$main", substatus: "escalating", firstRelease: "com.bleext.hymnal@6.3.2+21", relevantFiles: ["hymnal/Views/Search/SearchViewModel.swift"] }),
    iss("HIMNARIO-MOBILE-WN", "3", "Fatal App Hang Fully Blocked: The user or the OS watchdog terminated your app while it blocked the main thread for at least 2000 ms.", 14, 15, "candidate", "uncertain", "Same stack as Y3: synchronous filtering in SearchViewModel on the main actor, killed by the watchdog when the list is large.", { culprit: "HymnalApp.$main" }),
    iss("HIMNARIO-MOBILE-XQ", "4", "hymnal.SupportStore.ProductsError: noneReturned (Code: 0)", 18, 19, "not_actionable", "unlikely", "StoreKit returned no products. The product identifiers match App Store Connect; this is likely a sandbox or regional availability issue, not code."),
    iss("HIMNARIO-MOBILE-FG", "5", "IllegalArgumentException: Animated events must have event data.", 16, 17, "not_in_repo", "unlikely", "Thrown by react-native-reanimated in the legacy Android app (release 5.x). That code is not in this repository.", { culprit: "com.swmansion.reanimated.nodes.EventNode in receiveEvent" }),
    iss("HIMNARIO-MOBILE-XV", "6", "EXC_BREAKPOINT: Fatal error: No ObservableObject of type PlayerCoordinator found.", 3, 8, "candidate", "likely", "MiniPlayerView reads @EnvironmentObject PlayerCoordinator, but the sheet presented from HymnDetailView does not inherit it. Injecting it on the sheet fixes the crash.", { culprit: "EnvironmentObject.wrappedValue.getter", relevantFiles: ["hymnal/Views/Hymnal/HymnDetailView.swift"] }),
    iss("HIMNARIO-MOBILE-X1", "7", "WatchdogTermination: The OS watchdog terminated your app, possibly because it overused RAM.", 5, 5, "not_actionable", "unlikely", "No stack trace; memory pressure on older devices. Nothing in the evidence points at a specific allocation."),
    iss("HIMNARIO-MOBILE-9", "8", "Error: The Internet connection appears to be offline.", 5, 9, "not_in_repo", "unlikely", "Raised through rn-fetch-blob in the legacy React Native app.", { culprit: "<unknown>(rn-fetch-blob/index)" }),
  ],
  groups: [{ title: "Main-thread search filtering hangs", sentryIds: ["2", "3"], reasoning: "Both stacks block in SearchViewModel.filter on the main actor; WN is the watchdog-terminated form of Y3." }],
  verification: [], notes: "Legacy React Native issues (5.x) are classified not_in_repo.",
};

setAgentRunner((async (input: { outputSchema: unknown; cwd: string }) => {
  if (input.outputSchema === TriageOutput) return { output: triage, sessionId: "demo-triage", costUsd: 0.84, turns: 23, permissionDenials: [] };
  if (input.outputSchema === FixOutput) {
    fs.appendFileSync(path.join(input.cwd, "App.swift"), "// fix\n");
    return { output: { outcome: "fixed", rootCause: "SearchViewModel.filter runs synchronously on the main actor over ~2,000 hymns on every keystroke.", summary: "Moved filtering to a detached task and debounced it like the hymn list.", confidence: "medium", testsAdded: true, coveredSentryIds: ["2", "3"], commitSubject: "Filtering search results off the main thread", notes: "" }, sessionId: "demo-fix", costUsd: 2.1, turns: 41, permissionDenials: [] };
  }
  throw new Error("unexpected");
}) as unknown as AgentRunner);

const fake = { fix: { verify: async () => ({ ok: true as const, buildOk: true as const, testsOk: true as const, files: ["hymnal/Views/Search/SearchViewModel.swift", "hymnalTests/SearchViewModelTests.swift"], lines: 64, testCount: 188 }), commit: async () => "abc", push: async () => {}, openPr: async () => ({ url: "https://github.com/crysfel/hymnal-ios/pull/101", number: 101, labelOk: true }) } };
const run = d.insert(runs).values({ projectId: p.id, trigger: "schedule", status: "queued" }).returning().get();
await executeRun(d, run.id, { deps: { sync: async () => g("rev-parse", "HEAD"), commits: async () => ["4f2a1c0 2026-11-08 Taking disk and keychain writes off the launch path", "9a8b7c6 2026-11-07 Debouncing the search"], version: async () => "6.3.3", checkPr: async () => ({ state: "OPEN", mergedAt: null, mergeCommit: null, url: "" }), ...fake } });
console.log(d.select().from(runs).get()?.summary);
console.log(d.select({ s: issues.shortId, st: issues.status }).from(issues).all());
