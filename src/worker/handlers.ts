import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, type Job, type JobKind } from "../db/schema";
import { eventLogger } from "../db/queries/events";

export class JobCancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
  }
}

export type JobContext = { db: Db; signal: AbortSignal };
export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

function requireProject(d: Db, job: Job) {
  if (!job.projectId) throw new Error(`${job.kind} job #${job.id} has no project`);
  const p = d.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!p) throw new Error(`project ${job.projectId} not found`);
  return p;
}

export const handlers: Record<JobKind, JobHandler> = {
  async clone_project(job, { db, signal }) {
    const { cloneProject } = await import("../projects/clone");
    return cloneProject(db, requireProject(db, job), eventLogger({ jobId: job.id }), { signal });
  },

  async test_config(job, { db, signal }) {
    const { testProjectConfig } = await import("../projects/test-config");
    const res = await testProjectConfig(db, requireProject(db, job), eventLogger({ jobId: job.id }), { jobId: job.id, signal });
    if (!res.ok) throw new Error(res.steps.map((s) => `${s.step}: ${s.ok ? "ok" : "failed"}`).join(", ") || "no steps ran");
    return res;
  },

  async run(job, { db, signal }) {
    if (!job.runId) throw new Error("run job without run id");
    const { executeRun } = await import("../pipeline/run");
    return executeRun(db, job.runId, { signal });
  },

  async feedback_poll(job, { db, signal }) {
    const { pollFeedback } = await import("../pipeline/feedback");
    return pollFeedback(db, { jobId: job.id, projectId: job.projectId, signal });
  },

  async revise_pr(job, { db, signal }) {
    const { revisePr } = await import("../pipeline/revise");
    const attemptId = Number(job.payload?.attemptId);
    if (!attemptId) throw new Error("revise_pr job without attemptId");
    return revisePr(db, attemptId, { jobId: job.id, signal });
  },

  async health_check(job, { db }) {
    const { runHealthChecks } = await import("../core/health");
    return runHealthChecks(db);
  },
};
