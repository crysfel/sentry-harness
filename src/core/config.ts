import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

/**
 * Zod-validated environment. Secrets are optional at parse time so the web
 * process (which needs none of them) and tests can load config; the code that
 * needs a secret calls `requireSecret`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HARNESS_DATA_DIR: z.string().default("data"),
  HARNESS_DB_PATH: z.string().optional(),

  /** Fine-grained PAT limited to registered repos (PLAN §7.1). Given to git and gh only. */
  HARNESS_GITHUB_TOKEN: z.string().min(1).optional(),
  /** Read-only Sentry user auth token for the local Sentry MCP server. */
  SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
  SENTRY_HOST: z.string().optional(),
  /** Long-lived token from `claude setup-token`. Unset = use the machine's interactive login. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  CLAUDE_BIN: z.string().default("claude"),
  SENTRY_MCP_COMMAND: z.string().default("npx"),
  SENTRY_MCP_ARGS: z.string().default("-y @sentry/mcp-server@0.49.0"),

  WORKER_TICK_MS: z.coerce.number().int().positive().default(2000),
  AGENT_TIMEOUT_MINUTES: z.coerce.number().positive().default(45),
  TRIAGE_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),

  /** Dashboard password; required whenever the dashboard is bound beyond localhost. */
  DASHBOARD_PASSWORD: z.string().optional(),
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
});

export type Env = z.infer<typeof EnvSchema>;

export type Config = Env & {
  dataDir: string;
  dbPath: string;
  reposDir: string;
  worktreesDir: string;
  transcriptsDir: string;
  logsDir: string;
  derivedDataDir: string;
};

let cached: Config | undefined;

/** Find the project root (the folder with package.json named sentry-harness). */
export function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "sentry-harness") return dir;
      } catch {
        /* keep looking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(projectRoot(), e.HARNESS_DATA_DIR);
  return {
    ...e,
    dataDir,
    dbPath: e.HARNESS_DB_PATH ? path.resolve(e.HARNESS_DB_PATH) : path.join(dataDir, "harness.db"),
    reposDir: path.join(dataDir, "repos"),
    worktreesDir: path.join(dataDir, "worktrees"),
    transcriptsDir: path.join(dataDir, "transcripts"),
    logsDir: path.join(dataDir, "logs"),
    derivedDataDir: path.join(dataDir, "derived-data"),
  };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** For tests. */
export function resetConfig(c?: Config) {
  cached = c;
}

type SecretName = "HARNESS_GITHUB_TOKEN" | "SENTRY_AUTH_TOKEN";

export function requireSecret(name: SecretName): string {
  const v = config()[name];
  if (!v) throw new Error(`${name} is not set. Add it to .env (see .env.example).`);
  return v;
}

export function ensureDataDirs(c: Config = config()) {
  for (const d of [c.dataDir, c.reposDir, c.worktreesDir, c.transcriptsDir, c.logsDir, c.derivedDataDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
