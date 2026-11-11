import { config } from "../core/config";
import { run, runOk, type RunOptions } from "../core/shell";

/**
 * The gh CLI, run by harness code only, always with the scoped token in
 * GH_TOKEN and an isolated config dir so the owner's own gh login is never used.
 */
function ghEnv(token?: string) {
  const t = token ?? config().HARNESS_GITHUB_TOKEN;
  if (!t) throw new Error("HARNESS_GITHUB_TOKEN is not set; cannot reach GitHub.");
  return {
    GH_TOKEN: t,
    GH_CONFIG_DIR: `${config().dataDir}/gh-config`,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
}

export type GhOptions = Omit<RunOptions, "env"> & { token?: string };

export async function gh(args: string[], opts: GhOptions = {}) {
  const { token, ...rest } = opts;
  return run("gh", args, { timeoutMs: 2 * 60_000, ...rest, env: ghEnv(token) });
}

export async function ghJson<T>(args: string[], opts: GhOptions = {}): Promise<T> {
  const { token, ...rest } = opts;
  const r = await runOk("gh", args, { timeoutMs: 2 * 60_000, ...rest, env: ghEnv(token) });
  return JSON.parse(r.stdout) as T;
}

/** GET a REST endpoint, following pagination, returning a flat array. */
export async function ghApiList<T>(endpoint: string, opts: GhOptions = {}): Promise<T[]> {
  const { token, ...rest } = opts;
  const r = await runOk("gh", ["api", "--paginate", "--slurp", endpoint], { timeoutMs: 2 * 60_000, ...rest, env: ghEnv(token) });
  const pages = JSON.parse(r.stdout) as T[][];
  return pages.flat();
}

export type RepoAccess = {
  ok: boolean;
  message: string;
  defaultBranch?: string;
  ownerLogin?: string;
  isPrivate?: boolean;
};

/**
 * Check that the scoped token can read and push to the repository before
 * cloning (PLAN §7.1.3), with an exact message when it cannot.
 */
export async function checkRepoAccess(slug: string, opts: GhOptions = {}): Promise<RepoAccess> {
  let r;
  try {
    r = await gh(["api", `repos/${slug}`], opts);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!r.ok) {
    const text = `${r.stdout}\n${r.stderr}`;
    if (/Not Found|HTTP 404/i.test(text)) {
      return {
        ok: false,
        message: `The GitHub token cannot see ${slug}. Either the repository does not exist, or the fine-grained token's "Repository access" list does not include it. Add ${slug} to the token on github.com → Settings → Developer settings → Fine-grained tokens, then retry.`,
      };
    }
    if (/Bad credentials|HTTP 401/i.test(text)) {
      return { ok: false, message: "GitHub rejected HARNESS_GITHUB_TOKEN (bad or expired credentials). Create a new fine-grained token and update .env." };
    }
    return { ok: false, message: `GitHub API error for ${slug}: ${text.trim().split("\n").slice(-3).join(" ")}` };
  }
  const repo = JSON.parse(r.stdout) as {
    default_branch: string;
    private: boolean;
    owner: { login: string };
    permissions?: { pull?: boolean; push?: boolean };
  };
  if (repo.permissions && !repo.permissions.push) {
    return {
      ok: false,
      message: `The GitHub token can read ${slug} but cannot push to it. Give the fine-grained token "Contents: Read and write" and "Pull requests: Read and write" on this repository.`,
      defaultBranch: repo.default_branch,
    };
  }
  return { ok: true, message: "ok", defaultBranch: repo.default_branch, ownerLogin: repo.owner.login, isPrivate: repo.private };
}

export type PrState = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  url: string;
};

export function prView(slug: string, prNumber: number, opts: GhOptions = {}) {
  return ghJson<PrState>(["pr", "view", String(prNumber), "--repo", slug, "--json", "state,mergedAt,mergeCommit,url"], opts);
}

export async function branchProtected(slug: string, branch: string, opts: GhOptions = {}): Promise<boolean | null> {
  const r = await gh(["api", `repos/${slug}/branches/${encodeURIComponent(branch)}`, "--jq", ".protected"], opts);
  if (!r.ok) return null;
  return r.stdout.trim() === "true";
}
