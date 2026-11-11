import "server-only";
import { connection } from "next/server";
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/src/db/client";
import {
  attemptIssues,
  attemptRevisions,
  attempts,
  issueGroups,
  issues,
  issueSnapshots,
  jobs,
  notifications,
  prFeedback,
  projects,
  runEvents,
  runs,
  settings,
  type IssueStatus,
} from "@/src/db/schema";
import { Cron } from "croner";

/**
 * Read model for the dashboard. Every function awaits `connection()` first:
 * better-sqlite3 is synchronous, and without it reads would be baked into the
 * prerendered shell (see node_modules/next/dist/docs …/connection.md).
 */

export async function getProjects() {
  await connection();
  return db().select().from(projects).orderBy(asc(projects.name)).all();
}

export async function getProject(id: number) {
  await connection();
  return db().select().from(projects).where(eq(projects.id, id)).get();
}

export function nextScheduledRun(cronExpr: string, enabled: boolean): Date | null {
  if (!enabled) return null;
  try {
    return new Cron(cronExpr, { paused: true }).nextRun();
  } catch {
    return null;
  }
}

export async function getOverview() {
  await connection();
  const d = db();
  const ps = d.select().from(projects).orderBy(asc(projects.name)).all();
  return ps.map((p) => {
    const lastRun = d.select().from(runs).where(eq(runs.projectId, p.id)).orderBy(desc(runs.id)).get();
    const statusCounts = Object.fromEntries(
      d
        .select({ status: issues.status, n: count() })
        .from(issues)
        .where(eq(issues.projectId, p.id))
        .groupBy(issues.status)
        .all()
        .map((r) => [r.status, r.n]),
    ) as Partial<Record<IssueStatus, number>>;
    const attention = d
      .select({ issue: issues, attempt: attempts })
      .from(issues)
      .leftJoin(attempts, and(eq(attempts.issueId, issues.id), inArray(attempts.status, ["pr_open", "verify_failed", "error"])))
      .where(and(eq(issues.projectId, p.id), inArray(issues.status, ["pr_open", "regressed", "attempt_failed", "needs_human"])))
      .orderBy(desc(issues.impactScore))
      .all();
    const pending = d.select().from(runs).where(and(eq(runs.projectId, p.id), inArray(runs.status, ["queued", "running"]))).get();
    return { project: p, lastRun, statusCounts, attention, pending, nextRun: nextScheduledRun(p.scheduleCron, p.enabled) };
  });
}

export type IssueFilters = { project?: number; status?: string; q?: string; sort?: string };

export async function getIssues(f: IssueFilters) {
  await connection();
  const d = db();
  const where: SQL[] = [];
  if (f.project) where.push(eq(issues.projectId, f.project));
  if (f.status === "open") where.push(sql`${issues.status} not in ('verified_fixed','ignored','not_in_repo')`);
  else if (f.status) where.push(eq(issues.status, f.status as IssueStatus));
  if (f.q) where.push(or(like(issues.shortId, `%${f.q}%`), like(issues.title, `%${f.q}%`), like(issues.culprit, `%${f.q}%`))!);
  const order =
    f.sort === "users" ? [desc(issues.users14d)] : f.sort === "events" ? [desc(issues.events14d)] : f.sort === "recent" ? [desc(issues.lastSeen)] : f.sort === "status" ? [asc(issues.status), desc(issues.impactScore)] : [sql`${issues.impactScore} is null`, desc(issues.impactScore), desc(issues.users14d)];
  const rows = d
    .select({ issue: issues, projectName: projects.name })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order)
    .all();
  const ids = rows.map((r) => r.issue.id);
  const lastAttempts = new Map<number, typeof attempts.$inferSelect>();
  const trends = new Map<number, number[]>();
  if (ids.length) {
    for (const a of d.select().from(attempts).where(inArray(attempts.issueId, ids)).orderBy(asc(attempts.id)).all()) lastAttempts.set(a.issueId, a);
    for (const s of d.select().from(issueSnapshots).where(inArray(issueSnapshots.issueId, ids)).orderBy(asc(issueSnapshots.id)).all()) {
      const t = trends.get(s.issueId) ?? [];
      t.push(s.users14d);
      trends.set(s.issueId, t.slice(-10));
    }
  }
  return rows.map((r) => ({ ...r, lastAttempt: lastAttempts.get(r.issue.id), trend: trends.get(r.issue.id) ?? [] }));
}

export async function getIssue(id: number) {
  await connection();
  const d = db();
  const issue = d.select().from(issues).where(eq(issues.id, id)).get();
  if (!issue) return null;
  const project = d.select().from(projects).where(eq(projects.id, issue.projectId)).get()!;
  const group = issue.groupId ? d.select().from(issueGroups).where(eq(issueGroups.id, issue.groupId)).get() : undefined;
  const groupMembers = issue.groupId ? d.select().from(issues).where(eq(issues.groupId, issue.groupId)).all() : [];
  const groupCandidates = d
    .select({ id: issues.id, shortId: issues.shortId, title: issues.title })
    .from(issues)
    .where(and(eq(issues.projectId, issue.projectId), sql`${issues.id} != ${issue.id}`, issue.groupId ? sql`(${issues.groupId} is null or ${issues.groupId} != ${issue.groupId})` : sql`1=1`))
    .orderBy(desc(issues.users14d))
    .limit(50)
    .all();

  // Attempts where this issue is primary or covered.
  const viaJoin = d.select({ id: attemptIssues.attemptId }).from(attemptIssues).where(eq(attemptIssues.issueId, id)).all().map((r) => r.id);
  const atts = d
    .select()
    .from(attempts)
    .where(viaJoin.length ? or(eq(attempts.issueId, id), inArray(attempts.id, viaJoin)) : eq(attempts.issueId, id))
    .orderBy(desc(attempts.id))
    .all();
  const attemptIds = atts.map((a) => a.id);
  const covered = attemptIds.length ? d.select({ ai: attemptIssues, shortId: issues.shortId }).from(attemptIssues).innerJoin(issues, eq(issues.id, attemptIssues.issueId)).where(inArray(attemptIssues.attemptId, attemptIds)).all() : [];
  const revisions = attemptIds.length ? d.select().from(attemptRevisions).where(inArray(attemptRevisions.attemptId, attemptIds)).orderBy(asc(attemptRevisions.id)).all() : [];
  const feedback = attemptIds.length ? d.select().from(prFeedback).where(inArray(prFeedback.attemptId, attemptIds)).orderBy(asc(prFeedback.createdAt)).all() : [];
  const snapshots = d.select().from(issueSnapshots).where(eq(issueSnapshots.issueId, id)).orderBy(asc(issueSnapshots.id)).all();
  const timeline = d
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.issueId, id), inArray(runEvents.level, ["info", "warn", "error"])))
    .orderBy(desc(runEvents.id))
    .limit(100)
    .all();
  const pendingRun = d.select().from(runs).where(and(eq(runs.requestedIssueId, id), inArray(runs.status, ["queued", "running"]))).get();
  return { issue, project, group, groupMembers, groupCandidates, attempts: atts, covered, revisions, feedback, snapshots, timeline, pendingRun };
}

export async function getRuns(projectId?: number) {
  await connection();
  return db()
    .select({ run: runs, projectName: projects.name })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(projectId ? eq(runs.projectId, projectId) : undefined)
    .orderBy(desc(runs.id))
    .limit(200)
    .all();
}

export async function getRun(id: number) {
  await connection();
  const d = db();
  const run = d.select().from(runs).where(eq(runs.id, id)).get();
  if (!run) return null;
  const project = d.select().from(projects).where(eq(projects.id, run.projectId)).get()!;
  const events = d.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(asc(runEvents.id)).all();
  const runAttempts = d.select({ attempt: attempts, shortId: issues.shortId }).from(attempts).innerJoin(issues, eq(issues.id, attempts.issueId)).where(eq(attempts.runId, id)).all();
  return { run, project, events, attempts: runAttempts };
}

export async function getProjectJobs(projectId: number) {
  await connection();
  return db().select().from(jobs).where(eq(jobs.projectId, projectId)).orderBy(desc(jobs.id)).limit(10).all();
}

export async function getJobEvents(jobId: number) {
  await connection();
  return db().select().from(runEvents).where(eq(runEvents.jobId, jobId)).orderBy(asc(runEvents.id)).all();
}

export async function getNotifications(limit = 200) {
  await connection();
  return db().select().from(notifications).orderBy(desc(notifications.id)).limit(limit).all();
}

export async function unreadCount() {
  await connection();
  return db().select({ n: count() }).from(notifications).where(isNull(notifications.readAt)).get()?.n ?? 0;
}

export async function getSetting<T>(key: string): Promise<T | null> {
  await connection();
  return (db().select().from(settings).where(eq(settings.key, key)).get()?.value as T) ?? null;
}

export async function workerAlive() {
  await connection();
  // The worker writes a heartbeat setting; see src/worker/index.ts.
  const hb = db().select().from(settings).where(eq(settings.key, "worker_heartbeat")).get();
  const at = (hb?.value as { at?: string } | null)?.at;
  return at ? Date.now() - new Date(at).getTime() < 3 * 60_000 : false;
}
