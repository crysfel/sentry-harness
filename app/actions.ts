"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/src/db/client";
import { issueGroups, issues, notifications, projects, runs } from "@/src/db/schema";
import { enqueueJob, hasPendingJob, requestCancelRun, requestRun } from "@/src/db/queries/jobs";
import { parseRepoSlug } from "@/src/github/git";
import { isValidSession, passwordRequired, safeEqual, SESSION_COOKIE, sessionToken } from "./lib/auth";

/**
 * Server actions. The web process only writes rows; the worker does the work
 * (PLAN §9). Every action checks the session itself: actions are reachable by
 * direct POST, not only through the UI.
 */
async function guard() {
  const c = await cookies();
  if (!(await isValidSession(c.get(SESSION_COOKIE)?.value))) throw new Error("Unauthorized");
}

const num = (v: FormDataEntryValue | null) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Invalid id");
  return n;
};
const now = () => new Date().toISOString();

export async function login(formData: FormData) {
  if (!passwordRequired()) redirect("/");
  const pw = String(formData.get("password") ?? "");
  const expected = process.env.DASHBOARD_PASSWORD ?? "";
  const next = String(formData.get("next") ?? "/");
  if (!expected || !safeEqual(pw, expected)) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  (await cookies()).set(SESSION_COOKIE, await sessionToken(expected), { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

// ---------- projects ----------

const AddProject = z.object({
  repo: z.string().min(3),
  sentryOrg: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "Sentry organization slug"),
  sentryProject: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "Sentry project slug"),
  sentryQueryFilter: z.string().max(500).optional(),
});

export async function addProject(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string }> {
  await guard();
  const parsed = AddProject.safeParse({
    repo: formData.get("repo"),
    sentryOrg: formData.get("sentryOrg"),
    sentryProject: formData.get("sentryProject"),
    sentryQueryFilter: formData.get("sentryQueryFilter") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const slug = parseRepoSlug(parsed.data.repo);
  if (!slug) return { error: `"${parsed.data.repo}" is not a GitHub repository (use owner/name or a github.com URL).` };
  const d = db();
  if (d.select().from(projects).where(eq(projects.repoSlug, slug)).get()) return { error: `${slug} is already registered.` };
  const p = d
    .insert(projects)
    .values({
      name: slug.split("/")[1],
      repoSlug: slug,
      repoUrl: `https://github.com/${slug}.git`,
      sentryOrg: parsed.data.sentryOrg,
      sentryProject: parsed.data.sentryProject,
      sentryQueryFilter: parsed.data.sentryQueryFilter?.trim() || null,
      cloneStatus: "pending",
    })
    .returning()
    .get();
  enqueueJob("clone_project", { projectId: p.id }, d);
  redirect(`/projects/${p.id}`);
}

export async function recloneProject(formData: FormData) {
  await guard();
  const id = num(formData.get("projectId"));
  const d = db();
  if (!hasPendingJob("clone_project", id, d)) {
    d.update(projects).set({ cloneStatus: "pending", cloneError: null }).where(eq(projects.id, id)).run();
    enqueueJob("clone_project", { projectId: id }, d);
  }
  refresh();
}

const optText = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === "" ? null : s));

const ProjectSettings = z.object({
  name: z.string().trim().min(1).max(100),
  sentryOrg: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  sentryProject: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  sentryQueryFilter: optText,
  setupCmd: optText,
  buildCmd: optText,
  testCmd: optText,
  versionCmd: optText,
  scheduleCron: z.string().trim().min(9).max(100),
  maxFixesPerRun: z.coerce.number().int().min(0).max(10),
  maxOpenPrs: z.coerce.number().int().min(0).max(50),
  maxAttemptsPerIssue: z.coerce.number().int().min(1).max(10),
  maxBudgetUsdPerAttempt: z.coerce.number().min(0.5).max(100),
  impactThreshold: z.coerce.number().min(0),
  maxDiffLines: z.coerce.number().int().min(10).max(5000),
  model: z.string().trim().min(1).max(100),
  reviewAuthors: z.string().transform((s) => s.split(/[\s,]+/).map((x) => x.trim().replace(/^@/, "")).filter(Boolean)),
  maxRevisionsPerPr: z.coerce.number().int().min(0).max(20),
  feedbackPollMinutes: z.coerce.number().int().min(1).max(1440),
  prDraft: z.boolean(),
  sentryNotes: z.boolean(),
  enabled: z.boolean(),
});

export async function saveProjectSettings(_prev: { error?: string; ok?: boolean } | undefined, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  await guard();
  const id = num(formData.get("projectId"));
  const raw = Object.fromEntries([...formData.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
  const parsed = ProjectSettings.safeParse({ ...raw, prDraft: formData.has("prDraft"), sentryNotes: formData.has("sentryNotes"), enabled: formData.has("enabled") });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const { Cron } = await import("croner");
  try {
    new Cron(parsed.data.scheduleCron, { paused: true });
  } catch {
    return { error: `"${parsed.data.scheduleCron}" is not a valid cron expression.` };
  }
  const d = db();
  const p = d.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) return { error: "Project not found." };
  const commandsChanged = (["setupCmd", "buildCmd", "testCmd"] as const).some((k) => (p[k] ?? null) !== parsed.data[k]);
  const configTestOk = commandsChanged ? null : p.configTestOk;
  if (parsed.data.enabled && !configTestOk) {
    return { error: commandsChanged ? "Commands changed: run Test configuration again before enabling." : 'The project cannot be enabled until "Test configuration" has passed once.' };
  }
  d.update(projects)
    .set({ ...parsed.data, configTestOk, configTestedAt: commandsChanged ? null : p.configTestedAt, updatedAt: now() })
    .where(eq(projects.id, id))
    .run();
  refresh();
  return { ok: true };
}

export async function testConfiguration(formData: FormData) {
  await guard();
  const id = num(formData.get("projectId"));
  if (!hasPendingJob("test_config", id)) enqueueJob("test_config", { projectId: id });
  refresh();
}

// ---------- runs ----------

export async function runNow(formData: FormData) {
  await guard();
  const id = num(formData.get("projectId"));
  const dryRun = formData.get("dryRun") === "1";
  const d = db();
  const pending = d.select().from(runs).where(and(eq(runs.projectId, id), inArray(runs.status, ["queued", "running"]))).get();
  if (pending) redirect(`/runs/${pending.id}`);
  const run = requestRun(id, { trigger: "manual", dryRun }, d);
  redirect(`/runs/${run.id}`);
}

export async function cancelRun(formData: FormData) {
  await guard();
  requestCancelRun(num(formData.get("runId")));
  refresh();
}

// ---------- issues ----------

function setIssue(id: number, values: Partial<typeof issues.$inferInsert>) {
  db().update(issues).set({ ...values, updatedAt: now() }).where(eq(issues.id, id)).run();
}

export async function togglePin(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const i = db().select().from(issues).where(eq(issues.id, id)).get();
  if (i) setIssue(id, { pinned: !i.pinned });
  refresh();
}

export async function toggleIgnore(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const i = db().select().from(issues).where(eq(issues.id, id)).get();
  if (!i) return;
  if (i.ignored) setIssue(id, { ignored: false, status: "triaged", statusReason: "Un-ignored by owner." });
  else setIssue(id, { ignored: true, status: "ignored", statusReason: "Ignored by owner.", pinned: false });
  refresh();
}

/** Retry: the owner's "try again" after pr_closed, needs_human or exhausted attempts. */
export async function retryIssue(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const i = db().select().from(issues).where(eq(issues.id, id)).get();
  if (!i || ["queued", "fixing", "pr_open"].includes(i.status)) return;
  setIssue(id, { status: "triaged", classification: "candidate", ignored: false, statusReason: "Retry requested by owner." });
  requestRun(i.projectId, { trigger: "manual", issueId: id });
  refresh();
}

export async function fixNow(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const d = db();
  const i = d.select().from(issues).where(eq(issues.id, id)).get();
  if (!i) return;
  const pending = d.select().from(runs).where(and(eq(runs.projectId, i.projectId), inArray(runs.status, ["queued", "running"]))).get();
  if (pending) redirect(`/runs/${pending.id}`);
  const run = requestRun(i.projectId, { trigger: "manual", issueId: id }, d);
  redirect(`/runs/${run.id}`);
}

/** Editing a group by hand locks it: triage will not regroup it (PLAN §6.2). */
export async function removeFromGroup(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const d = db();
  const i = d.select().from(issues).where(eq(issues.id, id)).get();
  if (!i?.groupId) return;
  const gid = i.groupId;
  d.transaction((tx) => {
    tx.update(issueGroups).set({ locked: true, createdBy: "owner", updatedAt: now() }).where(eq(issueGroups.id, gid)).run();
    tx.update(issues).set({ groupId: null, updatedAt: now() }).where(eq(issues.id, id)).run();
    const left = tx.select().from(issues).where(eq(issues.groupId, gid)).all();
    if (left.length < 2) {
      tx.update(issues).set({ groupId: null }).where(eq(issues.groupId, gid)).run();
      tx.delete(issueGroups).where(eq(issueGroups.id, gid)).run();
    }
  });
  refresh();
}

export async function addToGroup(formData: FormData) {
  await guard();
  const id = num(formData.get("issueId"));
  const otherId = num(formData.get("otherIssueId"));
  const d = db();
  const a = d.select().from(issues).where(eq(issues.id, id)).get();
  const b = d.select().from(issues).where(eq(issues.id, otherId)).get();
  if (!a || !b || a.projectId !== b.projectId) return;
  d.transaction((tx) => {
    let gid = a.groupId;
    if (gid === null) {
      gid = tx
        .insert(issueGroups)
        .values({ projectId: a.projectId, title: `${a.shortId} and related`, reasoning: "Grouped by the owner.", createdBy: "owner", locked: true })
        .returning()
        .get().id;
      tx.update(issues).set({ groupId: gid }).where(eq(issues.id, a.id)).run();
    } else {
      tx.update(issueGroups).set({ locked: true, createdBy: "owner", updatedAt: now() }).where(eq(issueGroups.id, gid)).run();
    }
    tx.update(issues).set({ groupId: gid, updatedAt: now() }).where(eq(issues.id, b.id)).run();
  });
  refresh();
}

// ---------- notifications ----------

export async function markRead(formData: FormData) {
  await guard();
  db().update(notifications).set({ readAt: now() }).where(eq(notifications.id, num(formData.get("id")))).run();
  refresh();
}

export async function markAllRead() {
  await guard();
  db().update(notifications).set({ readAt: now() }).where(isNull(notifications.readAt)).run();
  refresh();
}

// ---------- settings ----------

export async function runHealthCheck() {
  await guard();
  if (!hasPendingJob("health_check", null)) enqueueJob("health_check");
  refresh();
}
