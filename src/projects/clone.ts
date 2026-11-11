import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, type Project } from "../db/schema";
import { config } from "../core/config";
import { checkRepoAccess, type GhOptions } from "../github/gh";
import { gitOk, httpsUrl, currentBranchOfRemote } from "../github/git";
import { detectPreset } from "./presets";
import type { EventLogger } from "../db/queries/events";
import { notify } from "../notify/notify";

export function projectRepoDir(projectId: number) {
  return path.join(config().reposDir, String(projectId));
}

export function projectDerivedDataDir(projectId: number) {
  return path.join(config().derivedDataDir, String(projectId));
}

/**
 * Clone job (PLAN §8.2–3): verify token access, clone over HTTPS into
 * data/repos/<id>, detect the default branch and a preset, pre-fill commands.
 */
export async function cloneProject(
  d: Db,
  project: Project,
  log: EventLogger,
  opts: { signal?: AbortSignal; gh?: GhOptions; token?: string } = {},
) {
  const set = (values: Partial<typeof projects.$inferInsert>) =>
    d.update(projects).set({ ...values, updatedAt: new Date().toISOString() }).where(eq(projects.id, project.id)).run();

  set({ cloneStatus: "cloning", cloneError: null });
  try {
    log.info("clone", `checking GitHub token access to ${project.repoSlug}`);
    const access = await checkRepoAccess(project.repoSlug, opts.gh);
    if (!access.ok) throw new Error(access.message);

    const dir = projectRepoDir(project.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    log.info("clone", `cloning ${project.repoSlug} over HTTPS`);
    await gitOk(["clone", "--no-tags", httpsUrl(project.repoSlug), dir], {
      auth: true,
      token: opts.token,
      timeoutMs: 20 * 60_000,
      signal: opts.signal,
    });
    const defaultBranch = access.defaultBranch ?? (await currentBranchOfRemote(dir)) ?? "main";

    log.info("clone", "detecting project preset");
    const det = await detectPreset(dir, { derivedDataPath: projectDerivedDataDir(project.id) });
    log.info("clone", `preset ${det.preset}`, det.info);

    // Keep commands the owner already edited; only fill blanks.
    set({
      cloneStatus: "ready",
      cloneError: null,
      localPath: dir,
      defaultBranch,
      preset: det.preset,
      presetInfo: det.info,
      setupCmd: project.setupCmd ?? det.setupCmd,
      buildCmd: project.buildCmd ?? det.buildCmd,
      testCmd: project.testCmd ?? det.testCmd,
      versionCmd: project.versionCmd ?? det.versionCmd,
      reviewAuthors: project.reviewAuthors ?? (access.ownerLogin ? [access.ownerLogin] : []),
    });
    notify(d, {
      projectId: project.id,
      kind: "project_ready",
      title: `${project.name} is cloned`,
      body: `Detected preset ${det.preset}. Review the proposed commands, then run "Test configuration".`,
      link: `/projects/${project.id}`,
    });
    return { defaultBranch, preset: det.preset };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set({ cloneStatus: "error", cloneError: message });
    log.error("clone", message);
    notify(d, { projectId: project.id, kind: "project_error", title: `Could not add ${project.name}`, body: message, link: `/projects/${project.id}` });
    throw err;
  }
}
