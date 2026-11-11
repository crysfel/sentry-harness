import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { attempts, attemptIssues, issues, notifications, runs, issueGroups } from "../src/db/schema";
import { setAgentRunner, type AgentRunner, AgentError } from "../src/agents/runner";
import { TriageOutput, FixOutput, type FixOutput as FixOut } from "../src/agents/schemas";
import { executeRun, type RunDeps } from "../src/pipeline/run";
import type { VerifyResult } from "../src/pipeline/verify";
import { addIssue, addProject, addRun, testDb, triageIssue, triageOutput } from "./helpers";

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "App.swift"), "let x = 1\n");
  g("add", "-A");
  g("commit", "-q", "-m", "Initial");
  return dir;
}

type Fake = { triage?: TriageOutput | (() => TriageOutput); fix?: Array<FixOut | Error>; calls: string[] };

function fakeAgent(f: Fake): AgentRunner {
  return (async (input) => {
    if ((input.outputSchema as unknown) === TriageOutput) {
      f.calls.push("triage");
      const out = typeof f.triage === "function" ? f.triage() : f.triage ?? triageOutput();
      return { output: out, sessionId: "s-triage", costUsd: 0.5, turns: 3, permissionDenials: [] };
    }
    if ((input.outputSchema as unknown) === FixOutput) {
      f.calls.push(input.resumeSessionId ? "repair" : "fix");
      // A "fix" really edits the worktree so diffs are non-empty.
      fs.appendFileSync(path.join(input.cwd, "App.swift"), `// fixed ${f.calls.length}\n`);
      const next = f.fix?.shift();
      if (next instanceof Error) throw next;
      return { output: next ?? fixed(), sessionId: "s-fix", costUsd: 1, turns: 10, permissionDenials: [] };
    }
    throw new Error("unexpected schema");
  }) as AgentRunner;
}

const fixed = (o: Partial<FixOut> = {}): FixOut => ({
  outcome: "fixed",
  rootCause: "Main thread blocked by disk IO.",
  summary: "Moved IO off the main thread.",
  confidence: "medium",
  testsAdded: true,
  coveredSentryIds: [],
  commitSubject: "Moving IO off the main thread",
  notes: "",
  ...o,
});

const okVerify = async (): Promise<VerifyResult> => ({ ok: true, buildOk: true, testsOk: true, files: ["App.swift"], lines: 1, testCount: 12 });
const failVerify = async (): Promise<VerifyResult> => ({ ok: false, step: "test", buildOk: true, testsOk: false, reason: "tests exited 65", outputTail: "XCTAssertEqual failed", files: ["App.swift"], lines: 1 });

function deps(repo: string, over: Partial<RunDeps> = {}, published: string[] = []): Partial<RunDeps> {
  return {
    sync: async () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim(),
    commits: async () => ["abc1234 2026-11-09 Debouncing the search"],
    version: async () => "6.3.3",
    checkPr: async () => ({ state: "OPEN", mergedAt: null, mergeCommit: null, url: "" }),
    fix: {
      verify: okVerify,
      commit: async () => "deadbeef",
      push: async (_cwd, branch) => {
        published.push(branch);
      },
      openPr: async () => ({ url: "https://github.com/crysfel/hymnal-ios/pull/42", number: 42, labelOk: true }),
    },
    ...over,
  };
}

afterEach(() => setAgentRunner(undefined));

describe("executeRun", () => {
  it("dry run: reconciles and triages, selects, fixes nothing", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const f: Fake = { calls: [], triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "A-1", users14d: 50 })] }) };
    setAgentRunner(fakeAgent(f));
    const r = addRun(d, p.id, { dryRun: true });
    await executeRun(d, r.id, { deps: deps(repo) });
    const run = d.select().from(runs).where(eq(runs.id, r.id)).get()!;
    expect(run.status).toBe("succeeded");
    expect(run.summary).toMatch(/1 would be fixed \(dry run\)/);
    expect(f.calls).toEqual(["triage"]);
    expect(run.selection).toHaveLength(1);
    expect(d.select().from(attempts).all()).toHaveLength(0);
    expect(run.costUsd).toBe(0.5);
  });

  it("a quiet day finishes succeeded with a clear summary", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    setAgentRunner(fakeAgent({ calls: [], triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "A-1", classification: "not_in_repo" })] }) }));
    const r = addRun(d, p.id);
    await executeRun(d, r.id, { deps: deps(repo) });
    const run = d.select().from(runs).where(eq(runs.id, r.id)).get()!;
    expect(run.status).toBe("succeeded");
    expect(run.summary).toBe("1 issues synced, 1 new, nothing worth fixing today.");
    expect(d.select().from(notifications).where(eq(notifications.kind, "run_summary")).all()).toHaveLength(1);
  });

  it("fixes the selected issue and opens a PR", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const published: string[] = [];
    setAgentRunner(fakeAgent({ calls: [], triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "HIMNARIO-MOBILE-R", users14d: 7 })] }), fix: [fixed({ coveredSentryIds: ["1"] })] }));
    const r = addRun(d, p.id);
    await executeRun(d, r.id, { deps: deps(repo, {}, published) });
    const a = d.select().from(attempts).get()!;
    expect(a).toMatchObject({ status: "pr_open", prNumber: 42, number: 1, branch: "autofix/himnario-mobile-r-1", baseVersion: "6.3.3", buildOk: true, testsOk: true });
    expect(published).toEqual(["autofix/himnario-mobile-r-1"]);
    expect(d.select().from(issues).get()!.status).toBe("pr_open");
    expect(d.select().from(notifications).where(eq(notifications.kind, "pr_opened")).all()).toHaveLength(1);
    expect(fs.readdirSync(path.join(process.env.HARNESS_DATA_DIR!, "worktrees", String(p.id)))).toHaveLength(0);
    const run = d.select().from(runs).where(eq(runs.id, r.id)).get()!;
    expect(run.summary).toMatch(/1 PR opened/);
    expect(run.costUsd).toBe(1.5);
  });

  it("a broken fix ends verify_failed after one repair round and opens no PR", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const f: Fake = { calls: [], triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "B-1", users14d: 20 })] }) };
    setAgentRunner(fakeAgent(f));
    const published: string[] = [];
    const r = addRun(d, p.id);
    const dd = deps(repo, {}, published);
    dd.fix!.verify = failVerify;
    await executeRun(d, r.id, { deps: dd });
    expect(f.calls).toEqual(["triage", "fix", "repair"]);
    const a = d.select().from(attempts).get()!;
    expect(a.status).toBe("verify_failed");
    expect(a.prNumber).toBeNull();
    expect(published).toEqual([]);
    expect(d.select().from(issues).get()!.status).toBe("attempt_failed");
    expect(d.select().from(notifications).where(eq(notifications.kind, "attempt_failed")).all()).toHaveLength(1);
  });

  it("records no_fix as a normal result", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    setAgentRunner(fakeAgent({ calls: [], triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "C-1", users14d: 20 })] }), fix: [fixed({ outcome: "no_fix", summary: "Idle stack." })] }));
    const r = addRun(d, p.id);
    await executeRun(d, r.id, { deps: deps(repo) });
    expect(d.select().from(attempts).get()!.status).toBe("no_fix");
    expect(d.select().from(issues).get()!.status).toBe("not_actionable");
    expect(d.select().from(runs).get()!.status).toBe("succeeded");
  });

  it("a selected group produces one attempt and one PR covering every addressed issue", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const t = triageOutput({
      issues: [
        triageIssue({ sentryId: "1", shortId: "WK", title: "App Hang Fully Blocked: 503 s", users14d: 128 }),
        triageIssue({ sentryId: "2", shortId: "Y3", title: "App Hang Fully Blocked: 13 s", users14d: 31, substatus: "escalating" }),
        triageIssue({ sentryId: "3", shortId: "WN", title: "Fatal App Hang Fully Blocked", users14d: 14 }),
      ],
      groups: [{ title: "Launch hang", sentryIds: ["1", "2", "3"], reasoning: "Same main-thread block." }],
    });
    setAgentRunner(fakeAgent({ calls: [], triage: t, fix: [fixed({ coveredSentryIds: ["1", "2"] })] }));
    const r = addRun(d, p.id);
    await executeRun(d, r.id, { deps: deps(repo) });
    expect(d.select().from(attempts).all()).toHaveLength(1);
    const a = d.select().from(attempts).get()!;
    const primary = d.select().from(issues).where(eq(issues.id, a.issueId)).get()!;
    expect(primary.shortId).toBe("WK");
    const cov = d.select().from(attemptIssues).all();
    expect(cov).toHaveLength(3);
    const st = Object.fromEntries(d.select().from(issues).all().map((i) => [i.shortId, i.status]));
    expect(st).toEqual({ WK: "pr_open", Y3: "pr_open", WN: "triaged" });
    expect(d.select().from(issues).where(eq(issues.shortId, "WN")).get()!.groupId).toBeNull();
    expect(d.select().from(issueGroups).all()).toHaveLength(1);
  });

  it("an issue with an open PR, and its group, are never selected again", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const t = triageOutput({
      issues: [triageIssue({ sentryId: "1", shortId: "WK", users14d: 128 }), triageIssue({ sentryId: "2", shortId: "Y3", users14d: 31 })],
      groups: [{ title: "Launch hang", sentryIds: ["1", "2"], reasoning: "Same." }],
    });
    const f: Fake = { calls: [], triage: t, fix: [fixed({ coveredSentryIds: ["1"] })] };
    setAgentRunner(fakeAgent(f));
    await executeRun(d, addRun(d, p.id).id, { deps: deps(repo) });
    // Y3 was not covered: it left the group and is triaged. Second run: WK has an open PR.
    f.fix = [fixed({ coveredSentryIds: ["2"] })];
    await executeRun(d, addRun(d, p.id).id, { deps: deps(repo) });
    const all = d.select().from(attempts).all();
    expect(all).toHaveLength(2);
    const second = d.select().from(issues).where(eq(issues.id, all[1].issueId)).get()!;
    expect(second.shortId).toBe("Y3");
  });

  it("merging a PR moves the issue to awaiting_release with the ship version; closing moves it to pr_closed", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const i1 = addIssue(d, p.id, { status: "pr_open", events14d: 28 });
    const i2 = addIssue(d, p.id, { status: "pr_open" });
    d.insert(attempts).values({ issueId: i1.id, number: 1, status: "pr_open", prNumber: 10 }).run();
    d.insert(attempts).values({ issueId: i2.id, number: 1, status: "pr_open", prNumber: 11 }).run();
    setAgentRunner(fakeAgent({ calls: [], triage: triageOutput() }));
    await executeRun(d, addRun(d, p.id, { dryRun: true }).id, {
      deps: deps(repo, {
        checkPr: async (_s, n) =>
          n === 10 ? { state: "MERGED", mergedAt: "2026-11-10T12:00:00Z", mergeCommit: { oid: "abc" }, url: "" } : { state: "CLOSED", mergedAt: null, mergeCommit: null, url: "" },
        versionAt: async () => "6.3.3",
      }),
    });
    const a1 = d.select().from(issues).where(eq(issues.id, i1.id)).get()!;
    expect(a1.status).toBe("awaiting_release");
    expect(a1.expectedVersion).toBe("6.3.3");
    expect(a1.baselineEventsPerDay).toBe(2);
    expect(d.select().from(attempts).where(eq(attempts.prNumber, 10)).get()!).toMatchObject({ status: "merged", shipVersion: "6.3.3", mergeSha: "abc" });
    expect(d.select().from(issues).where(eq(issues.id, i2.id)).get()!.status).toBe("pr_closed");
    expect(d.select().from(notifications).where(eq(notifications.kind, "pr_merged")).all()).toHaveLength(1);
    expect(d.select().from(notifications).where(eq(notifications.kind, "pr_closed")).all()).toHaveLength(1);
  });

  it("verifies shipped fixes and flags a group member that regresses while others verify", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const shipped = "2026-11-01T00:00:00Z";
    const a = addIssue(d, p.id, { sentryId: "1", shortId: "A", status: "awaiting_release", expectedVersion: "6.3.3", baselineEventsPerDay: 3 });
    const b = addIssue(d, p.id, { sentryId: "2", shortId: "B", status: "awaiting_release", expectedVersion: "6.3.3", baselineEventsPerDay: 3 });
    const c = addIssue(d, p.id, { sentryId: "3", shortId: "C", status: "fixed_unreleased", expectedVersion: "6.3.3", baselineEventsPerDay: 0.05 });
    setAgentRunner(
      fakeAgent({
        calls: [],
        triage: triageOutput({
          releases: [{ version: "com.bleext.hymnal@6.3.3+22", firstEventAt: shipped }],
          verification: [
            { sentryId: "1", expectedVersion: "6.3.3", eventsInReleaseGte: 0, releasesSeen: [] },
            { sentryId: "2", expectedVersion: "6.3.3", eventsInReleaseGte: 4, releasesSeen: ["com.bleext.hymnal@6.3.3+22"] },
            { sentryId: "3", expectedVersion: "6.3.3", eventsInReleaseGte: 0, releasesSeen: [] },
          ],
        }),
      }),
    );
    await executeRun(d, addRun(d, p.id, { dryRun: true }).id, { deps: deps(repo, { now: () => new Date("2026-11-05T00:00:00Z") }) });
    const st = (id: number) => d.select().from(issues).where(eq(issues.id, id)).get()!;
    expect(st(a.id)).toMatchObject({ status: "verified_fixed", verificationConfidence: "confirmed" });
    expect(st(b.id).status).toBe("regressed");
    expect(st(c.id).status).toBe("fixed_unreleased");
    expect(st(c.id).statusReason).toMatch(/of 5 expected events/);
    expect(d.select().from(notifications).where(eq(notifications.kind, "regression")).all()).toHaveLength(1);
    expect(d.select().from(notifications).where(eq(notifications.kind, "fix_verified")).all()).toHaveLength(1);
  });

  it("stops the run without retrying when the Claude usage limit is hit", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo, maxFixesPerRun: 2 });
    const f: Fake = {
      calls: [],
      triage: triageOutput({ issues: [triageIssue({ sentryId: "1", shortId: "A", users14d: 50 }), triageIssue({ sentryId: "2", shortId: "B", users14d: 40 })] }),
      fix: [new AgentError("usage_limit", "Claude usage limit reached")],
    };
    setAgentRunner(fakeAgent(f));
    const r = addRun(d, p.id);
    await expect(executeRun(d, r.id, { deps: deps(repo) })).rejects.toThrow(/usage limit/);
    expect(f.calls).toEqual(["triage", "fix"]);
    expect(d.select().from(runs).get()!.status).toBe("failed");
    expect(d.select().from(attempts).get()!.status).toBe("error");
    expect(d.select().from(notifications).where(eq(notifications.kind, "usage_limit")).all()).toHaveLength(1);
    expect(d.select().from(issues).all().some((i) => i.status === "fixing" || i.status === "queued")).toBe(false);
  });

  it("Fix now skips triage and fixes the requested issue", async () => {
    const d = testDb();
    const repo = gitRepo();
    const p = addProject(d, { localPath: repo });
    const i = addIssue(d, p.id, { users14d: 1, fixability: "uncertain" });
    const f: Fake = { calls: [], fix: [fixed()] };
    setAgentRunner(fakeAgent(f));
    await executeRun(d, addRun(d, p.id, { requestedIssueId: i.id }).id, { deps: deps(repo) });
    expect(f.calls).toEqual(["fix"]);
    expect(d.select().from(issues).get()!.status).toBe("pr_open");
  });
});
