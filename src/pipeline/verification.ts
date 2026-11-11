import { compareVersions, parseVersion } from "../projects/version";

/**
 * Shipped-fix verification thresholds (PLAN §6.3). Kept in one tested module.
 *
 * TODO(first refinement): this ignores how quickly users adopt the new release,
 * so early days overstate `expected`. Acceptable for v1 because of MIN_DAYS.
 */
export const VERIFY = {
  EXPECTED_EVENTS: 5,
  MIN_DAYS: 3,
  PRESUME_AFTER_DAYS: 30,
} as const;

export type VerifyInput = {
  expectedVersion: string;
  baselineEventsPerDay: number | null;
  /** Releases with first-event times, from triage. */
  releases: Array<{ version: string; firstEventAt: string | null }>;
  /** Events of this issue in releases >= expectedVersion, from triage. */
  eventsInReleaseGte: number;
  now: Date;
};

export type VerifyDecision =
  | { outcome: "waiting_release"; message: string }
  | { outcome: "regressed"; message: string }
  | { outcome: "verified"; confidence: "confirmed" | "presumed"; message: string }
  | { outcome: "waiting"; expected: number; observedDays: number; message: string };

const DAY = 86_400_000;

export function decideVerification(i: VerifyInput): VerifyDecision {
  const min = parseVersion(i.expectedVersion);
  if (!min) return { outcome: "waiting_release", message: `Cannot parse expected version ${i.expectedVersion}.` };

  const shipped = i.releases
    .filter((r) => {
      const v = parseVersion(r.version);
      return v && compareVersions(v, min) >= 0 && r.firstEventAt;
    })
    .map((r) => new Date(r.firstEventAt!).getTime())
    .filter((t) => !Number.isNaN(t));

  if (shipped.length === 0) {
    return { outcome: "waiting_release", message: `No release ≥ ${i.expectedVersion} has events yet.` };
  }
  if (i.eventsInReleaseGte > 0) {
    return { outcome: "regressed", message: `${i.eventsInReleaseGte} event(s) in a release ≥ ${i.expectedVersion}.` };
  }

  const firstShippedAt = Math.min(...shipped);
  const observedDays = Math.max(0, (i.now.getTime() - firstShippedAt) / DAY);
  const baseline = i.baselineEventsPerDay ?? 0;
  const expected = baseline * observedDays;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  if (expected >= VERIFY.EXPECTED_EVENTS && observedDays >= VERIFY.MIN_DAYS) {
    return {
      outcome: "verified",
      confidence: "confirmed",
      message: `No events in ${r1(observedDays)} days on ≥ ${i.expectedVersion}, where ${r1(expected)} were expected.`,
    };
  }
  if (observedDays >= VERIFY.PRESUME_AFTER_DAYS) {
    return {
      outcome: "verified",
      confidence: "presumed",
      message: `No events in ${Math.floor(observedDays)} days on ≥ ${i.expectedVersion}, but the issue is rare (${r1(expected)} expected), so this is presumed rather than confirmed.`,
    };
  }
  return {
    outcome: "waiting",
    expected: r1(expected),
    observedDays: r1(observedDays),
    message: `${r1(expected)} of ${VERIFY.EXPECTED_EVENTS} expected events observed without a recurrence (${r1(observedDays)} days on ≥ ${i.expectedVersion}).`,
  };
}

/**
 * Average daily events over the 14 days before `mergedAt`, from snapshots
 * (each snapshot holds a rolling 14-day count). Uses the latest snapshot at or
 * before the merge; falls back to the current 14-day count.
 */
export function baselineEventsPerDay(
  snapshots: Array<{ capturedAt: string; events14d: number }>,
  mergedAt: string,
  fallbackEvents14d: number,
): number {
  const t = new Date(mergedAt).getTime();
  const before = snapshots.filter((s) => new Date(s.capturedAt).getTime() <= t).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const events = before.length ? before[before.length - 1].events14d : fallbackEvents14d;
  return Math.round((events / 14) * 1000) / 1000;
}
