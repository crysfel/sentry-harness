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

/**
 * A Sentry login the harness can use. `default` comes from SENTRY_AUTH_TOKEN /
 * SENTRY_HOST; every other one from SENTRY_AUTH_TOKEN_<NAME> / SENTRY_HOST_<NAME>
 * (e.g. SENTRY_AUTH_TOKEN_ACME → "acme"). Projects store only the name, so
 * tokens stay in .env and never reach SQLite.
 */
export type SentryConnection = { name: string; token?: string; host?: string };

export const DEFAULT_SENTRY_CONNECTION = "default";
export const SENTRY_CONNECTION_NAME = /^[a-z0-9][a-z0-9_]*$/;
const NAMED_TOKEN = /^SENTRY_AUTH_TOKEN_([A-Z0-9][A-Z0-9_]*)$/;

export function parseSentryConnections(env: Record<string, string | undefined>): SentryConnection[] {
  const out: SentryConnection[] = [
    { name: DEFAULT_SENTRY_CONNECTION, token: env.SENTRY_AUTH_TOKEN || undefined, host: env.SENTRY_HOST || undefined },
  ];
  for (const key of Object.keys(env).sort()) {
    const m = key.match(NAMED_TOKEN);
    if (!m || !env[key]) continue;
    const name = m[1].toLowerCase();
    if (name === DEFAULT_SENTRY_CONNECTION) continue; // SENTRY_AUTH_TOKEN is the default
    out.push({ name, token: env[key], host: env[`SENTRY_HOST_${m[1]}`] || undefined });
  }
  return out;
}

/** The env variable that holds a connection's token, for messages. */
export function sentryTokenVar(name: string) {
  return name === DEFAULT_SENTRY_CONNECTION ? "SENTRY_AUTH_TOKEN" : `SENTRY_AUTH_TOKEN_${name.toUpperCase()}`;
}

export type Config = Env & {
  sentryConnections: SentryConnection[];
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
    sentryConnections: parseSentryConnections(env),
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

/**
 * The credential for a project's Sentry connection. A named connection without
 * a token is an error; `default` without one is allowed so that tests and a
 * not-yet-configured machine can still run (the MCP server then fails on its own,
 * and health checks report it).
 */
export function sentryConnection(name: string = DEFAULT_SENTRY_CONNECTION): SentryConnection {
  const c = config().sentryConnections.find((x) => x.name === name);
  if (c) return c;
  throw new Error(`Sentry connection "${name}" is not configured: add ${sentryTokenVar(name)} to .env and restart the worker.`);
}

export function ensureDataDirs(c: Config = config()) {
  for (const d of [c.dataDir, c.reposDir, c.worktreesDir, c.transcriptsDir, c.logsDir, c.derivedDataDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
