import { Cron } from "croner";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, runs } from "../db/schema";
import { requestRun } from "../db/queries/jobs";
import { logger } from "../core/logger";

/**
 * In-process cron (PLAN §2 "Scheduling"). One Cron per enabled project, rebuilt
 * every minute so schedule edits from the dashboard take effect without a restart.
 */
export class Scheduler {
  private crons = new Map<number, { expr: string; cron: Cron }>();
  private refresher?: NodeJS.Timeout;
  private extraTickers: Array<() => void> = [];

  constructor(private d: Db) {}

  /** Register something to run on every refresh tick (e.g. feedback polling). */
  onTick(fn: () => void) {
    this.extraTickers.push(fn);
  }

  start() {
    this.refresh();
    this.refresher = setInterval(() => this.refresh(), 60_000);
  }

  stop() {
    if (this.refresher) clearInterval(this.refresher);
    for (const { cron } of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  nextRun(projectId: number): Date | null {
    return this.crons.get(projectId)?.cron.nextRun() ?? null;
  }

  refresh() {
    const enabled = this.d.select().from(projects).where(eq(projects.enabled, true)).all();
    const seen = new Set<number>();
    for (const p of enabled) {
      seen.add(p.id);
      const existing = this.crons.get(p.id);
      if (existing?.expr === p.scheduleCron) continue;
      existing?.cron.stop();
      try {
        const cron = new Cron(p.scheduleCron, { name: `project-${p.id}`, protect: true }, () => this.fire(p.id));
        this.crons.set(p.id, { expr: p.scheduleCron, cron });
        logger.info("scheduled project", { projectId: p.id, cron: p.scheduleCron, next: cron.nextRun()?.toISOString() });
      } catch (err) {
        logger.error("invalid schedule_cron", { projectId: p.id, cron: p.scheduleCron, err: String(err) });
        this.crons.delete(p.id);
      }
    }
    for (const [id, { cron }] of this.crons) {
      if (!seen.has(id)) {
        cron.stop();
        this.crons.delete(id);
      }
    }
    for (const fn of this.extraTickers) {
      try {
        fn();
      } catch (err) {
        logger.error("scheduler tick failed", { err: String(err) });
      }
    }
  }

  fire(projectId: number) {
    const pending = this.d
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.status, ["queued", "running"])))
      .get();
    if (pending) {
      logger.info("skipping scheduled run; one is already pending", { projectId, runId: pending.id });
      return;
    }
    const run = requestRun(projectId, { trigger: "schedule" }, this.d);
    logger.info("queued scheduled run", { projectId, runId: run.id });
  }
}
