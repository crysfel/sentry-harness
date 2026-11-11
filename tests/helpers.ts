import { openDb, runMigrations, setDb, type Db } from "../src/db/client";
import { issues, projects, runs, type IssueStatus } from "../src/db/schema";
import type { TriageIssue, TriageOutput } from "../src/agents/schemas";
import { eventLogger } from "../src/db/queries/events";

export function testDb(): Db {
  const d = openDb(":memory:");
  runMigrations(d);
  setDb(d);
  return d;
}

export function addProject(d: Db, over: Partial<typeof projects.$inferInsert> = {}) {
  return d
    .insert(projects)
    .values({
      name: "hymnal-ios",
      repoSlug: "crysfel/hymnal-ios",
      repoUrl: "https://github.com/crysfel/hymnal-ios.git",
      sentryOrg: "peacefulhymns-backend",
      sentryProject: "himnario-mobile",
      cloneStatus: "ready",
      localPath: "/nonexistent/repo",
      defaultBranch: "main",
      versionCmd: "echo 6.3.3",
      buildCmd: "true",
      testCmd: "true",
      ...over,
    })
    .returning()
    .get();
}

export function addRun(d: Db, projectId: number, over: Partial<typeof runs.$inferInsert> = {}) {
  return d.insert(runs).values({ projectId, trigger: "manual", status: "queued", ...over }).returning().get();
}

export function addIssue(d: Db, projectId: number, over: Partial<typeof issues.$inferInsert> & { status?: IssueStatus } = {}) {
  const n = Math.floor(Math.random() * 1e9);
  return d
    .insert(issues)
    .values({
      projectId,
      sentryId: String(n),
      shortId: `HIMNARIO-MOBILE-${n.toString(36).toUpperCase()}`,
      title: "Some error",
      users14d: 10,
      events14d: 20,
      classification: "candidate",
      fixability: "likely",
      status: "triaged",
      ...over,
    })
    .returning()
    .get();
}

export function triageIssue(over: Partial<TriageIssue> & { sentryId: string; shortId: string }): TriageIssue {
  return {
    title: "SIGSEGV: Segfault",
    url: `https://sentry.io/issues/${over.shortId}`,
    culprit: null,
    level: "error",
    substatus: "ongoing",
    events14d: 10,
    users14d: 8,
    firstSeen: "2026-10-29T13:00:55Z",
    lastSeen: "2026-11-07T00:39:18Z",
    firstRelease: "com.bleext.hymnal@6.3.0+10",
    lastReleaseSeen: "com.bleext.hymnal@6.3.2+21",
    category: null,
    classification: "candidate",
    fixability: "likely",
    fixedByCommit: null,
    reasoning: "Because.",
    relevantFiles: [],
    ...over,
  };
}

export function triageOutput(over: Partial<TriageOutput> = {}): TriageOutput {
  return {
    latestRelease: { version: "com.bleext.hymnal@6.3.2+21", firstEventAt: "2026-11-01T00:00:00Z" },
    releases: [{ version: "com.bleext.hymnal@6.3.2+21", firstEventAt: "2026-11-01T00:00:00Z" }],
    issues: [],
    groups: [],
    verification: [],
    notes: "",
    ...over,
  };
}

export const quietLog = () => eventLogger({});
