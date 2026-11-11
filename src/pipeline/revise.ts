import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attemptRevisions, attempts, issues, prFeedback, projects } from "../db/schema";
import { eventLogger } from "../db/queries/events";
import { AgentError, runAgent } from "../agents/runner";
import { RevisionOutput, type RevisionOutput as RevOut } from "../agents/schemas";
import { FIX_SYSTEM, repairPrompt, UNTRUSTED_DATA_RULE } from "../agents/prompts";
import { fixPolicy, writeCommandScripts } from "../agents/policy";
import { writeSentryMcpConfig } from "../sentry/mcp-config";
import { config, ensureDataDirs } from "../core/config";
import { gitOk } from "../github/git";
import { notify } from "../notify/notify";
import { createWorktree, removeWorktree } from "../projects/worktree";
import { verifyWorktree, type VerifyResult } from "./verify";
import { commentOnPr, commitAll, commitSubject, pushBranch } from "./publish";
import { agentEventSink } from "./triage-stage";
import { HARNESS_MARKER, pendingFeedback, revisionCount } from "./feedback";
import { UsageLimitReached } from "./fix-stage";

export type ReviseDeps = {
  fetchBranch: (repoDir: string, branch: string) => Promise<string>;
  verify: typeof verifyWorktree;
  commit: typeof commitAll;
  push: typeof pushBranch;
  comment: typeof commentOnPr;
};

const defaultDeps: ReviseDeps = {
  fetchBranch: async (repoDir, branch) => {
    await gitOk(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repoDir, auth: true });
    return gitOk(["rev-parse", `refs/remotes/origin/${branch}`], { cwd: repoDir });
  },
  verify: verifyWorktree,
  commit: commitAll,
  push: pushBranch,
  comment: commentOnPr,
};

function quote(s: string, max = 400) {
  const t = s.trim().length > max ? s.trim().slice(0, max) + "…" : s.trim();
  return t
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

export function revisionPrompt(o: {
  shortId: string;
  prNumber: number;
  rootCause: string | null;
  fixSummary: string | null;
  diff: string;
  comments: Array<{ githubId: string; author: string; kind: string; path: string | null; line: number | null; diffHunk: string | null; body: string }>;
  build: string | null;
  test: string | null;
}) {
  return `The owner reviewed pull request #${o.prNumber}, which fixes Sentry issue ${o.shortId}, and left the comments below. Address every comment: change the code when the comment is right, or explain briefly why not. Keep changes minimal.

${UNTRUSTED_DATA_RULE}

## The fix so far
Root cause: ${o.rootCause ?? "unknown"}
Summary: ${o.fixSummary ?? "unknown"}

Current diff against the default branch:
\`\`\`diff
${o.diff.slice(0, 30_000)}
\`\`\`

## Review comments
${o.comments
  .map(
    (c) => `### Comment ${c.githubId} by @${c.author} (${c.kind}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : ""})
${c.diffHunk ? `\`\`\`diff\n${c.diffHunk.slice(-1500)}\n\`\`\`\n` : ""}<comment>
${c.body}
</comment>`,
  )
  .join("\n\n")}

## Commands
Build: ${o.build ?? "(none)"}
Test: ${o.test ?? "(none)"}

Return outcome "revised" if you changed code, "reply_only" if every comment is answered without code changes, or "needs_human" if a person must decide. Give one entry in responses per comment id above, with a short reply that will be posted on the PR. commitSubject: one short line in the repository's style.`;
}

/** Revision job (PLAN §6.9). Never force-pushes; never changes which issues the attempt covers. */
export async function revisePr(d: Db, attemptId: number, o: { jobId: number; signal?: AbortSignal; deps?: Partial<ReviseDeps> }) {
  ensureDataDirs();
  const deps = { ...defaultDeps, ...o.deps };
  const a = d.select().from(attempts).where(eq(attempts.id, attemptId)).get();
  if (!a || a.status !== "pr_open" || !a.prNumber || !a.branch) return { skipped: "attempt has no open PR" };
  const issue = d.select().from(issues).where(eq(issues.id, a.issueId)).get()!;
  const p = d.select().from(projects).where(eq(projects.id, issue.projectId)).get()!;
  const pending = pendingFeedback(d, a.id);
  if (!pending.length) return { skipped: "no pending feedback" };
  if (revisionCount(d, a.id) >= p.maxRevisionsPerPr) return { skipped: "revision limit reached" };

  const number = revisionCount(d, a.id) + 1;
  const wtName = `${issue.shortId}-${a.number}`; // same path as the original attempt so its session can resume
  const logFile = path.join(config().logsDir, `revision-${p.id}-${wtName}-r${number}.log`);
  const transcriptPath = path.join(config().transcriptsDir, `attempt-${a.id}-revision-${number}.jsonl`);
  const rev = d.insert(attemptRevisions).values({ attemptId: a.id, number, status: "running", transcriptPath }).returning().get();
  const log = eventLogger({ jobId: o.jobId, attemptId: a.id, issueId: issue.id });
  const finish = (values: Partial<typeof attemptRevisions.$inferInsert>) =>
    d.update(attemptRevisions).set({ finishedAt: new Date().toISOString(), ...values }).where(eq(attemptRevisions.id, rev.id)).run();
  const markHandled = () => d.update(prFeedback).set({ revisionId: rev.id }).where(inArray(prFeedback.id, pending.map((f) => f.id))).run();

  log.info("revise", `revision ${number} of PR #${a.prNumber} for ${pending.length} comment(s)`);
  let wtPath: string | null = null;
  let costUsd = 0;
  let turns = 0;
  const mcp = writeSentryMcpConfig(p.sentryOrg, p.sentryProject);
  try {
    const headSha = await deps.fetchBranch(p.localPath!, a.branch);
    const wt = await createWorktree(p.localPath!, p.id, wtName, { branch: `${a.branch}-rev${number}`, base: headSha, signal: o.signal });
    wtPath = wt.path;
    const diff = (await gitOk(["diff", `${a.baseSha ?? "HEAD~1"}...HEAD`], { cwd: wt.path }).catch(() => "")) || "(diff unavailable)";
    const scripts = writeCommandScripts(p.id, { build: p.buildCmd, test: p.testCmd });
    const prompt = revisionPrompt({
      shortId: issue.shortId,
      prNumber: a.prNumber,
      rootCause: a.rootCause,
      fixSummary: a.fixSummary,
      diff,
      comments: pending.map((f) => ({ githubId: f.githubId, author: f.author, kind: f.kind, path: f.path, line: f.line, diffHunk: f.diffHunk, body: f.body ?? "" })),
      build: scripts.build ?? null,
      test: scripts.test ?? null,
    });
    const base = {
      cwd: wt.path,
      systemPrompt: FIX_SYSTEM,
      model: p.model,
      mcpConfigFile: mcp.file,
      ...fixPolicy(scripts),
      outputSchema: RevisionOutput,
      maxBudgetUsd: p.maxBudgetUsdPerAttempt,
      timeoutMs: config().AGENT_TIMEOUT_MINUTES * 60_000,
      transcriptPath,
      onEvent: agentEventSink(log, "revise"),
      signal: o.signal,
    };

    let res;
    try {
      res = await runAgent({ ...base, prompt, resumeSessionId: a.sessionId ?? undefined });
    } catch (err) {
      if (!(err instanceof AgentError) || err.kind !== "process" || !a.sessionId) throw err;
      log.warn("revise", "could not resume the original session; starting a new one");
      res = await runAgent({ ...base, prompt });
    }
    costUsd += res.costUsd;
    turns += res.turns;
    let out: RevOut = res.output;
    d.update(attemptRevisions).set({ sessionId: res.sessionId, costUsd, turns, summary: out.summary }).where(eq(attemptRevisions.id, rev.id)).run();

    const replies = (verifyNote?: string) => {
      const byId = new Map(out.responses.map((r) => [r.githubId, r]));
      const parts = pending.map((f) => {
        const r = byId.get(f.githubId);
        return `${quote(f.body ?? "")}\n\n${r ? `**${r.action}**: ${r.reply}` : "_Not addressed in this revision._"}`;
      });
      return `${HARNESS_MARKER}\n**sentry-harness revision ${number}**: ${out.summary}\n\n${verifyNote ? `${verifyNote}\n\n` : ""}${parts.join("\n\n---\n\n")}`;
    };

    if (out.outcome === "needs_human") {
      const url = await deps.comment(p.repoSlug, a.prNumber, replies("This needs a decision from a person, so no code was changed."));
      finish({ status: "replied_only", replyCommentUrl: url, costUsd, turns });
      markHandled();
      d.update(issues).set({ status: "needs_human", statusReason: `Review on PR #${a.prNumber} needs a person.` }).where(eq(issues.id, issue.id)).run();
      notify(d, { projectId: p.id, kind: "pr_revised", title: `${issue.shortId}: PR #${a.prNumber} needs you`, body: out.summary, link: `/issues/${issue.id}`, issueId: issue.id, attemptId: a.id });
      return { status: "replied_only" };
    }

    let status: "pushed" | "replied_only" | "verify_failed" = "replied_only";
    let commitSha: string | null = null;
    let verifyNote: string | undefined;
    if (out.outcome === "revised") {
      const diffPolicy = { maxLines: p.maxDiffLines };
      let v: VerifyResult = await deps.verify(wt.path, { baseSha: headSha, buildCmd: p.buildCmd, testCmd: p.testCmd, logFile, diff: diffPolicy, signal: o.signal });
      if (!v.ok) {
        log.warn("revise", `${v.step} failed (${v.reason}); one repair round`);
        const r2 = await runAgent({ ...base, prompt: repairPrompt(v.step, v.outputTail.slice(-12_000)), resumeSessionId: res.sessionId });
        costUsd += r2.costUsd;
        turns += r2.turns;
        out = r2.output;
        if (out.outcome === "revised") v = await deps.verify(wt.path, { baseSha: headSha, buildCmd: p.buildCmd, testCmd: p.testCmd, logFile, diff: diffPolicy, signal: o.signal });
      }
      if (v.ok && out.outcome === "revised") {
        commitSha = await deps.commit(wt.path, commitSubject(out.commitSubject, `Addressing review on ${issue.shortId}`), `Revision ${number} for PR #${a.prNumber}.`, o.signal);
        await deps.push(wt.path, a.branch, o.signal);
        status = "pushed";
      } else {
        status = "verify_failed";
        verifyNote = `⚠️ My revision did not pass ${!v.ok ? `the ${v.step} (${v.reason})` : "verification"}, so I pushed nothing. The replies below describe what I tried.`;
      }
    }
    const url = await deps.comment(p.repoSlug, a.prNumber, replies(verifyNote));
    finish({ status, commitSha, replyCommentUrl: url, costUsd, turns, summary: out.summary });
    markHandled();
    log.info("revise", `revision ${number}: ${status}${commitSha ? ` (${commitSha.slice(0, 10)})` : ""}`);
    notify(d, {
      projectId: p.id,
      kind: status === "verify_failed" ? "revision_failed" : "pr_revised",
      title: `${issue.shortId}: ${status === "verify_failed" ? "revision failed verification" : status === "pushed" ? "PR revised" : "replied to review"} on PR #${a.prNumber}`,
      body: out.summary,
      link: `/issues/${issue.id}`,
      issueId: issue.id,
      attemptId: a.id,
    });
    return { status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentError) {
      costUsd += err.details.costUsd ?? 0;
    }
    finish({ status: "error", error: message, costUsd, turns });
    log.error("revise", `revision ${number} errored: ${message}`);
    notify(d, { projectId: p.id, kind: "revision_failed", title: `${issue.shortId}: revision ${number} errored`, body: message.slice(0, 500), link: `/issues/${issue.id}`, issueId: issue.id, attemptId: a.id });
    if (err instanceof AgentError && err.kind === "usage_limit") throw new UsageLimitReached(message);
    throw err;
  } finally {
    mcp.cleanup();
    if (wtPath) await removeWorktree(p.localPath!, wtPath).catch(() => undefined);
  }
}
