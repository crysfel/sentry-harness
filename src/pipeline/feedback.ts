import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { attemptRevisions, attempts, issues, jobs, prFeedback, projects, type Attempt, type Project } from "../db/schema";
import { eventLogger, type EventLogger } from "../db/queries/events";
import { enqueueJob } from "../db/queries/jobs";
import { ghApiList } from "../github/gh";
import { notify } from "../notify/notify";
import { reconcilePrs, attemptIssueIds, type PrChecker } from "./reconcile";
import { commentOnPr } from "./publish";

/**
 * PR review feedback (PLAN §6.9), detected by polling. The harness posts as
 * the owner's GitHub user (the token is theirs), so its own comments are
 * recognised by HARNESS_MARKER, not by author.
 */
export const HARNESS_MARKER = "<!-- sentry-harness -->";
export const DEBOUNCE_MS = 2 * 60_000;

type GhUser = { login: string; type?: string };
type GhReview = { id: number; user: GhUser | null; body: string | null; state: string; submitted_at: string | null };
type GhReviewComment = { id: number; user: GhUser | null; body: string; path: string; line: number | null; original_line: number | null; diff_hunk: string; created_at: string; pull_request_review_id: number | null };
type GhIssueComment = { id: number; user: GhUser | null; body: string; created_at: string };

export type FetchedFeedback = {
  githubId: string;
  kind: "review" | "review_comment" | "issue_comment";
  author: string;
  reviewState: string | null;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string;
  createdAt: string;
};

export type FeedbackFetcher = (slug: string, prNumber: number) => Promise<FetchedFeedback[]>;

export const fetchPrFeedback: FeedbackFetcher = async (slug, n) => {
  const [reviews, inline, top] = await Promise.all([
    ghApiList<GhReview>(`repos/${slug}/pulls/${n}/reviews`),
    ghApiList<GhReviewComment>(`repos/${slug}/pulls/${n}/comments`),
    ghApiList<GhIssueComment>(`repos/${slug}/issues/${n}/comments`),
  ]);
  return [
    ...reviews
      .filter((r) => r.state !== "PENDING" && r.submitted_at)
      .map((r) => ({ githubId: `review-${r.id}`, kind: "review" as const, author: r.user?.login ?? "ghost", reviewState: r.state, path: null, line: null, diffHunk: null, body: r.body ?? "", createdAt: r.submitted_at! })),
    ...inline.map((c) => ({ githubId: `rc-${c.id}`, kind: "review_comment" as const, author: c.user?.login ?? "ghost", reviewState: null, path: c.path, line: c.line ?? c.original_line, diffHunk: c.diff_hunk, body: c.body, createdAt: c.created_at })),
    ...top.map((c) => ({ githubId: `ic-${c.id}`, kind: "issue_comment" as const, author: c.user?.login ?? "ghost", reviewState: null, path: null, line: null, diffHunk: null, body: c.body, createdAt: c.created_at })),
  ];
};

/**
 * Is this item a request the harness should act on?
 * - Only authors in review_authors; never the harness's own comments.
 * - An approval, or a review with no body (its inline comments carry the content), is not itself a request.
 */
export function isActionable(f: FetchedFeedback, reviewAuthors: string[]): boolean {
  if (f.body.includes(HARNESS_MARKER)) return false;
  const allowed = reviewAuthors.map((a) => a.toLowerCase());
  if (!allowed.includes(f.author.toLowerCase())) return false;
  if (f.kind === "review") {
    if (f.reviewState === "APPROVED" || f.reviewState === "DISMISSED") return false;
    return f.body.trim().length > 0 && (f.reviewState === "CHANGES_REQUESTED" || f.reviewState === "COMMENTED");
  }
  return f.body.trim().length > 0;
}

export function pendingFeedback(d: Db, attemptId: number) {
  return d
    .select()
    .from(prFeedback)
    .where(and(eq(prFeedback.attemptId, attemptId), eq(prFeedback.actionable, true), isNull(prFeedback.revisionId)))
    .orderBy(prFeedback.createdAt)
    .all();
}

export function revisionCount(d: Db, attemptId: number) {
  return d.select({ n: count() }).from(attemptRevisions).where(eq(attemptRevisions.attemptId, attemptId)).get()?.n ?? 0;
}

function revisionJobPending(d: Db, attemptId: number) {
  return d
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, "revise_pr"), inArray(jobs.status, ["queued", "running"])))
    .all()
    .some((j) => Number(j.payload?.attemptId) === attemptId);
}

export type PollDeps = { fetch?: FeedbackFetcher; checkPr?: PrChecker; comment?: typeof commentOnPr; now?: () => Date };

export async function pollFeedback(d: Db, o: { jobId: number; projectId: number | null; signal?: AbortSignal; deps?: PollDeps }) {
  const ps = o.projectId ? d.select().from(projects).where(eq(projects.id, o.projectId)).all() : d.select().from(projects).all();
  const out = { prs: 0, stored: 0, queued: 0, merged: 0, closed: 0 };
  for (const p of ps) {
    if (p.cloneStatus !== "ready") continue;
    const log = eventLogger({ jobId: o.jobId });
    // Notice merges and closes within minutes (PLAN §6.9).
    const rec = await reconcilePrs(d, p, log, { checkPr: o.deps?.checkPr });
    out.merged += rec.merged;
    out.closed += rec.closed;
    const r = await pollProject(d, p, log, o.deps ?? {});
    out.prs += r.prs;
    out.stored += r.stored;
    out.queued += r.queued;
  }
  return out;
}

async function pollProject(d: Db, p: Project, log: EventLogger, deps: PollDeps) {
  const fetch = deps.fetch ?? fetchPrFeedback;
  const now = deps.now?.() ?? new Date();
  const open = d
    .select({ a: attempts })
    .from(attempts)
    .innerJoin(issues, eq(issues.id, attempts.issueId))
    .where(and(eq(issues.projectId, p.id), eq(attempts.status, "pr_open")))
    .all()
    .map((r) => r.a);
  let stored = 0;
  let queued = 0;
  for (const a of open) {
    if (!a.prNumber) continue;
    let items: FetchedFeedback[];
    try {
      items = await fetch(p.repoSlug, a.prNumber);
    } catch (err) {
      log.warn("feedback", `could not fetch comments for PR #${a.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const authors = p.reviewAuthors ?? [];
    for (const f of items) {
      const res = d
        .insert(prFeedback)
        .values({ attemptId: a.id, ...f, actionable: isActionable(f, authors) })
        .onConflictDoNothing()
        .run();
      if (res.changes) {
        stored++;
        if (!isActionable(f, authors) && !f.body.includes(HARNESS_MARKER)) {
          log.info("feedback", `PR #${a.prNumber}: stored ${f.kind} from @${f.author} (not acted on: author not in review_authors or not a request)`);
        }
      }
    }
    if (await maybeQueueRevision(d, p, a, log, now, deps)) queued++;
  }
  return { prs: open.length, stored, queued };
}

async function maybeQueueRevision(d: Db, p: Project, a: Attempt, log: EventLogger, now: Date, deps: PollDeps): Promise<boolean> {
  const pending = pendingFeedback(d, a.id);
  if (!pending.length || revisionJobPending(d, a.id)) return false;
  const newest = Math.max(...pending.map((f) => new Date(f.createdAt).getTime()));
  if (now.getTime() - newest < DEBOUNCE_MS) return false; // a review written as several comments is handled once

  const primary = d.select().from(issues).where(eq(issues.id, a.issueId)).get();
  if (revisionCount(d, a.id) >= p.maxRevisionsPerPr) {
    if (primary?.status === "needs_human") return false; // already said we stopped
    const comment = deps.comment ?? commentOnPr;
    await comment(
      p.repoSlug,
      a.prNumber!,
      `${HARNESS_MARKER}\nsentry-harness has made ${p.maxRevisionsPerPr} revisions on this PR, its limit, and has stopped. The remaining comments need a person.`,
    ).catch((err) => log.warn("feedback", `could not post the stop comment: ${String(err)}`));
    d.update(issues)
      .set({ status: "needs_human", statusReason: `Revision limit (${p.maxRevisionsPerPr}) reached on PR #${a.prNumber}.`, updatedAt: now.toISOString() })
      .where(inArray(issues.id, attemptIssueIds(d, a)))
      .run();
    notify(d, { projectId: p.id, kind: "revisions_exhausted", title: `${primary?.shortId}: stopped revising PR #${a.prNumber}`, body: `${p.maxRevisionsPerPr} revisions made; the remaining feedback needs you.`, link: `/issues/${a.issueId}`, issueId: a.issueId, attemptId: a.id });
    log.warn("feedback", `PR #${a.prNumber}: revision limit reached; set needs_human`);
    return false;
  }
  enqueueJob("revise_pr", { projectId: p.id, payload: { attemptId: a.id } }, d);
  log.info("feedback", `PR #${a.prNumber}: ${pending.length} pending comment(s); queued a revision`);
  return true;
}

/** Called by the scheduler every minute: queue polls that are due. */
export function queueDueFeedbackPolls(d: Db, now = new Date()) {
  for (const p of d.select().from(projects).where(eq(projects.cloneStatus, "ready")).all()) {
    const hasOpen = d
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(issues, eq(issues.id, attempts.issueId))
      .where(and(eq(issues.projectId, p.id), eq(attempts.status, "pr_open")))
      .get();
    if (!hasOpen) continue;
    const last = d.select().from(jobs).where(and(eq(jobs.kind, "feedback_poll"), eq(jobs.projectId, p.id))).orderBy(desc(jobs.id)).get();
    if (last && (last.status === "queued" || last.status === "running")) continue;
    if (last && now.getTime() - new Date(last.createdAt).getTime() < p.feedbackPollMinutes * 60_000) continue;
    enqueueJob("feedback_poll", { projectId: p.id }, d);
  }
}
