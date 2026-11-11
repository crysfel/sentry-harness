import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issues, issueGroups, issueSnapshots } from "../src/db/schema";
import { applyTriage, statusFromClassification } from "../src/pipeline/triage-stage";
import { addProject, addRun, quietLog, testDb, triageIssue, triageOutput } from "./helpers";

const WK = triageIssue({ sentryId: "1", shortId: "HIMNARIO-MOBILE-WK", title: "App Hang Fully Blocked: 503 s", users14d: 128, events14d: 183, culprit: "HymnalApp.$main" });
const Y3 = triageIssue({ sentryId: "2", shortId: "HIMNARIO-MOBILE-Y3", title: "App Hang Fully Blocked: 13 s", users14d: 31, events14d: 35, substatus: "escalating", culprit: "HymnalApp.$main" });
const WN = triageIssue({ sentryId: "3", shortId: "HIMNARIO-MOBILE-WN", title: "Fatal App Hang Fully Blocked", users14d: 14, culprit: "HymnalApp.$main" });
const FG = triageIssue({ sentryId: "4", shortId: "HIMNARIO-MOBILE-FG", title: "IllegalArgumentException", classification: "not_in_repo", fixability: "unlikely" });
const X1 = triageIssue({ sentryId: "5", shortId: "HIMNARIO-MOBILE-X1", title: "WatchdogTermination", classification: "not_actionable", fixability: "unlikely" });
const hangGroup = { title: "Main-thread hang at launch", sentryIds: ["1", "2", "3"], reasoning: "All block HymnalApp.$main during launch." };

describe("applyTriage", () => {
  it("upserts issues, writes snapshots and applies classifications", () => {
    const d = testDb();
    const p = addProject(d);
    const r1 = addRun(d, p.id);
    const res = applyTriage(d, p, r1.id, triageOutput({ issues: [WK, Y3, WN, FG, X1], groups: [hangGroup] }), "6.3.3", quietLog());
    expect(res).toMatchObject({ synced: 5, created: 5 });
    const rows = d.select().from(issues).all();
    const by = (s: string) => rows.find((r) => r.shortId === s)!;
    expect(by("HIMNARIO-MOBILE-FG").status).toBe("not_in_repo");
    expect(by("HIMNARIO-MOBILE-X1").status).toBe("not_actionable");
    expect(by("HIMNARIO-MOBILE-X1").nextReviewAt).toBeTruthy();
    expect(by("HIMNARIO-MOBILE-WK").status).toBe("triaged");
    expect(by("HIMNARIO-MOBILE-WK").users14d).toBe(128);
    expect(d.select().from(issueSnapshots).all()).toHaveLength(5);
  });

  it("running twice creates no duplicates and a second set of snapshots; groups stay stable", () => {
    const d = testDb();
    const p = addProject(d);
    const r1 = addRun(d, p.id);
    applyTriage(d, p, r1.id, triageOutput({ issues: [WK, Y3, WN], groups: [hangGroup] }), "6.3.3", quietLog());
    const g1 = d.select().from(issueGroups).all();
    expect(g1).toHaveLength(1);

    const r2 = addRun(d, p.id);
    const res = applyTriage(d, p, r2.id, triageOutput({ issues: [{ ...WK, users14d: 140 }, Y3, WN], groups: [{ ...hangGroup, sentryIds: ["3", "1", "2"] }] }), "6.3.3", quietLog());
    expect(res.created).toBe(0);
    expect(d.select().from(issues).all()).toHaveLength(3);
    expect(d.select().from(issueSnapshots).all()).toHaveLength(6);
    const g2 = d.select().from(issueGroups).all();
    expect(g2.map((g) => g.id)).toEqual(g1.map((g) => g.id));
    expect(d.select().from(issues).all().every((i) => i.groupId === g1[0].id)).toBe(true);
    expect(d.select().from(issues).where(eq(issues.sentryId, "1")).get()!.users14d).toBe(140);
  });

  it("never changes a group the owner locked", () => {
    const d = testDb();
    const p = addProject(d);
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [WK, Y3, WN], groups: [{ ...hangGroup, sentryIds: ["1", "2"] }] }), "6.3.3", quietLog());
    const g = d.select().from(issueGroups).get()!;
    d.update(issueGroups).set({ locked: true, createdBy: "owner" }).where(eq(issueGroups.id, g.id)).run();

    // Triage now proposes regrouping 2 with 3 and dropping 1: locked members must not move.
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [WK, Y3, WN], groups: [{ title: "x", sentryIds: ["2", "3"], reasoning: "y" }] }), "6.3.3", quietLog());
    const rows = d.select().from(issues).all();
    expect(rows.find((r) => r.sentryId === "1")!.groupId).toBe(g.id);
    expect(rows.find((r) => r.sentryId === "2")!.groupId).toBe(g.id);
    expect(rows.find((r) => r.sentryId === "3")!.groupId).toBeNull();
  });

  it("dissolves a triage group the agent no longer proposes", () => {
    const d = testDb();
    const p = addProject(d);
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [WK, Y3], groups: [{ ...hangGroup, sentryIds: ["1", "2"] }] }), "6.3.3", quietLog());
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [WK, Y3], groups: [] }), "6.3.3", quietLog());
    expect(d.select().from(issueGroups).all()).toHaveLength(0);
    expect(d.select().from(issues).all().every((i) => i.groupId === null)).toBe(true);
  });

  it("does not reclassify issues with work in flight, ignored or awaiting release", () => {
    const d = testDb();
    const p = addProject(d);
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [WK, Y3] }), "6.3.3", quietLog());
    d.update(issues).set({ status: "pr_open" }).where(eq(issues.sentryId, "1")).run();
    d.update(issues).set({ status: "ignored", ignored: true }).where(eq(issues.sentryId, "2")).run();
    applyTriage(d, p, addRun(d, p.id).id, triageOutput({ issues: [{ ...WK, classification: "not_actionable" }, { ...Y3, classification: "not_in_repo" }] }), "6.3.3", quietLog());
    const rows = d.select().from(issues).all();
    expect(rows.find((r) => r.sentryId === "1")!.status).toBe("pr_open");
    expect(rows.find((r) => r.sentryId === "2")!.status).toBe("ignored");
  });
});

describe("statusFromClassification", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  it("marks likely_fixed_unreleased with the version on the default branch", () => {
    expect(statusFromClassification("new", { classification: "likely_fixed_unreleased", fixedByCommit: "abc123", reasoning: "" }, "6.3.3", now)).toMatchObject({
      status: "fixed_unreleased",
      expectedVersion: "6.3.3",
    });
  });
  it("keeps attempt_failed for candidates so attempts are counted", () => {
    expect(statusFromClassification("attempt_failed", { classification: "candidate", fixedByCommit: null, reasoning: "" }, "6.3.3", now)?.status).toBe("attempt_failed");
  });
  it("moves not_actionable back to triaged when it becomes a candidate", () => {
    expect(statusFromClassification("not_actionable", { classification: "candidate", fixedByCommit: null, reasoning: "" }, "6.3.3", now)?.status).toBe("triaged");
  });
  it("returns null for statuses triage may not change", () => {
    for (const s of ["queued", "fixing", "pr_open", "merged", "awaiting_release", "fixed_unreleased", "verified_fixed", "pr_closed", "ignored", "needs_human"] as const) {
      expect(statusFromClassification(s, { classification: "candidate", fixedByCommit: null, reasoning: "" }, "6.3.3", now)).toBeNull();
    }
  });
});
