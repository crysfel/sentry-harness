import type { SelectionRow, IssueStatus } from "../db/schema";

/**
 * Selection (PLAN §6.4). Pure: takes facts, returns decisions with a reason
 * for every candidate. The caller applies status changes.
 */
export type SelectIssue = {
  id: number;
  shortId: string;
  status: IssueStatus;
  classification: string | null;
  fixability: "likely" | "uncertain" | "unlikely" | null;
  impactScore: number;
  groupId: number | null;
  pinned: boolean;
  ignored: boolean;
  attemptsUsed: number;
};

export type SelectOptions = {
  maxFixesPerRun: number;
  maxOpenPrs: number;
  openPrs: number;
  maxAttemptsPerIssue: number;
  threshold: number;
  /** Groups that have a member with an open PR (or mid-fix). */
  busyGroupIds: Set<number>;
  /** Owner asked to fix this issue now: it is selected unless it is impossible. */
  requestedIssueId?: number | null;
};

export type Unit = {
  key: string;
  primary: SelectIssue;
  members: SelectIssue[];
  score: number;
  pinned: boolean;
};

export type SelectResult = {
  selected: Unit[];
  rows: SelectionRow[];
  /** Candidates below threshold: caller marks them low_impact. */
  lowImpactIds: number[];
};

/** Statuses an issue can be selected from. */
export const SELECTABLE: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["triaged", "regressed", "attempt_failed", "low_impact"]);
const IN_FLIGHT: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["queued", "fixing", "pr_open"]);

export function select(issues: SelectIssue[], o: SelectOptions): SelectResult {
  const rows: SelectionRow[] = [];
  const lowImpactIds: number[] = [];
  const row = (i: SelectIssue, selected: boolean, reason: string) =>
    rows.push({ issueId: i.id, shortId: i.shortId, groupId: i.groupId, score: i.impactScore, selected, reason });

  // 1. Eligibility per issue.
  const eligible: SelectIssue[] = [];
  for (const i of issues) {
    const requested = o.requestedIssueId === i.id;
    if (!SELECTABLE.has(i.status) && !(requested && i.status !== "ignored" && !IN_FLIGHT.has(i.status))) continue;
    if (i.classification !== "candidate" && !requested && i.status !== "regressed") continue;
    if (i.ignored) {
      row(i, false, "ignored by owner");
      continue;
    }
    if (i.groupId !== null && o.busyGroupIds.has(i.groupId)) {
      row(i, false, "another issue in its group already has an open PR");
      continue;
    }
    if (i.attemptsUsed >= o.maxAttemptsPerIssue && !requested) {
      row(i, false, `attempts exhausted (${i.attemptsUsed}/${o.maxAttemptsPerIssue})`);
      continue;
    }
    if (i.fixability === "unlikely" && !i.pinned && !requested) {
      row(i, false, "triage judged a code fix unlikely");
      continue;
    }
    eligible.push(i);
  }

  // 2. Group into units: a group is selected as one (PLAN §6.4.1).
  const units = new Map<string, Unit>();
  for (const i of eligible) {
    const key = i.groupId !== null ? `g${i.groupId}` : `i${i.id}`;
    const u = units.get(key);
    if (!u) units.set(key, { key, primary: i, members: [i], score: i.impactScore, pinned: i.pinned });
    else {
      u.members.push(i);
      u.score += i.impactScore;
      u.pinned ||= i.pinned;
      if (i.impactScore > u.primary.impactScore) u.primary = i;
    }
  }
  for (const u of units.values()) {
    const requested = u.members.find((m) => m.id === o.requestedIssueId);
    if (requested) u.primary = requested;
    u.score = Math.round(u.score * 100) / 100;
  }

  // 3. Threshold (pinned and requested bypass it).
  const ranked: Unit[] = [];
  for (const u of units.values()) {
    const requested = u.members.some((m) => m.id === o.requestedIssueId);
    if (!u.pinned && !requested && u.score < o.threshold) {
      for (const m of u.members) {
        row(m, false, `score ${u.score} below threshold ${o.threshold}`);
        lowImpactIds.push(m.id);
      }
      continue;
    }
    ranked.push(u);
  }

  // 4. Requested first, then pinned, then by score.
  const isReq = (u: Unit) => u.members.some((m) => m.id === o.requestedIssueId);
  ranked.sort((a, b) => Number(isReq(b)) - Number(isReq(a)) || Number(b.pinned) - Number(a.pinned) || b.score - a.score);

  const prRoom = Math.max(0, o.maxOpenPrs - o.openPrs);
  const slots = Math.min(o.maxFixesPerRun, prRoom);
  const selected: Unit[] = [];
  for (const u of ranked) {
    const requested = isReq(u);
    if (requested && o.requestedIssueId != null) {
      selected.push(u);
      for (const m of u.members) row(m, true, "requested by owner (Fix now)");
      continue;
    }
    if (o.requestedIssueId != null) {
      for (const m of u.members) row(m, false, "run was for a specific issue");
      continue;
    }
    if (selected.length < slots) {
      selected.push(u);
      const why = u.pinned ? "pinned by owner" : `rank ${selected.length} by impact (score ${u.score})`;
      for (const m of u.members) row(m, true, u.members.length > 1 ? `${why}; group of ${u.members.length}, primary ${u.primary.shortId}` : why);
    } else {
      const why =
        prRoom < o.maxFixesPerRun && selected.length >= prRoom
          ? `open PR cap reached (${o.openPrs}/${o.maxOpenPrs} open)`
          : `out of slots (max ${o.maxFixesPerRun} fixes per run)`;
      for (const m of u.members) row(m, false, why);
    }
  }
  rows.sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score);
  return { selected, rows, lowImpactIds };
}
