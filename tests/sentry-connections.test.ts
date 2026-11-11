import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { config, loadConfig, parseSentryConnections, resetConfig, sentryConnection } from "../src/core/config";
import { redactString } from "../src/core/logger";
import { writeSentryMcpConfig } from "../src/sentry/mcp-config";
import { setAgentRunner, type AgentRunner } from "../src/agents/runner";
import { executeRun, type RunDeps } from "../src/pipeline/run";
import { runs } from "../src/db/schema";
import { addProject, addRun, testDb, triageOutput } from "./helpers";

const DEFAULT_TOKEN = "sntryu_default_0123456789abcdef0123";
const ACME_TOKEN = "sntryu_acme_0123456789abcdef0123456";

function withTokens(extra: Record<string, string> = {}) {
  resetConfig(loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "error", SENTRY_AUTH_TOKEN: DEFAULT_TOKEN, SENTRY_AUTH_TOKEN_ACME: ACME_TOKEN, SENTRY_HOST_ACME: "acme.sentry.io", ...extra }));
}

const readMcp = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.sentry as { args: string[]; env: Record<string, string> };

afterEach(() => setAgentRunner(undefined));

describe("Sentry connections", () => {
  it("parses the default token and SENTRY_AUTH_TOKEN_<NAME> entries", () => {
    const c = parseSentryConnections({ SENTRY_AUTH_TOKEN: "a", SENTRY_AUTH_TOKEN_ACME: "b", SENTRY_HOST_ACME: "h", SENTRY_AUTH_TOKEN_EMPTY: "", SENTRY_AUTH_TOKEN_CLIENT_2: "c" });
    expect(c).toEqual([
      { name: "default", token: "a", host: undefined },
      { name: "acme", token: "b", host: "h" },
      { name: "client_2", token: "c", host: undefined },
    ]);
  });

  it("lists default even without a token; unknown named connections fail clearly", () => {
    resetConfig(loadConfig({ ...process.env, NODE_ENV: "test" }));
    expect(config().sentryConnections.map((c) => c.name)).toEqual(["default"]);
    expect(() => sentryConnection("acme")).toThrow(/SENTRY_AUTH_TOKEN_ACME/);
  });

  it("each MCP config carries only its own connection's token and host", () => {
    withTokens();
    const a = writeSentryMcpConfig("client-org", "client-app", "acme");
    const b = writeSentryMcpConfig("peacefulhymns-backend", "himnario-mobile");
    try {
      const ma = readMcp(a.file);
      expect(ma.env.SENTRY_AUTH_TOKEN).toBe(ACME_TOKEN);
      expect(ma.env.SENTRY_HOST).toBe("acme.sentry.io");
      expect(ma.args.at(-1)).toBe("client-org/client-app");
      expect(JSON.stringify(ma)).not.toContain(DEFAULT_TOKEN);
      const mb = readMcp(b.file);
      expect(mb.env.SENTRY_AUTH_TOKEN).toBe(DEFAULT_TOKEN);
      expect(mb.env.SENTRY_HOST).toBeUndefined();
      expect(JSON.stringify(mb)).not.toContain(ACME_TOKEN);
      expect(fs.statSync(a.file).mode & 0o777).toBe(0o600);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("redacts named Sentry tokens from logs", () => {
    process.env.SENTRY_AUTH_TOKEN_ZETA = "zeta-secret-value-123";
    try {
      expect(redactString("token zeta-secret-value-123 here")).toBe("token [redacted] here");
    } finally {
      delete process.env.SENTRY_AUTH_TOKEN_ZETA;
    }
  });

  it("a run's triage session uses the project's connection; an unconfigured one fails the run with the variable name", async () => {
    withTokens();
    const d = testDb();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    g("init", "-q", "-b", "main");
    g("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Initial");
    const deps: Partial<RunDeps> = {
      sync: async () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim(),
      commits: async () => [],
      version: async () => "1.0.0",
      checkPr: async () => ({ state: "OPEN", mergedAt: null, mergeCommit: null, url: "" }),
    };
    const seen: string[] = [];
    setAgentRunner((async (input) => {
      seen.push(readMcp(input.mcpConfigFile!).env.SENTRY_AUTH_TOKEN);
      return { output: triageOutput(), sessionId: "s", costUsd: 0, turns: 1, permissionDenials: [] };
    }) as AgentRunner);

    const acme = addProject(d, { localPath: repo, repoSlug: "client/app", sentryConnection: "acme", sentryOrg: "client-org", sentryProject: "client-app" });
    const r1 = addRun(d, acme.id, { dryRun: true });
    await executeRun(d, r1.id, { deps });
    expect(d.select().from(runs).where(eq(runs.id, r1.id)).get()!.status).toBe("succeeded");
    expect(seen).toEqual([ACME_TOKEN]);

    const gone = addProject(d, { localPath: repo, repoSlug: "other/app", sentryConnection: "gone" });
    const r2 = addRun(d, gone.id, { dryRun: true });
    await expect(executeRun(d, r2.id, { deps })).rejects.toThrow(/SENTRY_AUTH_TOKEN_GONE/);
    const run2 = d.select().from(runs).where(eq(runs.id, r2.id)).get()!;
    expect(run2.status).toBe("failed");
    expect(run2.error ?? run2.summary).toMatch(/SENTRY_AUTH_TOKEN_GONE/);
    expect(seen).toHaveLength(1);
  });
});
