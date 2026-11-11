import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config";
import { git, gitOk } from "../github/git";

export type Worktree = { path: string; branch: string | null; baseSha: string };

function slugDir(projectId: number) {
  return path.join(config().worktreesDir, String(projectId));
}

/** Create a worktree on a new branch from `base` (default branch tip). */
export async function createWorktree(
  repoDir: string,
  projectId: number,
  name: string,
  opts: { branch?: string; base: string; signal?: AbortSignal },
): Promise<Worktree> {
  const dir = path.join(slugDir(projectId), name);
  await removeWorktree(repoDir, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (opts.branch) {
    await git(["branch", "-D", opts.branch], { cwd: repoDir });
    await gitOk(["worktree", "add", "-b", opts.branch, dir, opts.base], { cwd: repoDir, signal: opts.signal });
  } else {
    await gitOk(["worktree", "add", "--detach", dir, opts.base], { cwd: repoDir, signal: opts.signal });
  }
  const baseSha = await gitOk(["rev-parse", "HEAD"], { cwd: dir });
  return { path: dir, branch: opts.branch ?? null, baseSha };
}

export async function removeWorktree(repoDir: string, dir: string) {
  if (fs.existsSync(dir)) {
    await git(["worktree", "remove", "--force", dir], { cwd: repoDir });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await git(["worktree", "prune"], { cwd: repoDir });
}

/** Changed lines (added + deleted) and files vs base, including untracked files. */
export async function diffStats(dir: string, base: string) {
  await gitOk(["add", "-A", "--intent-to-add"], { cwd: dir });
  const numstat = await gitOk(["diff", "--numstat", base], { cwd: dir });
  let lines = 0;
  const files: string[] = [];
  for (const row of numstat.split("\n").filter(Boolean)) {
    const [a, del, file] = row.split("\t");
    lines += (Number(a) || 0) + (Number(del) || 0);
    files.push(file);
  }
  return { lines, files };
}
