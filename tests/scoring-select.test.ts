import { describe, expect, it } from "vitest";
import { impactScore, severityOf, trendOf } from "../src/pipeline/scoring";
import { select, type SelectIssue, type SelectOptions } from "../src/pipeline/select";

describe("scoring", () => {
  it("weights crashes and fatal hangs 3, hangs 2, others 1", () => {
    expect(severityOf({ title: "SIGSEGV: Segfault", level: "error", category: null }).weight).toBe(3);
    expect(severityOf({ title: "Fatal App Hang Fully Blocked: …", level: "error", category: null }).weight).toBe(3);
    expect(severityOf({ title: "App Hang Fully Blocked: 13 s", level: "error", category: null }).weight).toBe(2);
    expect(severityOf({ title: "EXC_BREAKPOINT: Fatal error", level: "error", category: null }).weight).toBe(3);
    expect(severityOf({ title: "WatchdogTermination: RAM", level: "error", category: null }).weight).toBe(3);
    expect(severityOf({ title: "hymnal.SupportStore.ProductsError", level: "error", category: null }).weight).toBe(1);
    expect(severityOf({ title: "Anything", level: "fatal", category: null }).weight).toBe(3);
  });

  it("boosts escalating, regressed and new-in-latest-release issues", () => {
    expect(trendOf({ substatus: "escalating", firstRelease: null }, null)).toBe(1.5);
    expect(trendOf({ substatus: "regressed", firstRelease: null }, null)).toBe(1.5);
    expect(trendOf({ substatus: "ongoing", firstRelease: "com.bleext.hymnal@6.3.2+21" }, "com.bleext.hymnal@6.3.2+21")).toBe(1.5);
    expect(trendOf({ substatus: "ongoing", firstRelease: "com.bleext.hymnal@6.3.1+20" }, "com.bleext.hymnal@6.3.2+21")).toBe(1);
  });

  it("matches the reference issues from PLAN §3", () => {
    // Y3: hang, 31 users, escalating → 31 × 2 × 1.5
    expect(impactScore({ title: "App Hang Fully Blocked: 13.0 s", level: "error", category: null, users14d: 31, substatus: "escalating", firstRelease: null }, null)).toBe(93);
    // XQ: plain error, 18 users → 18
    expect(impactScore({ title: "hymnal.SupportStore.ProductsError: noneReturned", level: "error", category: null, users14d: 18, substatus: "ongoing", firstRelease: null }, null)).toBe(18);
  });
});

const base: SelectOptions = { maxFixesPerRun: 2, maxOpenPrs: 5, openPrs: 0, maxAttemptsPerIssue: 2, threshold: 5, busyGroupIds: new Set() };
let nextId = 1;
const issue = (o: Partial<SelectIssue>): SelectIssue => ({
  id: nextId++,
  shortId: `X-${nextId}`,
  status: "triaged",
  classification: "candidate",
  fixability: "likely",
  impactScore: 10,
  groupId: null,
  pinned: false,
  ignored: false,
  attemptsUsed: 0,
  ...o,
});

describe("select", () => {
  it("takes the top max_fixes_per_run by score and explains every decision", () => {
    const a = issue({ impactScore: 50 });
    const b = issue({ impactScore: 30 });
    const c = issue({ impactScore: 20 });
    const r = select([c, a, b], base);
    expect(r.selected.map((u) => u.primary.id)).toEqual([a.id, b.id]);
    expect(r.rows.find((x) => x.issueId === c.id)?.reason).toMatch(/out of slots/);
    expect(r.rows).toHaveLength(3);
  });

  it("drops ignored, unlikely, exhausted, below-threshold and busy-group issues", () => {
    const ignored = issue({ ignored: true, impactScore: 100 });
    const unlikely = issue({ fixability: "unlikely", impactScore: 100 });
    const exhausted = issue({ attemptsUsed: 2, impactScore: 100 });
    const low = issue({ impactScore: 3 });
    const busy = issue({ groupId: 7, impactScore: 100 });
    const ok = issue({ impactScore: 9 });
    const r = select([ignored, unlikely, exhausted, low, busy, ok], { ...base, busyGroupIds: new Set([7]) });
    expect(r.selected.map((u) => u.primary.id)).toEqual([ok.id]);
    expect(r.lowImpactIds).toEqual([low.id]);
    const reason = (id: number) => r.rows.find((x) => x.issueId === id)?.reason;
    expect(reason(ignored.id)).toMatch(/ignored/);
    expect(reason(unlikely.id)).toMatch(/unlikely/);
    expect(reason(exhausted.id)).toMatch(/attempts exhausted/);
    expect(reason(busy.id)).toMatch(/open PR/);
  });

  it("puts pinned issues first regardless of score and below the threshold", () => {
    const big = issue({ impactScore: 500 });
    const pinned = issue({ pinned: true, impactScore: 1 });
    const r = select([big, pinned], { ...base, maxFixesPerRun: 1 });
    expect(r.selected[0].primary.id).toBe(pinned.id);
  });

  it("selects a group as one unit with summed score and the highest-scoring primary", () => {
    const g1 = issue({ groupId: 1, impactScore: 4 });
    const g2 = issue({ groupId: 1, impactScore: 3 });
    const solo = issue({ impactScore: 6 });
    const r = select([g1, g2, solo], { ...base, maxFixesPerRun: 1 });
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0].primary.id).toBe(g1.id);
    expect(r.selected[0].members.map((m) => m.id).sort()).toEqual([g1.id, g2.id].sort());
    expect(r.selected[0].score).toBe(7);
  });

  it("reduces slots when the open-PR cap is near", () => {
    const r = select([issue({}), issue({}), issue({})], { ...base, maxFixesPerRun: 3, openPrs: 4 });
    expect(r.selected).toHaveLength(1);
    expect(r.rows.filter((x) => !x.selected).every((x) => /open PR cap/.test(x.reason))).toBe(true);
  });

  it("selects nothing when the open-PR cap is reached", () => {
    const r = select([issue({ impactScore: 100 })], { ...base, openPrs: 5 });
    expect(r.selected).toHaveLength(0);
  });

  it("Fix now selects the requested issue even below threshold and only it", () => {
    const big = issue({ impactScore: 500 });
    const req = issue({ impactScore: 1, fixability: "unlikely" });
    const r = select([big, req], { ...base, requestedIssueId: req.id });
    expect(r.selected.map((u) => u.primary.id)).toEqual([req.id]);
  });

  it("never selects issues that are not candidates", () => {
    const r = select([issue({ classification: "not_in_repo" }), issue({ status: "pr_open" }), issue({ status: "not_actionable", classification: "not_actionable" })], base);
    expect(r.selected).toHaveLength(0);
  });
});
