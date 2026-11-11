import fs from "node:fs";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, attemptRevisions, issues, jobs, runs } from "../db/schema";
import { config } from "../core/config";
import { logger } from "../core/logger";
import { notify } from "../notify/notify";

/**
 * On start, anything left `running` by a crash is marked failed with
 * "interrupted", and stale worktrees are removed (PLAN §6 "Failure handling").
 * No mid-run resume in v1.
 */
export function recoverAfterCrash(d: Db) {
  const now = new Date().toISOString();
  const err = "interrupted (worker restarted)";

  const staleRuns = d.select().from(runs).where(eq(runs.status, "running")).all();
  for (const r of staleRuns) {
    d.update(runs).set({ status: "failed", error: err, finishedAt: now, summary: "Interrupted by a worker restart." }).where(eq(runs.id, r.id)).run();
    notify(d, { projectId: r.projectId, kind: "run_failed", title: `Run #${r.id} was interrupted`, body: err, link: `/runs/${r.id}`, runId: r.id });
  }

  const staleAttempts = d.select().from(attempts).where(eq(attempts.status, "running")).all();
  for (const a of staleAttempts) {
    d.update(attempts).set({ status: "error", error: err, finishedAt: now }).where(eq(attempts.id, a.id)).run();
  }
  // Issues stuck mid-fix go back to triaged so the next run can pick them up.
  d.update(issues).set({ status: "triaged", statusReason: err, updatedAt: now }).where(inArray(issues.status, ["fixing", "queued"])).run();

  d.update(attemptRevisions).set({ status: "error", error: err, finishedAt: now }).where(eq(attemptRevisions.status, "running")).run();
  d.update(jobs).set({ status: "failed", error: err, finishedAt: now }).where(eq(jobs.status, "running")).run();

  const wt = config().worktreesDir;
  if (fs.existsSync(wt)) {
    for (const entry of fs.readdirSync(wt)) {
      fs.rmSync(`${wt}/${entry}`, { recursive: true, force: true });
    }
  }
  // `git worktree prune` for each clone happens lazily in projects/worktree.ts.

  if (staleRuns.length || staleAttempts.length) {
    logger.warn("recovered after crash", { runs: staleRuns.length, attempts: staleAttempts.length });
  }
}
