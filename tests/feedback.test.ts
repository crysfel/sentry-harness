import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { attemptRevisions, attempts, issues, jobs, notifications, prFeedback } from "../src/db/schema";
import { setAgentRunner, type AgentRunner } from "../src/agents/runner";
import { RevisionOutput, type RevisionOutput as RevOut } from "../src/agents/schemas";
import { pollFeedback, isActionable, HARNESS_MARKER, type FetchedFeedback } from "../src/pipeline/feedback";
import { revisePr, type ReviseDeps } from "../src/pipeline/revise";
import type { VerifyResult } from "../src/pipeline/verify";
import { addIssue, addProject, testDb } from "./helpers";

function repoWithBranch(branch: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fb-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "App.swift"), "let x = 1\n");
  g("add", "-A");
  g("commit", "-q", "-m", "Initial");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", branch);
  fs.appendFileSync(path.join(dir, "App.swift"), "// fix\n");
  g("commit", "-qam", "Fixing it");
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  return { dir, base, head };
}

const T0 = new Date("2026-11-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(T0.getTime() - m * 60_000).toISOString();

function fb(o: Partial<FetchedFeedback> & { githubId: string }): FetchedFeedback {
  return { kind: "review_comment", author: "crysfel", reviewState: null, path: "App.swift", line: 2, diffHunk: "@@ -1 +1,2 @@", body: "Please rename this.", createdAt: minutesAgo(5), ...o };
}

function setup() {
  const d = testDb();
  const branch = "autofix/x-1-1";
  const repo = repoWithBranch(branch);
  const p = addProject(d, { localPath: repo.dir, reviewAuthors: ["crysfel"], maxRevisionsPerPr: 3 });
  const i = addIssue(d, p.id, { status: "pr_open", shortId: "X-1" });
  const a = d.insert(attempts).values({ issueId: i.id, number: 1, status: "pr_open", prNumber: 7, branch, baseSha: repo.base, sessionId: "s-orig" }).returning().get();
  return { d, p, i, a, repo };
}

const openPr = async () => ({ state: "OPEN" as const, mergedAt: null, mergeCommit: null, url: "" });

afterEach(() => setAgentRunner(undefined));

describe("isActionable", () => {
  it("acts only on review_authors' requests, never on its own comments or approvals", () => {
    expect(isActionable(fb({ githubId: "1" }), ["crysfel"])).toBe(true);
    expect(isActionable(fb({ githubId: "2", author: "stranger" }), ["crysfel"])).toBe(false);
    expect(isActionable(fb({ githubId: "3", body: `${HARNESS_MARKER} revision 1` }), ["crysfel"])).toBe(false);
    expect(isActionable(fb({ githubId: "4", kind: "review", reviewState: "APPROVED", body: "LGTM" }), ["crysfel"])).toBe(false);
    expect(isActionable(fb({ githubId: "5", kind: "review", reviewState: "COMMENTED", body: "" }), ["crysfel"])).toBe(false);
    expect(isActionable(fb({ githubId: "6", kind: "review", reviewState: "COMMENTED", body: "A few things" }), ["crysfel"])).toBe(true);
  });
});

describe("pollFeedback", () => {
  it("stores every comment, queues one revision for a review written as several comments, and waits for the debounce", async () => {
    const { d, a } = setup();
    let items = [fb({ githubId: "rc-1", createdAt: minutesAgo(5) }), fb({ githubId: "rc-2", createdAt: minutesAgo(1) })];
    const deps = { fetch: async () => items, checkPr: openPr, now: () => T0 };
    await pollFeedback(d, { jobId: 1, projectId: null, deps });
    expect(d.select().from(prFeedback).all()).toHaveLength(2);
    expect(d.select().from(jobs).where(eq(jobs.kind, "revise_pr")).all()).toHaveLength(0); // newest is 1 minute old

    items = [...items, fb({ githubId: "rc-3", author: "stranger", createdAt: minutesAgo(4) })];
    await pollFeedback(d, { jobId: 2, projectId: null, deps: { ...deps, now: () => new Date(T0.getTime() + 2 * 60_000) } });
    const queued = d.select().from(jobs).where(eq(jobs.kind, "revise_pr")).all();
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ attemptId: a.id });
    const stranger = d.select().from(prFeedback).where(eq(prFeedback.githubId, "rc-3")).get()!;
    expect(stranger.actionable).toBe(false);

    // Polling again does not queue a second job while one is pending.
    await pollFeedback(d, { jobId: 3, projectId: null, deps: { ...deps, now: () => new Date(T0.getTime() + 3 * 60_000) } });
    expect(d.select().from(jobs).where(eq(jobs.kind, "revise_pr")).all()).toHaveLength(1);
  });

  it("a comment from a user outside review_authors is stored but never acted on", async () => {
    const { d } = setup();
    await pollFeedback(d, { jobId: 1, projectId: null, deps: { fetch: async () => [fb({ githubId: "rc-9", author: "stranger" })], checkPr: openPr, now: () => T0 } });
    expect(d.select().from(prFeedback).all()).toHaveLength(1);
    expect(d.select().from(jobs).where(eq(jobs.kind, "revise_pr")).all()).toHaveLength(0);
  });

  it("the request after the revision limit gets the stop reply and sets needs_human", async () => {
    const { d, a, i } = setup();
    for (let n = 1; n <= 3; n++) d.insert(attemptRevisions).values({ attemptId: a.id, number: n, status: "pushed" }).run();
    const comments: string[] = [];
    await pollFeedback(d, {
      jobId: 1,
      projectId: null,
      deps: { fetch: async () => [fb({ githubId: "rc-4" })], checkPr: openPr, now: () => T0, comment: async (_s, _n, body) => (comments.push(body), "url") },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatch(/has stopped/);
    expect(d.select().from(issues).where(eq(issues.id, i.id)).get()!.status).toBe("needs_human");
    expect(d.select().from(jobs).where(eq(jobs.kind, "revise_pr")).all()).toHaveLength(0);
    expect(d.select().from(notifications).where(eq(notifications.kind, "revisions_exhausted")).all()).toHaveLength(1);
  });

  it("notices a merge on the poll", async () => {
    const { d, i } = setup();
    await pollFeedback(d, {
      jobId: 1,
      projectId: null,
      deps: { fetch: async () => [], checkPr: async () => ({ state: "MERGED", mergedAt: T0.toISOString(), mergeCommit: null, url: "" }), now: () => T0 },
    });
    expect(d.select().from(issues).where(eq(issues.id, i.id)).get()!.status).toBe("merged");
  });
});

describe("revisePr", () => {
  const out = (o: Partial<RevOut> = {}): RevOut => ({
    outcome: "revised",
    summary: "Renamed as asked.",
    commitSubject: "Renaming the helper",
    responses: [
      { githubId: "rc-1", action: "changed", reply: "Renamed." },
      { githubId: "rc-2", action: "answered", reply: "It runs on the main actor already." },
    ],
    ...o,
  });

  function agent(outputs: RevOut[], calls: string[]): AgentRunner {
    return (async (input) => {
      if ((input.outputSchema as unknown) !== RevisionOutput) throw new Error("unexpected");
      calls.push(input.resumeSessionId ?? "new");
      fs.appendFileSync(path.join(input.cwd, "App.swift"), "// revised\n");
      return { output: outputs.shift() ?? out(), sessionId: "s-rev", costUsd: 0.3, turns: 4, permissionDenials: [] };
    }) as AgentRunner;
  }

  function seedComments(d: ReturnType<typeof testDb>, attemptId: number) {
    for (const id of ["rc-1", "rc-2"]) {
      d.insert(prFeedback).values({ attemptId, githubId: id, kind: "review_comment", author: "crysfel", body: `comment ${id}`, path: "App.swift", line: 2, createdAt: minutesAgo(5), actionable: true }).run();
    }
  }

  const deps = (repo: { dir: string; head: string }, pushed: string[], comments: string[], verify?: () => Promise<VerifyResult>): Partial<ReviseDeps> => ({
    fetchBranch: async () => repo.head,
    verify: verify ?? (async () => ({ ok: true, buildOk: true, testsOk: true, files: ["App.swift"], lines: 1, testCount: 3 })),
    commit: async () => "c0ffee",
    push: async (_c, b) => {
      pushed.push(b);
    },
    comment: async (_s, _n, body) => {
      comments.push(body);
      return "https://github.com/x/y/pull/7#issuecomment-1";
    },
  });

  it("changes requested with two inline comments → one commit on the same branch and one reply answering both", async () => {
    const { d, a, repo } = setup();
    seedComments(d, a.id);
    const calls: string[] = [];
    setAgentRunner(agent([out()], calls));
    const pushed: string[] = [];
    const comments: string[] = [];
    await revisePr(d, a.id, { jobId: 1, deps: deps(repo, pushed, comments) });
    expect(calls).toEqual(["s-orig"]); // resumed the original fix session
    expect(pushed).toEqual([a.branch]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(HARNESS_MARKER);
    expect(comments[0]).toMatch(/> comment rc-1[\s\S]*Renamed\.[\s\S]*> comment rc-2[\s\S]*main actor/);
    const rev = d.select().from(attemptRevisions).get()!;
    expect(rev).toMatchObject({ status: "pushed", commitSha: "c0ffee", number: 1 });
    expect(d.select().from(prFeedback).all().every((f) => f.revisionId === rev.id)).toBe(true);
  });

  it("a revision whose build fails pushes nothing and says so on the PR", async () => {
    const { d, a, repo } = setup();
    seedComments(d, a.id);
    const calls: string[] = [];
    setAgentRunner(agent([out(), out()], calls));
    const pushed: string[] = [];
    const comments: string[] = [];
    const failing = async (): Promise<VerifyResult> => ({ ok: false, step: "build", buildOk: false, testsOk: null, reason: "build exited 65", outputTail: "error: x", files: ["App.swift"], lines: 1 });
    await revisePr(d, a.id, { jobId: 1, deps: deps(repo, pushed, comments, failing) });
    expect(calls).toHaveLength(2); // one repair round
    expect(pushed).toEqual([]);
    expect(comments[0]).toMatch(/pushed nothing/);
    expect(d.select().from(attemptRevisions).get()!.status).toBe("verify_failed");
    expect(d.select().from(notifications).where(eq(notifications.kind, "revision_failed")).all()).toHaveLength(1);
  });

  it("reply_only posts answers without pushing", async () => {
    const { d, a, repo } = setup();
    seedComments(d, a.id);
    setAgentRunner(agent([out({ outcome: "reply_only" })], []));
    const pushed: string[] = [];
    const comments: string[] = [];
    await revisePr(d, a.id, { jobId: 1, deps: deps(repo, pushed, comments) });
    expect(pushed).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(d.select().from(attemptRevisions).get()!.status).toBe("replied_only");
  });
});
