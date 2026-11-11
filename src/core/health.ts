import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, settings } from "../db/schema";
import { config } from "./config";
import { run } from "./shell";
import { gh, branchProtected } from "../github/gh";

export type HealthCheck = { name: string; ok: boolean | null; detail: string };
export type HealthReport = { checkedAt: string; checks: HealthCheck[] };

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/**
 * Health checks run by the worker (PLAN §9 /settings, §7.1 tests). The result
 * is stored in settings under "health" for the dashboard to read.
 */
export async function runHealthChecks(d: Db): Promise<HealthReport> {
  const cfg = config();
  const checks: HealthCheck[] = [];
  const add = (name: string, ok: boolean | null, detail: string) => checks.push({ name, ok, detail });

  const claude = await run(cfg.CLAUDE_BIN, ["--version"], { timeoutMs: 30_000 }).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
  add("Claude Code CLI", claude.ok, claude.ok ? firstLine(claude.stdout) : firstLine(claude.stderr) || "not found");
  add(
    "Claude credential",
    cfg.CLAUDE_CODE_OAUTH_TOKEN ? true : null,
    cfg.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN is set (from claude setup-token)" : "Not set: sessions use this machine's interactive login. Run `claude setup-token` for the unattended worker.",
  );
  add("ANTHROPIC_API_KEY absent", !process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY ? "Set in the worker environment; it is stripped from agent sessions, but remove it from the plist." : "Not set");
  add("Sentry token", cfg.SENTRY_AUTH_TOKEN ? true : false, cfg.SENTRY_AUTH_TOKEN ? "SENTRY_AUTH_TOKEN is set" : "SENTRY_AUTH_TOKEN is missing; triage cannot read Sentry.");

  if (cfg.SENTRY_AUTH_TOKEN) {
    const r = await run(cfg.SENTRY_MCP_COMMAND, [...cfg.SENTRY_MCP_ARGS.split(/\s+/), "auth", "whoami"], {
      timeoutMs: 120_000,
      env: { SENTRY_AUTH_TOKEN: cfg.SENTRY_AUTH_TOKEN, SENTRY_HOST: cfg.SENTRY_HOST },
    }).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
    add("Sentry MCP server", r.ok, r.ok ? firstLine(r.stdout) || "reachable" : firstLine(r.stderr || r.stdout));
  }

  if (cfg.HARNESS_GITHUB_TOKEN) {
    const user = await gh(["api", "user", "--jq", ".login"]).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
    add("GitHub token (gh)", user.ok, user.ok ? `authenticated as ${user.stdout.trim()}` : firstLine(user.stderr));
    for (const p of d.select().from(projects).all()) {
      const repo = await gh(["api", `repos/${p.repoSlug}`, "--jq", ".permissions.push"]).catch(() => ({ ok: false, stdout: "", stderr: "" }));
      add(`Token access: ${p.repoSlug}`, repo.ok && repo.stdout.trim() === "true", repo.ok ? (repo.stdout.trim() === "true" ? "read and push" : "read only") : "no access");
      if (p.defaultBranch) {
        const prot = await branchProtected(p.repoSlug, p.defaultBranch).catch(() => null);
        add(`Branch protection: ${p.repoSlug}@${p.defaultBranch}`, prot, prot === null ? "could not check" : prot ? "protected" : "NOT protected: require a pull request on this branch");
      }
    }
  } else {
    add("GitHub token (gh)", false, "HARNESS_GITHUB_TOKEN is missing.");
  }

  const ssh = fs.existsSync(`${process.env.HOME}/.ssh`) && fs.readdirSync(`${process.env.HOME}/.ssh`).some((f) => f.startsWith("id_"));
  add("No SSH key on this account", !ssh, ssh ? "An SSH key exists in ~/.ssh; the harness never uses it, but the dedicated account should not have one (PLAN §7.1)." : "none found");

  const xc = await run("xcodebuild", ["-version"], { timeoutMs: 60_000 }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  add("Xcode", xc.ok, xc.ok ? xc.stdout.trim().replace(/\n/g, " · ") : "xcodebuild not available");
  const sims = await run("xcrun", ["simctl", "list", "devices", "available"], { timeoutMs: 60_000 }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  const iphones = (sims.stdout.match(/iPhone/g) ?? []).length;
  add("iOS simulators", sims.ok && iphones > 0, sims.ok ? `${iphones} iPhone simulators available` : "simctl failed");

  const df = await run("df", ["-k", cfg.dataDir], { timeoutMs: 10_000 }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  if (df.ok) {
    const avail = Number(df.stdout.trim().split("\n").pop()?.split(/\s+/)[3] ?? 0) / 1024 / 1024;
    add("Disk space", avail > 20, `${avail.toFixed(1)} GB free`);
  }

  const report = { checkedAt: new Date().toISOString(), checks };
  d.insert(settings)
    .values({ key: "health", value: report })
    .onConflictDoUpdate({ target: settings.key, set: { value: report, updatedAt: report.checkedAt } })
    .run();
  return report;
}

export function readHealth(d: Db): HealthReport | null {
  const row = d.select().from(settings).where(eq(settings.key, "health")).get();
  return (row?.value as HealthReport) ?? null;
}
