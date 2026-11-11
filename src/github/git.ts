import { config } from "../core/config";
import { run, runOk, type RunOptions, type RunResult } from "../core/shell";

/**
 * git, run by harness code only (never by an agent). Authentication is HTTPS
 * with the scoped token, supplied through an inline credential helper that
 * reads it from the child's environment, so the token is never written to
 * disk, to .git/config, or into a URL (PLAN §7.1.2). No SSH key is used.
 */
const CREDENTIAL_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$HARNESS_GIT_TOKEN"; }; f';

export type GitOptions = Omit<RunOptions, "env"> & { auth?: boolean; token?: string };

function gitArgs(args: string[], auth: boolean): string[] {
  const base = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never"];
  if (!auth) return [...base, ...args];
  return [...base, "-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, ...args];
}

function gitEnv(opts: GitOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: "false", // refuse SSH: nothing may depend on the owner's key
  };
  if (opts.auth) {
    const token = opts.token ?? config().HARNESS_GITHUB_TOKEN;
    if (!token) throw new Error("HARNESS_GITHUB_TOKEN is not set; cannot reach GitHub.");
    env.HARNESS_GIT_TOKEN = token;
  }
  return env;
}

export function git(args: string[], opts: GitOptions = {}): Promise<RunResult> {
  const { auth = false, ...rest } = opts;
  delete (rest as { token?: string }).token;
  return run("git", gitArgs(args, auth), { timeoutMs: 5 * 60_000, ...rest, env: gitEnv(opts) });
}

export async function gitOk(args: string[], opts: GitOptions = {}): Promise<string> {
  const { auth = false, ...rest } = opts;
  delete (rest as { token?: string }).token;
  const r = await runOk("git", gitArgs(args, auth), { timeoutMs: 5 * 60_000, ...rest, env: gitEnv(opts) });
  return r.stdout.trim();
}

export function httpsUrl(slug: string) {
  return `https://github.com/${slug}.git`;
}

/** Accepts owner/name, https URLs and git@ URLs; returns owner/name or null. */
export function parseRepoSlug(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const [owner, name] = [m[1], m[2]];
  if (owner.startsWith(".") || name.startsWith(".") || owner.startsWith("-") || name.startsWith("-")) return null;
  return `${owner}/${name}`;
}

export async function headSha(cwd: string, ref = "HEAD") {
  return gitOk(["rev-parse", ref], { cwd });
}

export async function currentBranchOfRemote(cwd: string): Promise<string | null> {
  const r = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
  return r.ok ? r.stdout.trim().replace(/^origin\//, "") : null;
}

/** Fetch and hard-reset the clone's default branch to origin (the clone is harness-owned). */
export async function syncDefaultBranch(cwd: string, branch: string, signal?: AbortSignal) {
  await gitOk(["fetch", "--prune", "origin"], { cwd, auth: true, signal });
  await gitOk(["checkout", "-q", "-B", branch, `origin/${branch}`], { cwd, signal });
  await gitOk(["reset", "-q", "--hard", `origin/${branch}`], { cwd, signal });
  await gitOk(["clean", "-qfdx", "-e", ".build"], { cwd, signal });
  return headSha(cwd);
}

export async function recentCommitSubjects(cwd: string, n = 30): Promise<string[]> {
  const out = await gitOk(["log", `-${n}`, "--format=%h %ad %s", "--date=short"], { cwd });
  return out ? out.split("\n") : [];
}
