import fs from "node:fs";
import path from "node:path";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, attemptIssues, issueGroups, issues, type Issue, type IssueStatus, type Project } from "../db/schema";
import { AgentError, runAgent } from "../agents/runner";
import { FixOutput } from "../agents/schemas";
import { FIX_SYSTEM, fixPrompt, repairPrompt } from "../agents/prompts";
import { fixPolicy, writeCommandScripts } from "../agents/policy";
import { writeSentryMcpConfig } from "../sentry/mcp-config";
import { config } from "../core/config";
import { runShellString, tail } from "../core/shell";
import type { EventLogger } from "../db/queries/events";
import { notify } from "../notify/notify";
import { createWorktree, removeWorktree } from "../projects/worktree";
import { readVersion } from "../projects/version";
import { verifyWorktree, type VerifyResult } from "./verify";
import { commitAll, commitSubject, openPr, prBody, pushBranch } from "./publish";
import { agentEventSink } from "./triage-stage";

export class UsageLimitReached extends Error {}

export type FixUnit = { primary: Issue; members: Issue[] };

export type FixDeps = {
  verify: typeof verifyWorktree;
  commit: typeof commitAll;
  push: typeof pushBranch;
  openPr: typeof openPr;
};
const defaultDeps: FixDeps = { verify: verifyWorktree, commit: commitAll, push: pushBranch, openPr };

export type FixResult = { attemptId: number; status: "pr_open" | "no_fix" | "verify_failed" | "error"; prUrl?: string; costUsd: number };

const setIssues = (d: Db, ids: number[], status: IssueStatus, reason: string, extra: Partial<typeof issues.$inferInsert> = {}) =>
  ids.length &&
  d.update(issues).set({ status, statusReason: reason, updatedAt: new Date().toISOString(), ...extra }).where(inArray(issues.id, ids)).run();

export async function fixUnit(
  d: Db,
  project: Project,
  runId: number,
  unit: FixUnit,
  baseSha: string,
  recentCommits: string[],
  log0: EventLogger,
  opts: { signal?: AbortSignal; deps?: Partial<FixDeps> } = {},
): Promise<FixResult> {
  const deps = { ...defaultDeps, ...opts.deps };
  const { primary } = unit;
  const memberIds = unit.members.map((m) => m.id);
  const repoDir = project.localPath!;
  const prior = d.select().from(attempts).where(eq(attempts.issueId, primary.id)).orderBy(attempts.number).all();
  const number = (prior.at(-1)?.number ?? 0) + 1;
  const branch = `autofix/${primary.shortId.toLowerCase()}-${number}`;
  const wtName = `${primary.shortId}-${number}`;
  const logFile = path.join(config().logsDir, `verify-${project.id}-${wtName}-run${runId}.log`);
  const transcriptPath = path.join(config().transcriptsDir, `run-${runId}-${wtName}.jsonl`);

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "", { flag: "a" });
  const attempt = d
    .insert(attempts)
    .values({ issueId: primary.id, runId, number, status: "running", branch, verifyLogPath: logFile, transcriptPath })
    .returning()
    .get();
  for (const m of unit.members) d.insert(attemptIssues).values({ attemptId: attempt.id, issueId: m.id }).onConflictDoNothing().run();
  const log = log0.with({ attemptId: attempt.id, issueId: primary.id });
  const finishAttempt = (values: Partial<typeof attempts.$inferInsert>) =>
    d.update(attempts).set({ finishedAt: new Date().toISOString(), ...values }).where(eq(attempts.id, attempt.id)).run();

  setIssues(d, memberIds, "fixing", `Attempt ${number} in progress.`);
  log.info("fix", `attempt ${number} on ${primary.shortId}${unit.members.length > 1 ? ` (group of ${unit.members.length})` : ""}, branch ${branch}`);

  let wtPath: string | null = null;
  let costUsd = 0;
  let turns = 0;
  const mcp = writeSentryMcpConfig(project.sentryOrg, project.sentryProject, project.sentryConnection);
  try {
    const wt = await createWorktree(repoDir, project.id, wtName, { branch, base: baseSha, signal: opts.signal });
    wtPath = wt.path;
    const baseVersion = await readVersion(wt.path, project.versionCmd);
    d.update(attempts).set({ baseSha: wt.baseSha, baseVersion, worktreePath: wt.path }).where(eq(attempts.id, attempt.id)).run();

    if (project.setupCmd) {
      log.info("fix", "running setup_cmd");
      const s = await runShellString(project.setupCmd, { cwd: wt.path, timeoutMs: 30 * 60_000, logFile, signal: opts.signal });
      if (!s.ok) throw new Error(`setup_cmd failed (exit ${s.exitCode}): ${tail(s.stderr || s.stdout, 10)}`);
    }

    const group = primary.groupId ? d.select().from(issueGroups).where(eq(issueGroups.id, primary.groupId)).get() : undefined;
    const others = unit.members.filter((m) => m.id !== primary.id);
    const prompt = fixPrompt({
      primary: {
        shortId: primary.shortId,
        sentryId: primary.sentryId,
        title: primary.title,
        url: primary.sentryUrl,
        users14d: primary.users14d,
        events14d: primary.events14d,
        culprit: primary.culprit,
        firstRelease: primary.firstRelease,
        triageSummary: primary.triageSummary,
        relevantFiles: primary.relevantFiles ?? [],
      },
      group: others.map((o) => ({ shortId: o.shortId, sentryId: o.sentryId, title: o.title, triageSummary: o.triageSummary })),
      groupReasoning: group?.reasoning ?? null,
      org: project.sentryOrg,
      project: project.sentryProject,
      priorAttempts: prior.map((a) => ({ number: a.number, status: a.status, rootCause: a.rootCause, summary: a.fixSummary, error: a.error, prUrl: a.prUrl })),
      buildCmd: project.buildCmd ? "the build script (path in the allowed commands)" : null,
      testCmd: project.testCmd ? "the test script (path in the allowed commands)" : null,
      baseVersion,
      recentCommits,
    });
    const scripts = writeCommandScripts(project.id, { build: project.buildCmd, test: project.testCmd });
    const promptWithScripts = `${prompt}\nTo build, run: ${scripts.build ?? "(no build command)"}\nTo test, run: ${scripts.test ?? "(no test command)"}\n`;
    const policy = fixPolicy(scripts);
    const agentBase = {
      cwd: wt.path,
      systemPrompt: FIX_SYSTEM,
      model: project.model,
      mcpConfigFile: mcp.file,
      ...policy,
      outputSchema: FixOutput,
      maxBudgetUsd: project.maxBudgetUsdPerAttempt,
      timeoutMs: config().AGENT_TIMEOUT_MINUTES * 60_000,
      transcriptPath,
      onEvent: agentEventSink(log, "fix"),
      signal: opts.signal,
    };

    let res = await runAgent({ ...agentBase, prompt: promptWithScripts });
    costUsd += res.costUsd;
    turns += res.turns;
    d.update(attempts).set({ sessionId: res.sessionId, costUsd, turns }).where(eq(attempts.id, attempt.id)).run();

    let out = res.output;
    const record = () =>
      d
        .update(attempts)
        .set({ rootCause: out.rootCause, fixSummary: out.summary, confidence: out.confidence, costUsd, turns })
        .where(eq(attempts.id, attempt.id))
        .run();
    record();

    if (out.outcome !== "fixed") {
      const status: IssueStatus = out.outcome === "needs_human" ? "needs_human" : "not_actionable";
      finishAttempt({ status: "no_fix", error: null });
      setIssues(d, memberIds, status, `Attempt ${number}: ${out.outcome === "no_fix" ? "no confident fix" : "needs a person"}. ${out.summary}`, {
        nextReviewAt: status === "not_actionable" ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null,
      });
      log.info("fix", `${primary.shortId}: ${out.outcome}. ${out.summary}`);
      return { attemptId: attempt.id, status: "no_fix", costUsd };
    }

    const diffPolicy = { maxLines: project.maxDiffLines };
    let v: VerifyResult = await deps.verify(wt.path, { baseSha: wt.baseSha, buildCmd: project.buildCmd, testCmd: project.testCmd, logFile, diff: diffPolicy, signal: opts.signal });
    if (!v.ok) {
      log.warn("verify", `${v.step} failed (${v.reason}); asking the agent to repair once`);
      res = await runAgent({ ...agentBase, prompt: repairPrompt(v.step, v.outputTail.slice(-12_000)), resumeSessionId: res.sessionId });
      costUsd += res.costUsd;
      turns += res.turns;
      out = res.output;
      record();
      if (out.outcome === "fixed") {
        v = await deps.verify(wt.path, { baseSha: wt.baseSha, buildCmd: project.buildCmd, testCmd: project.testCmd, logFile, diff: diffPolicy, signal: opts.signal });
      }
    }
    d.update(attempts).set({ buildOk: v.buildOk, testsOk: v.ok ? true : v.testsOk, filesChanged: v.files }).where(eq(attempts.id, attempt.id)).run();

    if (!v.ok || out.outcome !== "fixed") {
      const reason = !v.ok ? `${v.step}: ${v.reason}` : `agent gave up after repair: ${out.summary}`;
      finishAttempt({ status: "verify_failed", error: reason });
      const exhausted = number >= project.maxAttemptsPerIssue;
      setIssues(d, memberIds, exhausted ? "needs_human" : "attempt_failed", `Attempt ${number} failed verification (${reason}).${exhausted ? " Attempts exhausted." : ""}`);
      log.error("verify", `${primary.shortId}: verification failed, no PR opened. ${reason}`);
      notify(d, { projectId: project.id, kind: "attempt_failed", title: `${primary.shortId}: attempt ${number} failed verification`, body: reason, link: `/issues/${primary.id}`, issueId: primary.id, attemptId: attempt.id });
      return { attemptId: attempt.id, status: "verify_failed", costUsd };
    }

    // Coverage: issues the agent says its change does not address leave the group (PLAN §6.5.3).
    const covered = new Set(out.coveredSentryIds.length ? out.coveredSentryIds : [primary.sentryId]);
    covered.add(primary.sentryId);
    const coveredMembers = unit.members.filter((m) => covered.has(m.sentryId));
    const uncovered = unit.members.filter((m) => !covered.has(m.sentryId));
    for (const m of unit.members) {
      d.update(attemptIssues).set({ covered: covered.has(m.sentryId) }).where(and(eq(attemptIssues.attemptId, attempt.id), eq(attemptIssues.issueId, m.id))).run();
    }
    if (uncovered.length) {
      setIssues(d, uncovered.map((m) => m.id), "triaged", `Not addressed by ${primary.shortId}'s fix; removed from its group.`, { groupId: null });
      log.info("fix", `fix does not cover ${uncovered.map((m) => m.shortId).join(", ")}; removed them from the group`);
      // Lock the group so the next triage does not put them back on title similarity alone.
      if (primary.groupId) {
        d.update(issueGroups)
          .set({ locked: true, reasoning: `${group?.reasoning ?? ""} (Harness: the fix for ${primary.shortId} did not address ${uncovered.map((m) => m.shortId).join(", ")}, so they were removed and the group locked.)`.trim(), updatedAt: new Date().toISOString() })
          .where(eq(issueGroups.id, primary.groupId))
          .run();
      }
    }

    // Publish (PLAN §6.7).
    const subject = commitSubject(out.commitSubject, `Fixing ${primary.shortId}`);
    const commitBody = `Fixes Sentry ${coveredMembers.map((m) => m.shortId).join(", ")}.\n\n${out.rootCause}`;
    await deps.commit(wt.path, subject, commitBody, opts.signal);
    await deps.push(wt.path, branch, opts.signal);
    const body = prBody({
      shortId: primary.shortId,
      title: primary.title,
      sentryUrl: primary.sentryUrl,
      users14d: primary.users14d,
      events14d: primary.events14d,
      firstRelease: primary.firstRelease,
      covered: coveredMembers.map((m) => ({ shortId: m.shortId, title: m.title, sentryUrl: m.sentryUrl })),
      rootCause: out.rootCause,
      summary: out.summary,
      testCount: v.testCount,
      testsAdded: out.testsAdded,
      baseVersion,
      baseSha: wt.baseSha,
      confidence: out.confidence,
      attemptNumber: number,
    });
    const pr = await deps.openPr({ slug: project.repoSlug, base: project.defaultBranch!, branch, title: subject, body, draft: project.prDraft, cwd: wt.path });
    finishAttempt({ status: "pr_open", prNumber: pr.number, prUrl: pr.url, prState: "OPEN" });
    setIssues(d, coveredMembers.map((m) => m.id), "pr_open", `PR #${pr.number} opened (attempt ${number}).`);
    log.info("publish", `opened PR #${pr.number}: ${pr.url}`);
    notify(d, {
      projectId: project.id,
      kind: "pr_opened",
      title: `${primary.shortId}: PR #${pr.number} opened`,
      body: `${subject}. Confidence ${out.confidence}.${coveredMembers.length > 1 ? ` Covers ${coveredMembers.map((m) => m.shortId).join(", ")}.` : ""}`,
      link: `/issues/${primary.id}`,
      issueId: primary.id,
      attemptId: attempt.id,
    });
    return { attemptId: attempt.id, status: "pr_open", prUrl: pr.url, costUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentError) {
      costUsd += err.details.costUsd ?? 0;
      turns += err.details.turns ?? 0;
    }
    finishAttempt({ status: "error", error: message, costUsd, turns });
    setIssues(d, memberIds, "attempt_failed", `Attempt ${number} errored: ${message.slice(0, 300)}`);
    log.error("fix", `${primary.shortId}: attempt ${number} errored: ${message}`);
    if (err instanceof AgentError && err.kind === "usage_limit") throw new UsageLimitReached(message);
    if (err instanceof AgentError && err.kind === "cancelled") throw err;
    notify(d, { projectId: project.id, kind: "attempt_failed", title: `${primary.shortId}: attempt ${number} errored`, body: message.slice(0, 500), link: `/issues/${primary.id}`, issueId: primary.id, attemptId: attempt.id });
    return { attemptId: attempt.id, status: "error", costUsd };
  } finally {
    mcp.cleanup();
    if (wtPath) await removeWorktree(repoDir, wtPath).catch(() => undefined);
  }
}

export function attemptsUsed(d: Db, issueId: number): number {
  return d.select({ n: count() }).from(attempts).where(and(eq(attempts.issueId, issueId), inArray(attempts.status, ["no_fix", "verify_failed", "error", "closed_unmerged", "pr_open", "merged"]))).get()?.n ?? 0;
}

export function lastAttempt(d: Db, issueId: number) {
  return d.select().from(attempts).where(eq(attempts.issueId, issueId)).orderBy(desc(attempts.id)).get();
}
