import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { attempts, issues, jobs, notifications, runs } from "../src/db/schema";
import { claimNextJob, enqueueJob, finishJob, requestCancelRun, requestRun } from "../src/db/queries/jobs";
import { recoverAfterCrash } from "../src/worker/recovery";
import { buildClaudeArgs, toJsonSchema } from "../src/agents/runner";
import { triagePolicy, fixPolicy } from "../src/agents/policy";
import { FixOutput, TriageOutput } from "../src/agents/schemas";
import { config } from "../src/core/config";
import { redactString } from "../src/core/logger";
import { parseRepoSlug } from "../src/github/git";
import { checkDiff, sensitivePbxprojChange, parseTestCount } from "../src/pipeline/verify";
import { addIssue, addProject, testDb } from "./helpers";

describe("job queue", () => {
  it("claims jobs in order, one at a time", () => {
    const d = testDb();
    const p = addProject(d);
    enqueueJob("clone_project", { projectId: p.id }, d);
    enqueueJob("test_config", { projectId: p.id }, d);
    const a = claimNextJob(d)!;
    const b = claimNextJob(d)!;
    expect([a.kind, b.kind]).toEqual(["clone_project", "test_config"]);
    expect(claimNextJob(d)).toBeUndefined();
    finishJob(a.id, "succeeded", {}, d);
    expect(d.select().from(jobs).where(eq(jobs.id, a.id)).get()!.status).toBe("succeeded");
  });

  it("cancelling a queued run cancels its job; a running run gets a cancel request", () => {
    const d = testDb();
    const p = addProject(d);
    const r = requestRun(p.id, { trigger: "manual" }, d);
    requestCancelRun(r.id, d);
    expect(d.select().from(runs).where(eq(runs.id, r.id)).get()!.status).toBe("cancelled");
    expect(claimNextJob(d)).toBeUndefined();
    const r2 = requestRun(p.id, { trigger: "manual" }, d);
    d.update(runs).set({ status: "running" }).where(eq(runs.id, r2.id)).run();
    requestCancelRun(r2.id, d);
    expect(d.select().from(runs).where(eq(runs.id, r2.id)).get()!.cancelRequested).toBe(true);
  });
});

describe("crash recovery", () => {
  it("marks running work interrupted, resets mid-fix issues and removes stale worktrees", () => {
    const d = testDb();
    const p = addProject(d);
    const r = d.insert(runs).values({ projectId: p.id, trigger: "schedule", status: "running" }).returning().get();
    const i = addIssue(d, p.id, { status: "fixing" });
    d.insert(attempts).values({ issueId: i.id, number: 1, status: "running", runId: r.id }).run();
    const stale = path.join(config().worktreesDir, "1", "X-1");
    fs.mkdirSync(stale, { recursive: true });
    recoverAfterCrash(d);
    expect(d.select().from(runs).get()!).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    expect(d.select().from(attempts).get()!.status).toBe("error");
    expect(d.select().from(issues).get()!.status).toBe("triaged");
    expect(fs.existsSync(stale)).toBe(false);
    expect(d.select().from(notifications).where(eq(notifications.kind, "run_failed")).all()).toHaveLength(1);
  });
});

describe("agent runner arguments", () => {
  it("builds a strict, non-interactive claude -p invocation", () => {
    const args = buildClaudeArgs({
      cwd: "/tmp",
      systemPrompt: "sys",
      prompt: "p",
      model: "claude-opus-5-5",
      mcpConfigFile: "/tmp/mcp.json",
      ...triagePolicy(),
      outputSchema: TriageOutput,
      maxBudgetUsd: 5,
      timeoutMs: 1000,
      resumeSessionId: "abc",
    });
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(args[0]).toBe("-p");
    expect(flag("--output-format")).toBe("stream-json");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(flag("--mcp-config")).toBe("/tmp/mcp.json");
    expect(flag("--resume")).toBe("abc");
    expect(flag("--max-budget-usd")).toBe("5");
    expect(JSON.parse(flag("--json-schema")).properties.issues.type).toBe("array");
    // The prompt goes on stdin, never on the command line.
    expect(args).not.toContain("p");
  });

  it("triage cannot edit; fix may only run the generated build/test scripts and read-only git", () => {
    const t = triagePolicy();
    expect(t.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git push *)", "Bash(gh *)"]));
    const f = fixPolicy({ build: "/d/bin/1/build.sh", test: "/d/bin/1/test.sh" });
    expect(f.allowedTools).toEqual(expect.arrayContaining(["Bash(/d/bin/1/build.sh)", "Edit(./**)", "mcp__sentry__get_event_stacktrace"]));
    expect(f.allowedTools.some((r) => /git (commit|push)/.test(r))).toBe(false);
    expect(f.disallowedTools).toEqual(expect.arrayContaining(["Bash(git commit *)", "Bash(git push *)", "Bash(gh *)", "WebFetch"]));
  });

  it("produces JSON schemas for every agent output", () => {
    for (const s of [TriageOutput, FixOutput]) expect(toJsonSchema(s as z.ZodType).type).toBe("object");
  });
});

describe("small helpers", () => {
  it("parses repository inputs", () => {
    expect(parseRepoSlug("crysfel/hymnal-ios")).toBe("crysfel/hymnal-ios");
    expect(parseRepoSlug("https://github.com/crysfel/hymnal-ios.git")).toBe("crysfel/hymnal-ios");
    expect(parseRepoSlug("git@github.com:crysfel/hymnal-ios.git")).toBe("crysfel/hymnal-ios");
    expect(parseRepoSlug("not a repo")).toBeNull();
    expect(parseRepoSlug("../etc/passwd")).toBeNull();
  });

  it("redacts tokens from log text", () => {
    expect(redactString("token ghp_abcdefghijklmnopqrstuvwxyz0123 here")).toBe("token [redacted] here");
    expect(redactString("https://x-access-token:secret@github.com/a/b")).toBe("https://[redacted]@github.com/a/b");
    expect(redactString("sntryu_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]");
  });

  it("rejects risky diffs", () => {
    expect(checkDiff([], 0, { maxLines: 400 })).toMatch(/empty/);
    expect(checkDiff(["a.swift"], 401, { maxLines: 400 })).toMatch(/over the 400-line limit/);
    expect(checkDiff(["hymnal.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"], 3, { maxLines: 400 })).toMatch(/lockfile/);
    expect(checkDiff(["ci_scripts/ci_post_clone.sh"], 3, { maxLines: 400 })).toMatch(/CI/);
    expect(checkDiff(["hymnal/Views/Search.swift", "hymnal.xcodeproj/project.pbxproj"], 30, { maxLines: 400 })).toBeNull();
    expect(sensitivePbxprojChange("+\t\t\t\tDEVELOPMENT_TEAM = ABC;")).toBe("DEVELOPMENT_TEAM");
    expect(sensitivePbxprojChange("-\t\t\t\tMARKETING_VERSION = 6.3.3;\n+\t\t\t\tMARKETING_VERSION = 6.3.4;")).toBe("MARKETING_VERSION");
    expect(sensitivePbxprojChange("+\t\tA1 /* Debounce.swift in Sources */")).toBeNull();
  });

  it("parses test counts", () => {
    expect(parseTestCount("Executed 42 tests, with 0 failures (0 unexpected) in 1.2s")).toBe(42);
    expect(parseTestCount("✔ Test run with 17 tests in 3 suites passed after 0.1 seconds.")).toBe(17);
    expect(parseTestCount("nothing")).toBeNull();
  });
});
