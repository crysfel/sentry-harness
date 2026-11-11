import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, issues, projects, runs, type Issue, type Project, type SelectionRow } from "../db/schema";
import { eventLogger, type EventLogger } from "../db/queries/events";
import { notify } from "../notify/notify";
import { syncDefaultBranch, recentCommitSubjects } from "../github/git";
import { readVersion } from "../projects/version";
import { ensureDataDirs } from "../core/config";
import { AgentError } from "../agents/runner";
import type { TriageOutput } from "../agents/schemas";
import { reconcilePrs, type PrChecker, type VersionAt } from "./reconcile";
import { applyTriage, runTriageAgent, AWAITING_VERIFICATION } from "./triage-stage";
import { impactScore } from "./scoring";
import { select, SELECTABLE, type SelectIssue } from "./select";
import { decideVerification } from "./verification";
import { fixUnit, attemptsUsed, UsageLimitReached, type FixDeps } from "./fix-stage";

export class RunCancelled extends Error {}

export type RunDeps = {
  sync: (repoDir: string, branch: string, signal?: AbortSignal) => Promise<string>;
  commits: (repoDir: string) => Promise<string[]>;
  version: (repoDir: string, cmd: string | null) => Promise<string | null>;
  checkPr?: PrChecker;
  versionAt?: VersionAt;
  fix?: Partial<FixDeps>;
  now?: () => Date;
};

const defaultDeps: RunDeps = {
  sync: syncDefaultBranch,
  commits: (dir) => recentCommitSubjects(dir, 30),
  version: readVersion,
};

/**
 * One pipeline run for one project (PLAN §6):
 * reconcile → triage → verify shipped fixes → select → fix/verify/publish → notify.
 * Deterministic code owns control flow and every side effect.
 */
export async function executeRun(d: Db, runId: number, opts: { signal?: AbortSignal; deps?: Partial<RunDeps> } = {}) {
  const deps = { ...defaultDeps, ...opts.deps };
  const now = () => deps.now?.() ?? new Date();
  const run = d.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "queued") return { skipped: `run is ${run.status}` };
  const project = d.select().from(projects).where(eq(projects.id, run.projectId)).get();
  if (!project) throw new Error(`project ${run.projectId} not found`);

  ensureDataDirs();
  const log = eventLogger({ runId });
  const counts: Record<string, number> = {};
  let cost = 0;
  const addCost = (c: number) => {
    cost += c;
    d.update(runs).set({ costUsd: Math.round(cost * 10000) / 10000 }).where(eq(runs.id, runId)).run();
  };

  d.update(runs).set({ status: "running", startedAt: now().toISOString() }).where(eq(runs.id, runId)).run();

  // Cancellation: the dashboard sets cancel_requested; we abort in-flight work.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const cancelPoll = setInterval(() => {
    const r = d.select({ c: runs.cancelRequested }).from(runs).where(eq(runs.id, runId)).get();
    if (r?.c) controller.abort();
  }, 3000);
  const checkCancel = () => {
    if (controller.signal.aborted) throw new RunCancelled("Run cancelled.");
  };

  const finish = (status: "succeeded" | "failed" | "cancelled", summary: string, error?: string) => {
    d.update(runs)
      .set({ status, summary, error: error ?? null, counts, finishedAt: now().toISOString(), costUsd: Math.round(cost * 10000) / 10000 })
      .where(eq(runs.id, runId))
      .run();
  };

  try {
    if (project.cloneStatus !== "ready" || !project.localPath || !project.defaultBranch) {
      throw new Error("Project is not cloned yet.");
    }
    const repoDir = project.localPath;

    // 6.1 Reconcile
    log.info("reconcile", `syncing ${project.defaultBranch}`);
    const headSha = await deps.sync(repoDir, project.defaultBranch, controller.signal);
    const repoVersion = await deps.version(repoDir, project.versionCmd);
    const recentCommits = await deps.commits(repoDir);
    log.info("reconcile", `at ${headSha.slice(0, 10)}, version ${repoVersion ?? "unknown"}`);
    const prs = await reconcilePrs(d, project, log, { checkPr: deps.checkPr, versionAt: deps.versionAt });
    counts.prsMerged = prs.merged;
    counts.prsClosed = prs.closed;
    checkCancel();

    // 6.2 Triage (skipped for "Fix now", which works from what the harness already knows)
    let triage: TriageOutput | null = null;
    if (!run.requestedIssueId) {
      try {
        const res = await runTriageAgent(d, { project, runId, repoDir, repoVersion, recentCommits, log, signal: controller.signal });
        addCost(res.costUsd);
        triage = res.output;
      } catch (err) {
        if (err instanceof AgentError) addCost(err.details.costUsd ?? 0);
        throw err;
      }
      const applied = applyTriage(d, project, runId, triage, repoVersion, log, now());
      Object.assign(counts, { synced: applied.synced, newIssues: applied.created, reclassified: applied.reclassified, groupsChanged: applied.groupsChanged });
      log.info("triage", `${applied.synced} issues synced, ${applied.created} new, ${applied.reclassified} reclassified, ${applied.groupsChanged} group changes`);
      if (triage.notes) log.info("triage", `agent notes: ${triage.notes}`);
      checkCancel();

      // 6.3 Verify shipped fixes
      const v = verifyShipped(d, project, triage, log, now());
      Object.assign(counts, v);
    }

    // 6.4 Select
    const latestRelease = triage?.latestRelease?.version ?? null;
    const sel = selectStage(d, project, runId, latestRelease, run.requestedIssueId, log, { markQueued: !run.dryRun });
    counts.candidates = sel.rows.length;
    counts.selected = sel.selected.length;

    if (run.dryRun) {
      const summary = summarize(counts, sel.selected.length, true);
      finish("succeeded", summary);
      notify(d, { projectId: project.id, kind: "run_summary", title: `${project.name}: dry run finished`, body: summary, link: `/runs/${runId}`, runId });
      return { summary };
    }

    // 6.5–6.7 Fix, verify, publish: one unit at a time.
    let opened = 0;
    let failed = 0;
    let noFix = 0;
    for (const unit of sel.selected) {
      checkCancel();
      const res = await fixUnit(d, project, runId, unit, headSha, recentCommits, log, { signal: controller.signal, deps: deps.fix });
      addCost(res.costUsd);
      if (res.status === "pr_open") opened++;
      else if (res.status === "no_fix") noFix++;
      else failed++;
    }
    Object.assign(counts, { prsOpened: opened, attemptsFailed: failed, noFix });

    const summary = summarize(counts, sel.selected.length, false);
    finish("succeeded", summary);
    notify(d, { projectId: project.id, kind: "run_summary", title: `${project.name}: daily run finished`, body: summary, link: `/runs/${runId}`, runId });
    return { summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RunCancelled || (err instanceof AgentError && err.kind === "cancelled") || controller.signal.aborted) {
      log.warn("run", "run cancelled");
      finish("cancelled", "Cancelled.", message);
      return { cancelled: true };
    }
    const usage = err instanceof UsageLimitReached || (err instanceof AgentError && err.kind === "usage_limit");
    log.error("run", `run failed: ${message}`);
    finish("failed", usage ? "Stopped: Claude usage limit reached." : `Failed: ${message.split("\n")[0].slice(0, 200)}`, message);
    notify(d, {
      projectId: project.id,
      kind: usage ? "usage_limit" : "run_failed",
      title: usage ? `${project.name}: run stopped at the Claude usage limit` : `${project.name}: run #${runId} failed`,
      body: message.slice(0, 1000),
      link: `/runs/${runId}`,
      runId,
    });
    throw err;
  } finally {
    clearInterval(cancelPoll);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    // Anything left mid-fix by an exception goes back to triaged.
    d.update(issues)
      .set({ status: "triaged", statusReason: "Run ended before the fix finished." })
      .where(and(eq(issues.projectId, project.id), inArray(issues.status, ["fixing", "queued"])))
      .run();
  }
}

function summarize(c: Record<string, number>, selected: number, dry: boolean): string {
  const parts: string[] = [];
  if (c.synced !== undefined) parts.push(`${c.synced} issues synced`);
  if (c.newIssues) parts.push(`${c.newIssues} new`);
  if (c.prsMerged) parts.push(`${c.prsMerged} PR${c.prsMerged > 1 ? "s" : ""} merged`);
  if (c.prsClosed) parts.push(`${c.prsClosed} PR${c.prsClosed > 1 ? "s" : ""} closed`);
  if (c.verified) parts.push(`${c.verified} fix${c.verified > 1 ? "es" : ""} verified`);
  if (c.regressed) parts.push(`${c.regressed} regressed`);
  if (dry) parts.push(selected ? `${selected} would be fixed (dry run)` : "nothing worth fixing (dry run)");
  else if (!selected) parts.push("nothing worth fixing today");
  else {
    if (c.prsOpened) parts.push(`${c.prsOpened} PR${c.prsOpened > 1 ? "s" : ""} opened`);
    if (c.noFix) parts.push(`${c.noFix} without a confident fix`);
    if (c.attemptsFailed) parts.push(`${c.attemptsFailed} attempt${c.attemptsFailed > 1 ? "s" : ""} failed`);
  }
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** PLAN §6.3, using the release data triage copied from Sentry. */
export function verifyShipped(d: Db, project: Project, triage: TriageOutput, log: EventLogger, now: Date) {
  const pending = d
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, project.id), inArray(issues.status, AWAITING_VERIFICATION)))
    .all();
  const byId = new Map(triage.verification.map((v) => [v.sentryId, v]));
  const releases = triage.releases.length ? triage.releases : triage.latestRelease ? [triage.latestRelease] : [];
  let verified = 0;
  let regressed = 0;
  for (const i of pending) {
    if (!i.expectedVersion) continue;
    const v = byId.get(i.sentryId);
    if (!v) {
      log.warn("verify-shipped", `${i.shortId}: triage returned no verification data; staying ${i.status}`, { issueId: i.id });
      continue;
    }
    const decision = decideVerification({
      expectedVersion: i.expectedVersion,
      baselineEventsPerDay: i.baselineEventsPerDay ?? i.events14d / 14,
      releases,
      eventsInReleaseGte: v.eventsInReleaseGte,
      now,
    });
    const stamp = now.toISOString();
    if (decision.outcome === "regressed") {
      d.update(issues).set({ status: "regressed", statusReason: decision.message, updatedAt: stamp }).where(eq(issues.id, i.id)).run();
      regressed++;
      log.warn("verify-shipped", `${i.shortId}: regressed. ${decision.message}`, { issueId: i.id });
      const wasMerged = i.status === "awaiting_release";
      notify(d, {
        projectId: project.id,
        kind: "regression",
        title: `${i.shortId} ${wasMerged ? "regressed after a merged fix" : "still occurs after the expected fix"}`,
        body: decision.message,
        link: `/issues/${i.id}`,
        issueId: i.id,
      });
    } else if (decision.outcome === "verified") {
      d.update(issues)
        .set({ status: "verified_fixed", verificationConfidence: decision.confidence, statusReason: decision.message, updatedAt: stamp })
        .where(eq(issues.id, i.id))
        .run();
      verified++;
      log.info("verify-shipped", `${i.shortId}: verified fixed (${decision.confidence}). ${decision.message}`, { issueId: i.id });
      notify(d, {
        projectId: project.id,
        kind: "fix_verified",
        title: `${i.shortId} verified fixed in ${i.expectedVersion}${decision.confidence === "presumed" ? " (presumed)" : ""}`,
        body: decision.message,
        link: `/issues/${i.id}`,
        issueId: i.id,
      });
    } else {
      d.update(issues).set({ statusReason: decision.message, updatedAt: stamp }).where(eq(issues.id, i.id)).run();
    }
  }
  return { verified, regressed };
}

/** PLAN §6.4: score, apply caps, record why each candidate was or was not picked. */
export function selectStage(
  d: Db,
  project: Project,
  runId: number,
  latestRelease: string | null,
  requestedIssueId: number | null,
  log: EventLogger,
  opts: { markQueued: boolean } = { markQueued: true },
) {
  const all = d.select().from(issues).where(eq(issues.projectId, project.id)).all();
  const stamp = new Date().toISOString();

  // Score every selectable candidate.
  const scored = new Map<number, number>();
  for (const i of all) {
    if (!SELECTABLE.has(i.status) && i.id !== requestedIssueId) continue;
    const s = impactScore(i, latestRelease);
    scored.set(i.id, s);
    if (s !== i.impactScore) d.update(issues).set({ impactScore: s }).where(eq(issues.id, i.id)).run();
  }

  const busyGroupIds = new Set<number>();
  for (const i of all) if (i.groupId !== null && ["queued", "fixing", "pr_open"].includes(i.status)) busyGroupIds.add(i.groupId);

  const openPrs = d
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(issues, eq(issues.id, attempts.issueId))
    .where(and(eq(issues.projectId, project.id), eq(attempts.status, "pr_open")))
    .all().length;

  const input: SelectIssue[] = all
    .filter((i) => scored.has(i.id))
    .map((i) => ({
      id: i.id,
      shortId: i.shortId,
      status: i.status,
      classification: i.classification,
      fixability: i.fixability,
      impactScore: scored.get(i.id) ?? 0,
      groupId: i.groupId,
      pinned: i.pinned,
      ignored: i.ignored,
      attemptsUsed: attemptsUsed(d, i.id),
    }));

  const res = select(input, {
    maxFixesPerRun: project.maxFixesPerRun,
    maxOpenPrs: project.maxOpenPrs,
    openPrs,
    maxAttemptsPerIssue: project.maxAttemptsPerIssue,
    threshold: project.impactThreshold,
    busyGroupIds,
    requestedIssueId,
  });

  for (const id of res.lowImpactIds) {
    const i = all.find((x) => x.id === id)!;
    if (i.status !== "low_impact") {
      d.update(issues).set({ status: "low_impact", statusReason: `Impact ${scored.get(id)} below threshold ${project.impactThreshold}.`, updatedAt: stamp }).where(eq(issues.id, id)).run();
    }
  }
  // low_impact issues that cleared the threshold become triaged again.
  for (const r of res.rows) {
    const i = all.find((x) => x.id === r.issueId)!;
    if (i.status === "low_impact" && !res.lowImpactIds.includes(i.id)) {
      d.update(issues).set({ status: "triaged", statusReason: "Impact rose above the threshold.", updatedAt: stamp }).where(eq(issues.id, i.id)).run();
    }
  }

  d.update(runs).set({ selection: res.rows as SelectionRow[] }).where(eq(runs.id, runId)).run();
  for (const r of res.rows) log.info("select", `${r.shortId}: ${r.selected ? "selected" : "skipped"}: ${r.reason}`, { issueId: r.issueId });
  if (!res.selected.length) log.info("select", "nothing selected");

  const byId = new Map(d.select().from(issues).where(eq(issues.projectId, project.id)).all().map((i) => [i.id, i]));
  const selected = res.selected.map((u) => ({
    primary: byId.get(u.primary.id)! as Issue,
    members: u.members.map((m) => byId.get(m.id)! as Issue),
  }));
  for (const u of opts.markQueued ? selected : []) {
    d.update(issues).set({ status: "queued", statusReason: "Selected for a fix.", updatedAt: stamp }).where(inArray(issues.id, u.members.map((m) => m.id))).run();
  }
  return { selected, rows: res.rows };
}
