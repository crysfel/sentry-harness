import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, attemptIssues, issues, issueSnapshots, type Attempt, type Project } from "../db/schema";
import { prView, type PrState } from "../github/gh";
import { git } from "../github/git";
import type { EventLogger } from "../db/queries/events";
import { notify } from "../notify/notify";
import { createWorktree, removeWorktree } from "../projects/worktree";
import { readVersion } from "../projects/version";
import { baselineEventsPerDay } from "./verification";

export type PrChecker = (slug: string, prNumber: number) => Promise<PrState>;
export type VersionAt = (project: Project, sha: string) => Promise<string | null>;

/** Run version_cmd at a given commit in a throwaway worktree. */
export const versionAtCommit: VersionAt = async (project, sha) => {
  if (!project.localPath) return null;
  const wt = await createWorktree(project.localPath, project.id, `version-${sha.slice(0, 12)}`, { base: sha });
  try {
    return await readVersion(wt.path, project.versionCmd);
  } finally {
    await removeWorktree(project.localPath, wt.path);
  }
};

/** Issues an attempt moves together: its primary plus the covered group members. */
export function attemptIssueIds(d: Db, a: Attempt): number[] {
  const rows = d.select().from(attemptIssues).where(eq(attemptIssues.attemptId, a.id)).all();
  const ids = new Set<number>([a.issueId]);
  for (const r of rows) if (r.covered !== false) ids.add(r.issueId);
  return [...ids];
}

/**
 * PR-state part of reconcile (PLAN §6.1.2). Also run by the feedback poll so
 * merges show up within minutes.
 */
export async function reconcilePrs(
  d: Db,
  project: Project,
  log: EventLogger,
  deps: { checkPr?: PrChecker; versionAt?: VersionAt } = {},
) {
  const checkPr = deps.checkPr ?? ((slug, n) => prView(slug, n));
  const versionAt = deps.versionAt ?? versionAtCommit;
  const open = d
    .select({ a: attempts })
    .from(attempts)
    .innerJoin(issues, eq(issues.id, attempts.issueId))
    .where(and(eq(issues.projectId, project.id), eq(attempts.status, "pr_open")))
    .all()
    .map((r) => r.a);

  let merged = 0;
  let closed = 0;
  for (const a of open) {
    if (!a.prNumber) continue;
    let pr: PrState;
    try {
      pr = await checkPr(project.repoSlug, a.prNumber);
    } catch (err) {
      log.warn("reconcile", `could not read PR #${a.prNumber}: ${err instanceof Error ? err.message : String(err)}`, { attemptId: a.id });
      continue;
    }
    const ids = attemptIssueIds(d, a);
    const primary = d.select().from(issues).where(eq(issues.id, a.issueId)).get();
    const label = primary?.shortId ?? `attempt ${a.id}`;

    if (pr.state === "MERGED") {
      const mergeSha = pr.mergeCommit?.oid ?? null;
      let shipVersion: string | null = null;
      if (mergeSha) {
        // Make sure the merge commit is present locally (fetch happened at the start of reconcile).
        await git(["cat-file", "-e", `${mergeSha}^{commit}`], { cwd: project.localPath ?? undefined });
        shipVersion = await versionAt(project, mergeSha).catch(() => null);
      }
      const mergedAt = pr.mergedAt ?? new Date().toISOString();
      d.transaction((tx) => {
        tx.update(attempts)
          .set({ status: "merged", prState: "MERGED", mergeSha, mergedAt, shipVersion })
          .where(eq(attempts.id, a.id))
          .run();
        for (const id of ids) {
          const issue = tx.select().from(issues).where(eq(issues.id, id)).get();
          if (!issue) continue;
          const snaps = tx.select().from(issueSnapshots).where(eq(issueSnapshots.issueId, id)).all();
          tx.update(issues)
            .set({
              status: shipVersion ? "awaiting_release" : "merged",
              statusReason: shipVersion ? `Merged; expected to ship in ${shipVersion}.` : "Merged; ship version unknown (version_cmd failed).",
              expectedVersion: shipVersion,
              baselineEventsPerDay: baselineEventsPerDay(snaps, mergedAt, issue.events14d),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(issues.id, id))
            .run();
        }
      });
      merged++;
      log.info("reconcile", `PR #${a.prNumber} for ${label} merged; ship version ${shipVersion ?? "unknown"}`, { attemptId: a.id });
      notify(d, {
        projectId: project.id,
        kind: "pr_merged",
        title: `${label}: PR #${a.prNumber} merged`,
        body: shipVersion ? `Expected to ship in ${shipVersion}. The harness will watch Sentry for recurrences.` : "Could not determine the ship version.",
        link: `/issues/${a.issueId}`,
        issueId: a.issueId,
        attemptId: a.id,
      });
    } else if (pr.state === "CLOSED") {
      d.transaction((tx) => {
        tx.update(attempts).set({ status: "closed_unmerged", prState: "CLOSED" }).where(eq(attempts.id, a.id)).run();
        tx.update(issues)
          .set({ status: "pr_closed", statusReason: `PR #${a.prNumber} was closed without merging.`, updatedAt: new Date().toISOString() })
          .where(inArray(issues.id, ids))
          .run();
      });
      closed++;
      log.info("reconcile", `PR #${a.prNumber} for ${label} closed without merging`, { attemptId: a.id });
      notify(d, {
        projectId: project.id,
        kind: "pr_closed",
        title: `${label}: PR #${a.prNumber} closed`,
        body: "Closed without merging. The issue will not be retried unless you press Retry.",
        link: `/issues/${a.issueId}`,
        issueId: a.issueId,
        attemptId: a.id,
      });
    } else if (a.prState !== pr.state) {
      d.update(attempts).set({ prState: pr.state }).where(eq(attempts.id, a.id)).run();
    }
  }
  return { checked: open.length, merged, closed };
}
