import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/**
 * The one way the harness starts a process (PLAN §6 "Failure handling", §7.1.5).
 *
 * - Arguments are always an array; nothing is interpolated into a shell line.
 *   (`runShellString` exists only for owner-written project commands.)
 * - The child gets an explicit, minimal environment. Nothing from the
 *   harness's own environment (tokens, .env) leaks unless passed in `env`.
 * - Every command has a timeout; output is captured (tail-limited) and can be
 *   streamed to a log file.
 */

/** Variables copied from the parent environment into every child. Nothing secret. */
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM", "DEVELOPER_DIR"];

export function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.PATH ??= "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.HOME ??= os.homedir();
  env.LANG ??= "en_US.UTF-8";
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export type RunOptions = {
  cwd?: string;
  /** Extra variables on top of the scrubbed base environment. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Text written to stdin, then stdin is closed. */
  input?: string;
  /** Append combined output here. */
  logFile?: string;
  /** Called with each complete output line. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  /** Max bytes of stdout / stderr kept in memory (tail). Default 2 MB each. */
  maxBuffer?: number;
};

export type RunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  ok: boolean;
};

export class CommandError extends Error {
  constructor(public result: RunResult) {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-15).join("\n");
    super(
      `${result.command} ${result.args.join(" ")} ${
        result.timedOut ? "timed out" : result.aborted ? "was cancelled" : `exited with ${result.exitCode}`
      }${tail ? `:\n${tail}` : ""}`,
    );
  }
}

const DEFAULT_TIMEOUT = 10 * 60_000;

export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const max = opts.maxBuffer ?? 2 * 1024 * 1024;
  const logStream = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: "a" }) : undefined;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: baseEnv(opts.env) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // own process group so a timeout kills the whole tree
      });
    } catch (err) {
      logStream?.end();
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const partial = { stdout: "", stderr: "" };

    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5000).unref();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    const onAbort = () => {
      aborted = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const handle = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      logStream?.write(s);
      if (stream === "stdout") {
        stdout += s;
        if (stdout.length > max) stdout = stdout.slice(-max);
      } else {
        stderr += s;
        if (stderr.length > max) stderr = stderr.slice(-max);
      }
      if (opts.onLine) {
        const lines = (partial[stream] + s).split("\n");
        partial[stream] = lines.pop() ?? "";
        for (const l of lines) opts.onLine(l, stream);
      }
    };
    child.stdout.on("data", handle("stdout"));
    child.stderr.on("data", handle("stderr"));
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    child.on("error", (err) => {
      clearTimeout(timer);
      logStream?.end();
      reject(err);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onLine) {
        if (partial.stdout) opts.onLine(partial.stdout, "stdout");
        if (partial.stderr) opts.onLine(partial.stderr, "stderr");
      }
      logStream?.end();
      resolve({
        command,
        args,
        exitCode: code,
        signal: sig,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        ok: code === 0 && !timedOut && !aborted,
      });
    });
  });
}

/** Like `run` but throws CommandError on failure. */
export async function runOk(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(command, args, opts);
  if (!r.ok) throw new CommandError(r);
  return r;
}

/**
 * Run an owner-configured command line (build_cmd, test_cmd, …) through /bin/sh.
 * Only for strings the owner typed into project settings; never for anything
 * derived from Sentry, GitHub or agent output.
 */
export function runShellString(cmdline: string, opts: RunOptions = {}): Promise<RunResult> {
  return run("/bin/sh", ["-c", cmdline], opts);
}

export function tail(text: string, lines = 80): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
