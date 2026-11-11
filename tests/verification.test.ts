import { describe, expect, it } from "vitest";
import { decideVerification, baselineEventsPerDay } from "../src/pipeline/verification";
import { compareVersions, parseVersion, versionGte } from "../src/projects/version";

const day = 86_400_000;
const shippedAt = new Date("2026-12-01T00:00:00Z");
const releases = [
  { version: "com.bleext.hymnal@6.3.2+21", firstEventAt: "2026-11-01T00:00:00Z" },
  { version: "com.bleext.hymnal@6.3.3+22", firstEventAt: shippedAt.toISOString() },
];
const at = (days: number) => new Date(shippedAt.getTime() + days * day);

describe("versions", () => {
  it("compares the part between @ and +", () => {
    expect(parseVersion("com.bleext.hymnal@6.3.2+21")).toEqual([6, 3, 2]);
    expect(parseVersion("6.3")).toEqual([6, 3, 0]);
    expect(compareVersions("com.bleext.hymnal@6.10.0+1", "6.9.9")).toBeGreaterThan(0);
    expect(versionGte("com.bleext.hymnal@6.3.3+22", "6.3.3")).toBe(true);
    expect(versionGte("com.bleext.hymnal@5.9.0+3", "6.0.0")).toBe(false);
  });
});

describe("shipped-fix verification (PLAN §6.3)", () => {
  it("waits while no release ≥ V has events", () => {
    const d = decideVerification({ expectedVersion: "6.3.4", baselineEventsPerDay: 10, releases, eventsInReleaseGte: 0, now: at(10) });
    expect(d.outcome).toBe("waiting_release");
  });

  it("regresses when the issue has events in a release ≥ V", () => {
    const d = decideVerification({ expectedVersion: "6.3.3", baselineEventsPerDay: 10, releases, eventsInReleaseGte: 2, now: at(1) });
    expect(d.outcome).toBe("regressed");
  });

  it("confirms a frequent issue after 3 days", () => {
    const d = decideVerification({ expectedVersion: "6.3.3", baselineEventsPerDay: 4, releases, eventsInReleaseGte: 0, now: at(3) });
    expect(d).toMatchObject({ outcome: "verified", confidence: "confirmed" });
  });

  it("does not confirm a frequent issue before 3 days even with enough expected events", () => {
    const d = decideVerification({ expectedVersion: "6.3.3", baselineEventsPerDay: 100, releases, eventsInReleaseGte: 0, now: at(2) });
    expect(d.outcome).toBe("waiting");
  });

  it("keeps a rare issue waiting after 3 days and reports progress", () => {
    const d = decideVerification({ expectedVersion: "6.3.3", baselineEventsPerDay: 0.1, releases, eventsInReleaseGte: 0, now: at(3) });
    expect(d.outcome).toBe("waiting");
    if (d.outcome === "waiting") {
      expect(d.expected).toBeCloseTo(0.3, 1);
      expect(d.message).toMatch(/0\.3 of 5 expected events/);
    }
  });

  it("presumes a rare issue fixed at 30 days", () => {
    const d = decideVerification({ expectedVersion: "6.3.3", baselineEventsPerDay: 0.1, releases, eventsInReleaseGte: 0, now: at(30) });
    expect(d).toMatchObject({ outcome: "verified", confidence: "presumed" });
  });

  it("computes the baseline from the last snapshot before the merge", () => {
    const snaps = [
      { capturedAt: "2026-11-01T06:00:00Z", events14d: 14 },
      { capturedAt: "2026-11-05T06:00:00Z", events14d: 28 },
      { capturedAt: "2026-11-09T06:00:00Z", events14d: 70 },
    ];
    expect(baselineEventsPerDay(snaps, "2026-11-06T00:00:00Z", 0)).toBe(2);
    expect(baselineEventsPerDay([], "2026-11-06T00:00:00Z", 7)).toBe(0.5);
  });
});
