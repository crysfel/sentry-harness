import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, type Project } from "../db/schema";
import { config } from "../core/config";
import { runShellString, tail } from "../core/shell";
import { syncDefaultBranch } from "../github/git";
import { createWorktree, removeWorktree } from "./worktree";
import { readVersion } from "./version";
import type { EventLogger } from "../db/queries/events";
import { notify } from "../notify/notify";

export type StepResult = { step: string; ok: boolean; durationMs: number; exitCode: number | null; tail: string };

/**
 * "Test configuration" (PLAN §8.4): run setup, build and test on a clean
 * worktree. A project cannot be enabled until this passes once.
 */
export async function testProjectConfig(d: Db, project: Project, log: EventLogger, opts: { jobId: number; signal?: AbortSignal }) {
  if (project.cloneStatus !== "ready" || !project.localPath || !project.defaultBranch) {
    throw new Error("The project is not cloned yet.");
  }
  const logFile = path.join(config().logsDir, `config-test-${project.id}-${opts.jobId}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const steps: StepResult[] = [];
  let wtPath: string | null = null;
  try {
    const sha = await syncDefaultBranch(project.localPath, project.defaultBranch, opts.signal);
    const wt = await createWorktree(project.localPath, project.id, `config-test-${opts.jobId}`, { base: sha, signal: opts.signal });
    wtPath = wt.path;
    const version = await readVersion(wt.path, project.versionCmd);
    log.info("config-test", `worktree at ${sha.slice(0, 8)}, version ${version ?? "unknown"}`);

    const commands: Array<[string, string | null, number]> = [
      ["setup", project.setupCmd, 30 * 60_000],
      ["build", project.buildCmd, 60 * 60_000],
      ["test", project.testCmd, 60 * 60_000],
    ];
    for (const [step, cmd, timeoutMs] of commands) {
      if (!cmd) {
        if (step === "setup") continue;
        steps.push({ step, ok: false, durationMs: 0, exitCode: null, tail: `No ${step} command configured.` });
        break;
      }
      fs.appendFileSync(logFile, `\n===== ${step}: ${cmd}\n`);
      log.info("config-test", `running ${step}`, { cmd });
      const r = await runShellString(cmd, { cwd: wt.path, timeoutMs, logFile, signal: opts.signal });
      const res = { step, ok: r.ok, durationMs: r.durationMs, exitCode: r.exitCode, tail: tail(r.stdout + "\n" + r.stderr, 60) };
      steps.push(res);
      log[r.ok ? "info" : "error"]("config-test", `${step} ${r.ok ? "passed" : r.timedOut ? "timed out" : `failed (exit ${r.exitCode})`} in ${Math.round(r.durationMs / 1000)}s`, {
        exitCode: r.exitCode,
        durationMs: r.durationMs,
      });
      if (!r.ok) break;
    }
    const ok = steps.length > 0 && steps.every((s) => s.ok) && steps.some((s) => s.step === "test");
    d.update(projects)
      .set({ configTestOk: ok, configTestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(projects.id, project.id))
      .run();
    notify(d, {
      projectId: project.id,
      kind: "config_test",
      title: `${project.name}: configuration test ${ok ? "passed" : "failed"}`,
      body: steps.map((s) => `${s.step}: ${s.ok ? "ok" : "failed"} (${Math.round(s.durationMs / 1000)}s)`).join(" · "),
      link: `/projects/${project.id}`,
    });
    return { ok, version, steps, logFile };
  } finally {
    if (wtPath) await removeWorktree(project.localPath, wtPath);
  }
}
