import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../client";
import { jobs, runs, type Job, type JobKind } from "../schema";

export function enqueueJob(
  kind: JobKind,
  opts: { projectId?: number; runId?: number; payload?: Record<string, unknown> } = {},
  d: Db = defaultDb(),
): Job {
  return d
    .insert(jobs)
    .values({ kind, projectId: opts.projectId, runId: opts.runId, payload: opts.payload })
    .returning()
    .get();
}

/** True when a job of this kind (and project) is already queued or running. */
export function hasPendingJob(kind: JobKind, projectId: number | null, d: Db = defaultDb()): boolean {
  const row = d
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, kind),
        projectId === null ? sql`${jobs.projectId} is null` : eq(jobs.projectId, projectId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .get();
  return !!row;
}

/** Atomically claim the oldest queued job. */
export function claimNextJob(d: Db = defaultDb()): Job | undefined {
  const row = d.$client
    .prepare(
      `update jobs set status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       where id = (select id from jobs where status = 'queued' order by id limit 1)
       returning id`,
    )
    .get() as { id: number } | undefined;
  if (!row) return undefined;
  return d.select().from(jobs).where(eq(jobs.id, row.id)).get();
}

export function finishJob(
  id: number,
  status: "succeeded" | "failed" | "cancelled",
  extra: { result?: unknown; error?: string } = {},
  d: Db = defaultDb(),
) {
  d.update(jobs)
    .set({ status, result: extra.result, error: extra.error, finishedAt: new Date().toISOString() })
    .where(eq(jobs.id, id))
    .run();
}

/**
 * Queue a pipeline run (PLAN §9: the web process only inserts rows).
 * Returns the run row; the worker picks up the matching job.
 */
export function requestRun(
  projectId: number,
  opts: { trigger: "schedule" | "manual"; dryRun?: boolean; issueId?: number },
  d: Db = defaultDb(),
) {
  return d.transaction((tx) => {
    const run = tx
      .insert(runs)
      .values({
        projectId,
        trigger: opts.trigger,
        dryRun: opts.dryRun ?? false,
        requestedIssueId: opts.issueId,
        status: "queued",
      })
      .returning()
      .get();
    tx.insert(jobs).values({ kind: "run", projectId, runId: run.id }).run();
    return run;
  });
}

export function requestCancelRun(runId: number, d: Db = defaultDb()) {
  d.transaction((tx) => {
    const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return;
    if (run.status === "queued") {
      tx.update(runs)
        .set({ status: "cancelled", finishedAt: new Date().toISOString(), summary: "Cancelled before it started." })
        .where(eq(runs.id, runId))
        .run();
      tx.update(jobs).set({ status: "cancelled", finishedAt: new Date().toISOString() }).where(and(eq(jobs.runId, runId), eq(jobs.status, "queued"))).run();
    } else if (run.status === "running") {
      tx.update(runs).set({ cancelRequested: true }).where(eq(runs.id, runId)).run();
    }
  });
}
