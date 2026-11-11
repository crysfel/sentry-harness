import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitOk, git } from "../github/git";
import { gh, ghJson } from "../github/gh";

/**
 * Publishing (PLAN §6.7). Deterministic code only: the agent never commits,
 * pushes or calls gh.
 */
export type PrBodyInput = {
  shortId: string;
  title: string;
  sentryUrl: string | null;
  users14d: number;
  events14d: number;
  firstRelease: string | null;
  covered: Array<{ shortId: string; title: string; sentryUrl: string | null }>;
  rootCause: string;
  summary: string;
  testCount: number | null;
  testsAdded: boolean;
  baseVersion: string | null;
  baseSha: string;
  confidence: string;
  attemptNumber: number;
  notes?: string;
};

export function prBody(i: PrBodyInput): string {
  const others = i.covered.filter((c) => c.shortId !== i.shortId);
  const tests = i.testCount !== null ? `${i.testCount} tests` : "tests";
  return `## Sentry issue
${i.shortId}: ${i.title}
${i.sentryUrl ?? ""} · ${i.users14d} users, ${i.events14d} events in 14 days · first seen in ${i.firstRelease ?? "unknown"}
${others.length ? `\nAlso addresses (same root cause):\n${others.map((o) => `- ${o.shortId}: ${o.title}${o.sentryUrl ? ` (${o.sentryUrl})` : ""}`).join("\n")}\n` : ""}
## Root cause
${i.rootCause}

## Fix
${i.summary}
${i.notes ? `\n${i.notes}\n` : ""}
## Verification
Build: passed · Tests: passed (${tests}, ${i.testsAdded ? "new tests added" : "no tests added"})
Based on ${i.baseVersion ?? "unknown version"} (${i.baseSha.slice(0, 10)}) · Confidence: ${i.confidence} · Attempt ${i.attemptNumber}

Opened by sentry-harness. This fix has not been run on a device.
`;
}

/** Commit subject: the agent's suggestion, cleaned to one safe line. */
export function commitSubject(suggested: string, fallback: string): string {
  const line = suggested.split("\n")[0].replace(/[\u0000-\u001f]/g, "").trim().slice(0, 72);
  return line || fallback;
}

export async function commitAll(cwd: string, subject: string, body: string, signal?: AbortSignal): Promise<string> {
  await gitOk(["add", "-A"], { cwd, signal });
  const file = path.join(os.tmpdir(), `harness-commit-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, `${subject}\n\n${body}\n`);
  try {
    await gitOk(["commit", "--no-verify", "-q", "-F", file], { cwd, signal });
  } finally {
    fs.rmSync(file, { force: true });
  }
  return gitOk(["rev-parse", "HEAD"], { cwd });
}

export async function pushBranch(cwd: string, branch: string, signal?: AbortSignal) {
  // Never force-push (PLAN §6.9.5).
  await gitOk(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd, auth: true, signal, timeoutMs: 10 * 60_000 });
}

async function ensureLabel(slug: string, label: string) {
  const r = await gh(["label", "list", "--repo", slug, "--search", label, "--json", "name"]);
  if (r.ok && (JSON.parse(r.stdout) as Array<{ name: string }>).some((l) => l.name === label)) return true;
  const c = await gh(["label", "create", label, "--repo", slug, "--color", "6f42c1", "--description", "Opened by sentry-harness"]);
  return c.ok;
}

export async function openPr(o: { slug: string; base: string; branch: string; title: string; body: string; draft: boolean; cwd: string }) {
  const labelOk = await ensureLabel(o.slug, "autofix");
  const bodyFile = path.join(os.tmpdir(), `harness-pr-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(bodyFile, o.body);
  try {
    const args = ["pr", "create", "--repo", o.slug, "--base", o.base, "--head", o.branch, "--title", o.title, "--body-file", bodyFile];
    if (o.draft) args.push("--draft");
    if (labelOk) args.push("--label", "autofix");
    const r = await gh(args, { cwd: o.cwd });
    if (!r.ok) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    const url = r.stdout.trim().split("\n").pop()!;
    const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    return { url, number, labelOk };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

export async function commentOnPr(slug: string, prNumber: number, body: string): Promise<string | null> {
  const bodyFile = path.join(os.tmpdir(), `harness-comment-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(bodyFile, body);
  try {
    const r = await gh(["pr", "comment", String(prNumber), "--repo", slug, "--body-file", bodyFile]);
    if (!r.ok) throw new Error(`gh pr comment failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r.stdout.trim().split("\n").pop() ?? null;
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

export async function remoteBranchSha(cwd: string, branch: string) {
  const r = await git(["ls-remote", "origin", `refs/heads/${branch}`], { cwd, auth: true });
  return r.ok ? r.stdout.split("\t")[0] || null : null;
}

export { ghJson };
