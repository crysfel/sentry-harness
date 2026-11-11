import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDirs, projectRoot } from "../core/config";
import { logger } from "../core/logger";
import { db, runMigrations } from "../db/client";
import { settings } from "../db/schema";
import { claimNextJob, finishJob } from "../db/queries/jobs";
import { recordEvent } from "../db/queries/events";
import { ProcessLock } from "./lock";
import { recoverAfterCrash } from "./recovery";
import { Scheduler } from "./scheduler";
import { handlers, JobCancelled } from "./handlers";
import { queueDueFeedbackPolls } from "../pipeline/feedback";

function loadEnvFile() {
  const file = path.join(projectRoot(), ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export async function main() {
  loadEnvFile();
  const cfg = config();
  ensureDataDirs(cfg);
  const lock = new ProcessLock(path.join(cfg.dataDir, "worker.lock"));
  if (!lock.acquire()) {
    logger.error("another worker is already running; exiting");
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn("ANTHROPIC_API_KEY is set; it will be removed from agent environments so the subscription login is used");
  }

  const d = db();
  runMigrations(d);
  recoverAfterCrash(d);

  const scheduler = new Scheduler(d);
  // PR review feedback is polled on its own cadence (PLAN §6.9).
  scheduler.onTick(() => queueDueFeedbackPolls(d));
  scheduler.start();

  let stopping = false;
  let current: Promise<void> | undefined;
  const controller = new AbortController();

  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`worker received ${sig}, stopping`);
    scheduler.stop();
    controller.abort();
    if (current) await current.catch(() => undefined);
    lock.release();
    logger.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  logger.info("worker started", { pid: process.pid, db: cfg.dbPath });
  // Heartbeat on a timer so it keeps beating during long jobs; the dashboard shows it.
  const beat = () => {
    logger.info("heartbeat");
    const value = { at: new Date().toISOString(), pid: process.pid };
    try {
      d.insert(settings).values({ key: "worker_heartbeat", value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: value.at } }).run();
    } catch (err) {
      logger.warn("heartbeat write failed", { err: String(err) });
    }
  };
  beat();
  const heartbeat = setInterval(beat, 60_000);
  controller.signal.addEventListener("abort", () => clearInterval(heartbeat), { once: true });

  while (!stopping) {
    const job = claimNextJob(d);
    if (!job) {
      await sleep(cfg.WORKER_TICK_MS, controller.signal);
      continue;
    }
    current = (async () => {
      const handler = handlers[job.kind];
      const ctx = { jobId: job.id, runId: job.runId };
      recordEvent(ctx, "job", `started ${job.kind} job #${job.id}`);
      try {
        const result = await handler(job, { db: d, signal: controller.signal });
        finishJob(job.id, "succeeded", { result }, d);
        recordEvent(ctx, "job", `finished ${job.kind} job #${job.id}`);
      } catch (err) {
        const cancelled = err instanceof JobCancelled;
        const message = err instanceof Error ? err.message : String(err);
        finishJob(job.id, cancelled ? "cancelled" : "failed", { error: message }, d);
        recordEvent(ctx, "job", `${job.kind} job #${job.id} ${cancelled ? "cancelled" : "failed"}: ${message}`, {
          level: cancelled ? "warn" : "error",
        });
      }
    })();
    await current;
    current = undefined;
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

if (process.argv[1] && /worker[/\\]index\.[tj]s$/.test(process.argv[1])) {
  main().catch((err) => {
    logger.error("worker crashed", { err: err instanceof Error ? err.stack : String(err) });
    process.exit(1);
  });
}
