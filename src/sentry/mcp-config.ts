import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, DEFAULT_SENTRY_CONNECTION, sentryConnection } from "../core/config";

/** Server name used in --mcp-config; tool names become mcp__sentry__<tool>. */
export const SENTRY_SERVER = "sentry";

/** Read-only Sentry tools agents may call (PLAN §6.2). */
export const SENTRY_READ_TOOLS = [
  "search_issues",
  "get_sentry_resource",
  "get_issue_details",
  "get_event_stacktrace",
  "get_issue_tag_values",
  "get_issue_breadcrumbs",
  "find_releases",
  "search_issue_events",
  "search_errors",
] as const;

export const sentryToolNames = (tools: readonly string[] = SENTRY_READ_TOOLS) =>
  tools.map((t) => `mcp__${SENTRY_SERVER}__${t}`);

/**
 * Write a per-session MCP config (mode 600) for the local stdio Sentry server,
 * scoped to one org/project with only the read-only `inspect` skill, using the
 * project's Sentry connection (one token per Sentry account). The token
 * goes in the file's env block, not on a command line where `ps` would show it.
 * Returns the file path and a cleanup function.
 */
export function writeSentryMcpConfig(
  org: string,
  project: string,
  connection: string = DEFAULT_SENTRY_CONNECTION,
): { file: string; cleanup: () => void } {
  const cfg = config();
  const conn = sentryConnection(connection);
  const env: Record<string, string> = { MCP_SKILLS: "inspect" };
  if (conn.token) env.SENTRY_AUTH_TOKEN = conn.token;
  if (conn.host) env.SENTRY_HOST = conn.host;
  if (process.env.PATH) env.PATH = process.env.PATH;

  const args = [...cfg.SENTRY_MCP_ARGS.split(/\s+/).filter(Boolean), "mcp", "--skills", "inspect", `${org}/${project}`];
  const json = { mcpServers: { [SENTRY_SERVER]: { type: "stdio", command: cfg.SENTRY_MCP_COMMAND, args, env } } };

  const dir = path.join(cfg.dataDir, "mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `sentry-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(json), { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(file, { force: true }) };
}
