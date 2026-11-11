import { config } from "./config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key/i;

/** Remove anything that looks like a credential before it reaches a log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const KNOWN_SECRET_ENV = ["HARNESS_GITHUB_TOKEN", "SENTRY_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "DASHBOARD_PASSWORD"];

export function redactString(s: string): string {
  let out = s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/\bsntry[su]_[A-Za-z0-9_=+/.-]{20,}/g, "[redacted]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@");
  for (const [k, v] of Object.entries(process.env)) {
    if (!KNOWN_SECRET_ENV.includes(k) && !k.startsWith("SENTRY_AUTH_TOKEN_")) continue;
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  return out;
}

export function log(level: Level, msg: string, data?: Record<string, unknown>) {
  let min: Level = "info";
  try {
    min = config().LOG_LEVEL;
  } catch {
    /* config invalid: still log */
  }
  if (LEVELS[level] < LEVELS[min]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: redactString(msg), ...(data ? (redact(data) as object) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const logger = {
  debug: (m: string, d?: Record<string, unknown>) => log("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => log("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => log("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => log("error", m, d),
};
