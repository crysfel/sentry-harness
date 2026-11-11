import { describe, expect, it } from "vitest";
import { run, runShellString, baseEnv } from "../src/core/shell";

describe("shell wrapper", () => {
  it("does not pass harness secrets to child processes (PLAN §7.1.5)", async () => {
    process.env.GH_TOKEN = "ghp_should_not_leak_0123456789abcdef";
    process.env.HARNESS_GITHUB_TOKEN = "github_pat_should_not_leak_0123456789";
    process.env.SENTRY_AUTH_TOKEN = "sntryu_should_not_leak_0123456789abcdef";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-should-not-leak";
    try {
      const r = await run("/usr/bin/env", []);
      expect(r.ok).toBe(true);
      expect(r.stdout).not.toMatch(/GH_TOKEN|HARNESS_GITHUB_TOKEN|SENTRY_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|should_not_leak/);
      expect(r.stdout).toMatch(/^PATH=/m);

      const s = await runShellString('echo "token=[$GH_TOKEN]"');
      expect(s.stdout.trim()).toBe("token=[]");
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.HARNESS_GITHUB_TOKEN;
      delete process.env.SENTRY_AUTH_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("passes only explicitly given extras", async () => {
    const r = await run("/bin/sh", ["-c", "echo $FOO"], { env: { FOO: "bar" } });
    expect(r.stdout.trim()).toBe("bar");
    expect(Object.keys(baseEnv())).not.toContain("GH_TOKEN");
  });

  it("never interpolates arguments into a shell line", async () => {
    const r = await run("/bin/echo", ["$(touch /tmp/pwned)", "; rm -rf /"]);
    expect(r.stdout.trim()).toBe("$(touch /tmp/pwned) ; rm -rf /");
  });

  it("enforces timeouts and kills the process", async () => {
    const r = await run("/bin/sleep", ["5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.durationMs).toBeLessThan(3000);
  });

  it("reports exit codes and captures output", async () => {
    const r = await runShellString("echo out; echo err >&2; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  it("can be cancelled with an AbortSignal", async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 100);
    const r = await run("/bin/sleep", ["5"], { signal: c.signal });
    expect(r.aborted).toBe(true);
  });
});
