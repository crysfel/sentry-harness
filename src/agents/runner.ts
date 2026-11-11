import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../core/config";
import { run } from "../core/shell";
import { redactString } from "../core/logger";

/**
 * The only interface the pipeline uses to talk to an agent (PLAN §7).
 * Implemented by spawning the local Claude Code CLI in headless mode
 * (`claude -p --output-format stream-json`) so the machine's subscription
 * login is used. Tests swap in a fake via `setAgentRunner`.
 */
export type AgentEvent =
  | { kind: "init"; sessionId: string; tools: string[]; model: string; apiKeySource?: string }
  | { kind: "tool_call"; tool: string; summary: string }
  | { kind: "tool_denied"; tool: string; summary: string }
  | { kind: "text"; text: string }
  | { kind: "rate_limit"; status: string; info: unknown }
  | { kind: "result"; costUsd: number; turns: number; isError: boolean };

export type RunAgentInput<T extends z.ZodType> = {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model: string;
  /** Path to an MCP config JSON file (used with --strict-mcp-config). */
  mcpConfigFile?: string;
  /** Built-in tools that exist in the session (--tools). MCP tools come from the config. */
  tools: string[];
  /** Permission allow rules; everything else is denied (permission mode dontAsk). */
  allowedTools: string[];
  disallowedTools: string[];
  outputSchema: T;
  maxBudgetUsd?: number;
  timeoutMs: number;
  resumeSessionId?: string;
  transcriptPath?: string;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

export type RunAgentResult<T> = {
  output: T;
  sessionId: string;
  costUsd: number;
  turns: number;
  permissionDenials: unknown[];
};

export type AgentErrorKind = "usage_limit" | "timeout" | "budget" | "invalid_output" | "process" | "cancelled";

export class AgentError extends Error {
  constructor(
    public kind: AgentErrorKind,
    message: string,
    public details: { sessionId?: string; costUsd?: number; turns?: number } = {},
  ) {
    super(message);
  }
}

export type AgentRunner = <T extends z.ZodType>(input: RunAgentInput<T>) => Promise<RunAgentResult<z.infer<T>>>;

let current: AgentRunner | undefined;
export function setAgentRunner(r: AgentRunner | undefined) {
  current = r;
}
export const runAgent: AgentRunner = (input) => (current ?? claudeCliRunner)(input);

/** JSON Schema for --json-schema, from a Zod schema. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Arguments for `claude -p`. Exported for tests. */
export function buildClaudeArgs(input: RunAgentInput<z.ZodType>): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // Never load the owner's user/project settings, hooks or MCP servers: sessions must be reproducible.
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({
      // Confine Bash where Claude Code supports it (PLAN §7.1.7). Verified per machine; see README.
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      cleanupPeriodDays: 365,
    }),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    input.tools.join(","),
    "--json-schema",
    JSON.stringify(toJsonSchema(input.outputSchema)),
    "--append-system-prompt",
    input.systemPrompt,
  ];
  if (input.mcpConfigFile) args.push("--mcp-config", input.mcpConfigFile);
  if (input.allowedTools.length) args.push("--allowedTools", ...input.allowedTools);
  if (input.disallowedTools.length) args.push("--disallowedTools", ...input.disallowedTools);
  if (input.maxBudgetUsd) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

/** Environment for the agent process: only its Claude credential (PLAN §7.1.5). */
function agentEnv(): Record<string, string | undefined> {
  const cfg = config();
  return {
    CLAUDE_CODE_OAUTH_TOKEN: cfg.CLAUDE_CODE_OAUTH_TOKEN,
    // Explicitly not ANTHROPIC_API_KEY: it would take precedence and bill the API.
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.query ?? input.issueId ?? input.url;
  const s = pick !== undefined ? String(pick) : JSON.stringify(input);
  return redactString(s.length > 300 ? s.slice(0, 300) + "…" : s);
}

const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|out of extra usage|hit your limit|quota/i;

export const claudeCliRunner: AgentRunner = async (input) => {
  const cfg = config();
  const args = buildClaudeArgs(input as RunAgentInput<z.ZodType>);
  let transcript: fs.WriteStream | undefined;
  if (input.transcriptPath) {
    fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
    transcript = fs.createWriteStream(input.transcriptPath, { flags: "a" });
  }

  let sessionId = input.resumeSessionId ?? "";
  let result: Record<string, unknown> | undefined;
  let rateLimited = false;
  const emit = (e: AgentEvent) => {
    try {
      input.onEvent?.(e);
    } catch {
      /* observers must not break the run */
    }
  };

  const onLine = (line: string, stream: "stdout" | "stderr") => {
    if (stream === "stderr") {
      if (line.trim()) transcript?.write(JSON.stringify({ type: "stderr", line: redactString(line) }) + "\n");
      return;
    }
    if (!line.trim()) return;
    transcript?.write(redactString(line) + "\n");
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m.session_id === "string") sessionId = m.session_id;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          emit({ kind: "init", sessionId, tools: (m.tools as string[]) ?? [], model: String(m.model), apiKeySource: m.apiKeySource as string });
        } else if (m.subtype === "permission_denied") {
          emit({ kind: "tool_denied", tool: String(m.tool_name), summary: String(m.message ?? "") });
        }
        break;
      case "assistant": {
        const content = ((m.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
        for (const c of content) {
          if (c.type === "tool_use" && c.name !== "StructuredOutput") {
            emit({ kind: "tool_call", tool: String(c.name), summary: summarizeToolInput(String(c.name), c.input as Record<string, unknown>) });
          } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            emit({ kind: "text", text: redactString(c.text.slice(0, 1000)) });
          }
        }
        break;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info as { status?: string } | undefined;
        if (info?.status && info.status !== "allowed" && info.status !== "allowed_warning") rateLimited = true;
        emit({ kind: "rate_limit", status: String(info?.status), info });
        break;
      }
      case "result":
        result = m;
        emit({ kind: "result", costUsd: Number(m.total_cost_usd ?? 0), turns: Number(m.num_turns ?? 0), isError: !!m.is_error });
        break;
    }
  };

  const r = await run(cfg.CLAUDE_BIN, args, {
    cwd: input.cwd,
    env: agentEnv(),
    input: input.prompt,
    timeoutMs: input.timeoutMs,
    onLine,
    signal: input.signal,
    maxBuffer: 256 * 1024,
  });
  transcript?.end();

  const costUsd = Number(result?.total_cost_usd ?? 0);
  const turns = Number(result?.num_turns ?? 0);
  const details = { sessionId, costUsd, turns };

  if (r.aborted) throw new AgentError("cancelled", "Agent session cancelled.", details);
  if (r.timedOut) throw new AgentError("timeout", `Agent session timed out after ${Math.round(input.timeoutMs / 60000)} minutes.`, details);

  const resultText = String(result?.result ?? "");
  const errorText = `${resultText}\n${(result?.errors as unknown[] | undefined)?.join("\n") ?? ""}\n${r.stderr.slice(-2000)}`;
  if (!result || result.is_error || result.subtype !== "success") {
    if (rateLimited || result?.api_error_status === 429 || USAGE_LIMIT_RE.test(errorText)) {
      throw new AgentError("usage_limit", `Claude usage limit reached: ${redactString(errorText.trim().slice(0, 300))}`, details);
    }
    if (result?.subtype === "error_max_budget_usd") {
      throw new AgentError("budget", `Agent session hit the ${input.maxBudgetUsd} USD budget.`, details);
    }
    const why = result ? `${String(result.subtype)}: ${resultText.slice(0, 500)}` : `exit ${r.exitCode}: ${r.stderr.trim().slice(-800)}`;
    throw new AgentError("process", `Agent session failed (${redactString(why)})`, details);
  }

  const raw = result.structured_output ?? tryParseJson(resultText);
  const parsed = input.outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(
      "invalid_output",
      `Agent output did not match the schema: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      details,
    );
  }
  return { output: parsed.data, sessionId, costUsd, turns, permissionDenials: (result.permission_denials as unknown[]) ?? [] };
};

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
