import { db as defaultDb, type Db } from "../client";
import { runEvents } from "../schema";
import { redact, redactString, logger, type Level } from "../../core/logger";

export type EventContext = {
  runId?: number | null;
  jobId?: number | null;
  issueId?: number | null;
  attemptId?: number | null;
};

/** Append to run_events (and the process log). Never throws. */
export function recordEvent(
  ctx: EventContext,
  stage: string,
  message: string,
  opts: { level?: Level; data?: unknown } = {},
  d: Db = defaultDb(),
) {
  const level = opts.level ?? "info";
  try {
    d.insert(runEvents)
      .values({
        runId: ctx.runId ?? null,
        jobId: ctx.jobId ?? null,
        issueId: ctx.issueId ?? null,
        attemptId: ctx.attemptId ?? null,
        stage,
        level,
        message: redactString(message).slice(0, 4000),
        data: opts.data === undefined ? null : redact(opts.data),
      })
      .run();
  } catch (err) {
    logger.error("failed to record event", { err: String(err) });
  }
  logger[level](`[${stage}] ${message}`, { runId: ctx.runId, jobId: ctx.jobId, issueId: ctx.issueId });
}

/** A bound logger for one run / job / attempt. */
export function eventLogger(ctx: EventContext, d?: Db) {
  const at = (level: Level) => (stage: string, message: string, data?: unknown) =>
    recordEvent(ctx, stage, message, { level, data }, d);
  return {
    ctx,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    with: (more: EventContext) => eventLogger({ ...ctx, ...more }, d),
  };
}
export type EventLogger = ReturnType<typeof eventLogger>;
