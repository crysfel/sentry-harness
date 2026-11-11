import { z } from "zod";

/** Triage output (PLAN §6.2). Facts are copied from Sentry; classification is judgment. */
export const TriageIssue = z.object({
  sentryId: z.string().min(1),
  shortId: z.string().min(1),
  title: z.string(),
  url: z.string(),
  culprit: z.string().nullable(),
  level: z.string(),
  substatus: z.string(),
  events14d: z.number().int().nonnegative(),
  users14d: z.number().int().nonnegative(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  firstRelease: z.string().nullable(),
  lastReleaseSeen: z.string().nullable(),
  /** "error", "app_hang", "crash", "watchdog", … as Sentry or the agent sees it. */
  category: z.string().nullable(),
  classification: z.enum(["candidate", "not_in_repo", "not_actionable", "likely_fixed_unreleased"]),
  fixability: z.enum(["likely", "uncertain", "unlikely"]),
  fixedByCommit: z.string().nullable(),
  reasoning: z.string(),
  relevantFiles: z.array(z.string()),
});
export type TriageIssue = z.infer<typeof TriageIssue>;

export const TriageGroup = z.object({
  title: z.string(),
  sentryIds: z.array(z.string()).min(2),
  reasoning: z.string(),
});

export const TriageOutput = z.object({
  latestRelease: z.object({ version: z.string(), firstEventAt: z.string() }).nullable(),
  /** Releases with their first event time, newest first; used for shipped-fix verification (PLAN §6.3). */
  releases: z.array(z.object({ version: z.string(), firstEventAt: z.string().nullable() })),
  issues: z.array(TriageIssue),
  groups: z.array(TriageGroup),
  /**
   * For issues awaiting verification: whether the issue has events in any
   * release >= the expected version, copied from Sentry (PLAN §6.3).
   */
  verification: z.array(
    z.object({
      sentryId: z.string(),
      expectedVersion: z.string(),
      eventsInReleaseGte: z.number().int().nonnegative(),
      releasesSeen: z.array(z.string()),
    }),
  ),
  notes: z.string(),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

/** Fix output (PLAN §6.5.3). */
export const FixOutput = z.object({
  outcome: z.enum(["fixed", "no_fix", "needs_human"]),
  rootCause: z.string(),
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  testsAdded: z.boolean(),
  coveredSentryIds: z.array(z.string()),
  /** A commit subject in the repository's style. */
  commitSubject: z.string(),
  notes: z.string(),
});
export type FixOutput = z.infer<typeof FixOutput>;

/** Revision output (PLAN §6.9.3). */
export const RevisionOutput = z.object({
  outcome: z.enum(["revised", "reply_only", "needs_human"]),
  summary: z.string(),
  commitSubject: z.string(),
  responses: z.array(
    z.object({
      githubId: z.string(),
      action: z.enum(["changed", "declined", "answered"]),
      reply: z.string(),
    }),
  ),
});
export type RevisionOutput = z.infer<typeof RevisionOutput>;
