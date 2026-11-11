import path from "node:path";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, issueGroups, issues, issueSnapshots, type Issue, type IssueStatus, type Project } from "../db/schema";
import { runAgent, type AgentEvent } from "../agents/runner";
import { TriageOutput, type TriageIssue } from "../agents/schemas";
import { TRIAGE_SYSTEM, triagePrompt } from "../agents/prompts";
import { triagePolicy } from "../agents/policy";
import { writeSentryMcpConfig } from "../sentry/mcp-config";
import { config } from "../core/config";
import type { EventLogger } from "../db/queries/events";

/** Statuses whose classification triage may change. Everything else only gets fresh facts. */
export const RECLASSIFIABLE: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "new",
  "triaged",
  "not_in_repo",
  "not_actionable",
  "low_impact",
  "regressed",
  "attempt_failed",
]);

/** Statuses awaiting proof that a shipped version fixed them (PLAN §6.3). */
export const AWAITING_VERIFICATION: IssueStatus[] = ["awaiting_release", "fixed_unreleased"];

const TERMINAL: IssueStatus[] = ["verified_fixed", "ignored"];

const NOT_ACTIONABLE_REVIEW_DAYS = 7;

export function agentEventSink(log: EventLogger, stage: string) {
  return (e: AgentEvent) => {
    switch (e.kind) {
      case "init":
        log.info(stage, `agent session ${e.sessionId} started (${e.model})`, { tools: e.tools, apiKeySource: e.apiKeySource });
        break;
      case "tool_call":
        log.debug(stage, `${e.tool}: ${e.summary}`);
        break;
      case "tool_denied":
        log.warn(stage, `denied ${e.tool}: ${e.summary}`);
        break;
      case "rate_limit":
        if (e.status !== "allowed") log.warn(stage, `rate limit status: ${e.status}`, e.info);
        break;
      case "result":
        log.info(stage, `agent finished: ${e.turns} turns, ${e.costUsd.toFixed(2)} USD`);
        break;
    }
  };
}

export type TriageContext = {
  project: Project;
  runId: number;
  repoDir: string;
  repoVersion: string | null;
  recentCommits: string[];
  log: EventLogger;
  signal?: AbortSignal;
};

function needsDeepLook(i: Issue, now: Date): boolean {
  if (i.status === "new" || !i.lastTriagedAt) return true;
  if (i.nextReviewAt && new Date(i.nextReviewAt) <= now) return true;
  if (i.status === "regressed") return true;
  return false;
}

/** Run the triage agent and return its validated output plus cost. */
export async function runTriageAgent(d: Db, ctx: TriageContext) {
  const { project, log } = ctx;
  const now = new Date();
  const known = d
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), notInArray(issues.status, TERMINAL)))
    .all();
  const lastAttempts = new Map<number, { status: string; prUrl: string | null }>();
  if (known.length) {
    const rows = d
      .select()
      .from(attempts)
      .where(inArray(attempts.issueId, known.map((k) => k.id)))
      .orderBy(desc(attempts.id))
      .all();
    for (const a of rows) if (!lastAttempts.has(a.issueId)) lastAttempts.set(a.issueId, { status: a.status, prUrl: a.prUrl });
  }
  const groups = d.select().from(issueGroups).where(eq(issueGroups.projectId, project.id)).all();
  const members = new Map<number, string[]>();
  for (const i of d.select({ groupId: issues.groupId, shortId: issues.shortId }).from(issues).where(eq(issues.projectId, project.id)).all()) {
    if (i.groupId) members.set(i.groupId, [...(members.get(i.groupId) ?? []), i.shortId]);
  }

  const prompt = triagePrompt({
    org: project.sentryOrg,
    project: project.sentryProject,
    queryFilter: project.sentryQueryFilter,
    repoVersion: ctx.repoVersion,
    defaultBranch: project.defaultBranch ?? "main",
    recentCommits: ctx.recentCommits,
    knownIssues: known
      .filter((k) => !AWAITING_VERIFICATION.includes(k.status))
      .map((k) => ({
        sentryId: k.sentryId,
        shortId: k.shortId,
        status: k.status,
        classification: k.classification,
        users14d: k.users14d,
        events14d: k.events14d,
        lastAttempt: lastAttempts.get(k.id)?.status ?? null,
        prUrl: lastAttempts.get(k.id)?.prUrl ?? null,
        groupId: k.groupId,
      })),
    deepLook: known.filter((k) => needsDeepLook(k, now) && RECLASSIFIABLE.has(k.status)).map((k) => k.shortId),
    groups: groups
      .filter((g) => (members.get(g.id)?.length ?? 0) > 0)
      .map((g) => ({ id: g.id, title: g.title, locked: g.locked, shortIds: members.get(g.id) ?? [], reasoning: g.reasoning })),
    verify: known
      .filter((k) => AWAITING_VERIFICATION.includes(k.status) && k.expectedVersion)
      .map((k) => ({ sentryId: k.sentryId, shortId: k.shortId, expectedVersion: k.expectedVersion! })),
  });

  const mcp = writeSentryMcpConfig(project.sentryOrg, project.sentryProject);
  try {
    log.info("triage", "starting triage agent");
    const policy = triagePolicy();
    const res = await runAgent({
      cwd: ctx.repoDir,
      systemPrompt: TRIAGE_SYSTEM,
      prompt,
      model: project.model,
      mcpConfigFile: mcp.file,
      ...policy,
      outputSchema: TriageOutput,
      maxBudgetUsd: project.maxBudgetUsdPerAttempt,
      timeoutMs: config().TRIAGE_TIMEOUT_MINUTES * 60_000,
      transcriptPath: path.join(config().transcriptsDir, `run-${ctx.runId}-triage.jsonl`),
      onEvent: agentEventSink(log, "triage"),
      signal: ctx.signal,
    });
    return res;
  } finally {
    mcp.cleanup();
  }
}

/** Facts copied from triage output into an issues row. */
function facts(t: TriageIssue) {
  return {
    shortId: t.shortId,
    title: t.title,
    culprit: t.culprit,
    level: t.level,
    category: t.category,
    sentryUrl: t.url,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
    events14d: t.events14d,
    users14d: t.users14d,
    substatus: t.substatus,
    firstRelease: t.firstRelease,
    lastReleaseSeen: t.lastReleaseSeen,
  };
}

/**
 * Decide the new status from a triage classification (PLAN §5 state machine).
 * Only code changes status: the agent proposes, this disposes.
 */
export function statusFromClassification(
  current: IssueStatus,
  t: Pick<TriageIssue, "classification" | "fixedByCommit" | "reasoning">,
  repoVersion: string | null,
  now: Date,
): { status: IssueStatus; reason: string; expectedVersion?: string | null; nextReviewAt?: string | null } | null {
  if (!RECLASSIFIABLE.has(current)) return null;
  switch (t.classification) {
    case "not_in_repo":
      return { status: "not_in_repo", reason: "Code is not in this repository." };
    case "not_actionable":
      return {
        status: "not_actionable",
        reason: "No code fix evident from the evidence.",
        nextReviewAt: new Date(now.getTime() + NOT_ACTIONABLE_REVIEW_DAYS * 86_400_000).toISOString(),
      };
    case "likely_fixed_unreleased":
      if (!repoVersion) return { status: "triaged", reason: "Likely fixed on the default branch, but the app version is unknown." };
      return {
        status: "fixed_unreleased",
        reason: `Likely fixed by ${t.fixedByCommit?.slice(0, 10) ?? "an unreleased commit"}; expected to ship in ${repoVersion}.`,
        expectedVersion: repoVersion,
      };
    case "candidate":
      // attempt_failed keeps its status (retry is counted against attempts); others become triaged.
      if (current === "attempt_failed") return { status: "attempt_failed", reason: "Still a candidate after a failed attempt." };
      return { status: "triaged", reason: "Candidate for a code fix." };
  }
}

export type ApplyTriageResult = { synced: number; created: number; reclassified: number; unseen: number; groupsChanged: number };

/** Upsert issues, write snapshots, apply classifications and groups. One transaction. */
export function applyTriage(
  d: Db,
  project: Project,
  runId: number,
  out: TriageOutput,
  repoVersion: string | null,
  log: EventLogger,
  now = new Date(),
): ApplyTriageResult {
  const stamp = now.toISOString();
  const res: ApplyTriageResult = { synced: 0, created: 0, reclassified: 0, unseen: 0, groupsChanged: 0 };

  // Deduplicate by sentryId, keeping the first occurrence.
  const seen = new Map<string, TriageIssue>();
  for (const t of out.issues) if (!seen.has(t.sentryId)) seen.set(t.sentryId, t);

  d.transaction((tx) => {
    for (const t of seen.values()) {
      let row = tx.select().from(issues).where(and(eq(issues.projectId, project.id), eq(issues.sentryId, t.sentryId))).get();
      if (!row) {
        row = tx
          .insert(issues)
          .values({ projectId: project.id, sentryId: t.sentryId, ...facts(t), status: "new" })
          .returning()
          .get();
        res.created++;
      }
      const decision = statusFromClassification(row.status, t, repoVersion, now);
      const update: Partial<typeof issues.$inferInsert> = {
        ...facts(t),
        lastSeenRunId: runId,
        updatedAt: stamp,
      };
      if (decision) {
        Object.assign(update, {
          status: decision.status,
          statusReason: decision.reason,
          classification: t.classification,
          fixability: t.fixability,
          triageSummary: t.reasoning,
          relevantFiles: t.relevantFiles,
          fixedByCommit: t.fixedByCommit,
          lastTriagedAt: stamp,
          nextReviewAt: decision.nextReviewAt ?? null,
        });
        if (decision.expectedVersion !== undefined) update.expectedVersion = decision.expectedVersion;
        if (decision.status !== row.status) {
          res.reclassified++;
          log.info("triage", `${row.shortId}: ${row.status} → ${decision.status}. ${t.reasoning}`, { issueId: row.id });
        }
      }
      tx.update(issues).set(update).where(eq(issues.id, row.id)).run();
      tx.insert(issueSnapshots)
        .values({
          issueId: row.id,
          runId,
          capturedAt: stamp,
          events14d: t.events14d,
          users14d: t.users14d,
          lastSeen: t.lastSeen,
          lastReleaseSeen: t.lastReleaseSeen,
        })
        .onConflictDoNothing()
        .run();
      res.synced++;
    }

    const seenRowIds = seenIds(tx, project.id, [...seen.keys()]);
    res.unseen = tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), notInArray(issues.status, TERMINAL)))
      .all()
      .filter((r) => !seenRowIds.has(r.id)).length;

    res.groupsChanged = applyGroups(tx as unknown as Db, project.id, out.groups, [...seen.keys()], log, stamp);
  });
  return res;
}

function seenIds(tx: Pick<Db, "select">, projectId: number, sentryIds: string[]): Set<number> {
  if (!sentryIds.length) return new Set();
  return new Set(
    tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.sentryId, sentryIds)))
      .all()
      .map((r) => r.id),
  );
}

/**
 * Apply proposed groups, keeping them stable (PLAN §6.2):
 * - Never touch a locked group or regroup its members.
 * - A proposal that overlaps an existing unlocked group updates that group.
 * - Members of unlocked triage groups that were seen this run but are not in
 *   any proposal leave their group; groups left with < 2 members dissolve.
 */
export function applyGroups(
  d: Db,
  projectId: number,
  proposals: Array<{ title: string; sentryIds: string[]; reasoning: string }>,
  seenSentryIds: string[],
  log: EventLogger,
  stamp = new Date().toISOString(),
): number {
  let changed = 0;
  const all = d.select().from(issues).where(eq(issues.projectId, projectId)).all();
  const bySentry = new Map(all.map((i) => [i.sentryId, i]));
  const groups = new Map(d.select().from(issueGroups).where(eq(issueGroups.projectId, projectId)).all().map((g) => [g.id, g]));
  const isLocked = (gid: number | null) => gid !== null && !!groups.get(gid)?.locked;

  const assigned = new Map<number, number | null>(); // issueId → groupId
  const proposedIssueIds = new Set<number>();

  for (const p of proposals) {
    const memberRows = [...new Set(p.sentryIds)].map((s) => bySentry.get(s)).filter((i): i is Issue => !!i && !isLocked(i.groupId));
    if (memberRows.length < 2) continue;
    // Reuse the unlocked group most of these issues already belong to.
    const counts = new Map<number, number>();
    for (const m of memberRows) if (m.groupId !== null) counts.set(m.groupId, (counts.get(m.groupId) ?? 0) + 1);
    const reuse = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let gid: number;
    if (reuse !== undefined && !assignedGroupTaken(assigned, reuse)) {
      gid = reuse;
      const g = groups.get(gid)!;
      if (g.title !== p.title || g.reasoning !== p.reasoning) {
        d.update(issueGroups).set({ title: p.title, reasoning: p.reasoning, updatedAt: stamp }).where(eq(issueGroups.id, gid)).run();
      }
    } else {
      gid = d.insert(issueGroups).values({ projectId, title: p.title, reasoning: p.reasoning, createdBy: "triage" }).returning().get().id;
      groups.set(gid, { id: gid, projectId, title: p.title, reasoning: p.reasoning, createdBy: "triage", locked: false, createdAt: stamp, updatedAt: stamp });
      log.info("triage", `new group #${gid} "${p.title}": ${memberRows.map((m) => m.shortId).join(", ")}`);
      changed++;
    }
    for (const m of memberRows) {
      assigned.set(m.id, gid);
      proposedIssueIds.add(m.id);
    }
  }

  const seen = new Set(seenSentryIds);
  for (const i of all) {
    if (isLocked(i.groupId)) continue;
    let target: number | null | undefined = assigned.get(i.id);
    if (target === undefined) {
      // Seen this run, in an unlocked group, and not proposed: leaves the group.
      if (i.groupId !== null && seen.has(i.sentryId) && groups.get(i.groupId)?.createdBy === "triage") target = null;
      else continue;
    }
    if (target !== i.groupId) {
      d.update(issues).set({ groupId: target, updatedAt: stamp }).where(eq(issues.id, i.id)).run();
      changed++;
    }
  }

  // Dissolve unlocked groups with fewer than two members.
  const counts = new Map<number, number>();
  for (const r of d.select({ groupId: issues.groupId }).from(issues).where(eq(issues.projectId, projectId)).all()) {
    if (r.groupId !== null) counts.set(r.groupId, (counts.get(r.groupId) ?? 0) + 1);
  }
  for (const g of groups.values()) {
    if (g.locked) continue;
    const n = counts.get(g.id) ?? 0;
    if (n < 2) {
      d.update(issues).set({ groupId: null }).where(eq(issues.groupId, g.id)).run();
      d.delete(issueGroups).where(eq(issueGroups.id, g.id)).run();
      if (n > 0 || g.createdAt !== stamp) changed++;
    }
  }
  return changed;
}

function assignedGroupTaken(assigned: Map<number, number | null>, gid: number) {
  // A group id is reused by at most one proposal per run.
  for (const v of assigned.values()) if (v === gid) return true;
  return false;
}
