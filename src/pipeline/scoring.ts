import { parseVersion, compareVersions } from "../projects/version";

/**
 * Impact scoring (PLAN §6.4.1). Weights live here, in one small tested module,
 * because they will be tuned.
 */
export const WEIGHTS = {
  severity: { crash: 3, fatalHang: 3, hang: 2, other: 1 },
  trend: { rising: 1.5, steady: 1 },
} as const;

export type ScoreInput = {
  title: string;
  level: string | null;
  category: string | null;
  users14d: number;
  substatus: string | null;
  firstRelease: string | null;
};

const CRASH_RE = /^(SIGSEGV|SIGABRT|SIGBUS|SIGILL|SIGTRAP|SIGKILL|EXC_[A-Z_]+|WatchdogTermination|Fatal error|NSInvalidArgumentException|NSRangeException)\b/i;

export function severityOf(i: Pick<ScoreInput, "title" | "level" | "category">): { weight: number; kind: keyof typeof WEIGHTS.severity } {
  const t = i.title.trim();
  if (/^Fatal App Hang/i.test(t)) return { weight: WEIGHTS.severity.fatalHang, kind: "fatalHang" };
  if (/App Hang/i.test(t) || i.category === "app_hang") return { weight: WEIGHTS.severity.hang, kind: "hang" };
  if (i.level === "fatal" || CRASH_RE.test(t) || i.category === "crash") return { weight: WEIGHTS.severity.crash, kind: "crash" };
  return { weight: WEIGHTS.severity.other, kind: "other" };
}

export function trendOf(i: Pick<ScoreInput, "substatus" | "firstRelease">, latestRelease: string | null): number {
  if (i.substatus === "escalating" || i.substatus === "regressed") return WEIGHTS.trend.rising;
  if (latestRelease && i.firstRelease) {
    const a = parseVersion(i.firstRelease);
    const b = parseVersion(latestRelease);
    if (a && b && compareVersions(a, b) === 0) return WEIGHTS.trend.rising;
  }
  return WEIGHTS.trend.steady;
}

export function impactScore(i: ScoreInput, latestRelease: string | null): number {
  const score = i.users14d * severityOf(i).weight * trendOf(i, latestRelease);
  return Math.round(score * 100) / 100;
}
