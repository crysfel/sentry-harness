import fs from "node:fs";
import { runShellString, tail } from "../core/shell";
import { gitOk } from "../github/git";
import { diffStats } from "../projects/worktree";

/**
 * Deterministic verification (PLAN §6.6): the harness, not the agent, runs the
 * build and tests, then sanity-checks the diff.
 */
export type VerifyResult =
  | { ok: true; buildOk: true; testsOk: true; files: string[]; lines: number; testCount: number | null }
  | { ok: false; step: "build" | "test" | "checks"; buildOk: boolean; testsOk: boolean | null; reason: string; outputTail: string; files: string[]; lines: number };

export type DiffPolicy = { maxLines: number; allowSensitive?: boolean };

/** Paths a fix must not touch unless the project allows it. */
const SENSITIVE: Array<[RegExp, string]> = [
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Package\.resolved|Cartfile\.resolved|Gemfile\.lock|Cargo\.lock|go\.sum)$/, "lockfile"],
  [/(^|\/)(\.github|ci_scripts|\.circleci|fastlane|\.buildkite)\//, "CI scripts"],
  [/(^|\/)(\.gitlab-ci\.yml|bitrise\.yml|Jenkinsfile|codemagic\.yaml)$/, "CI config"],
  [/\.(entitlements|mobileprovision|p12|pem|key|cer)$/, "signing or secrets"],
  [/(^|\/)(\.env[^/]*|sentry\.properties|GoogleService-Info\.plist|secrets?\.[a-z]+)$/i, "secrets"],
  [/\.xcconfig$/, "build configuration"],
];

export function checkDiff(files: string[], lines: number, policy: DiffPolicy): string | null {
  if (files.length === 0 || lines === 0) return "The change is empty.";
  if (lines > policy.maxLines) return `The change is ${lines} lines, over the ${policy.maxLines}-line limit.`;
  if (!policy.allowSensitive) {
    for (const f of files) {
      for (const [re, what] of SENSITIVE) if (re.test(f)) return `The change touches ${f} (${what}), which fixes may not modify.`;
    }
  }
  return null;
}

const PBX_SENSITIVE = /^[+-]\s*(CODE_SIGN[A-Z_]*|DEVELOPMENT_TEAM|PROVISIONING_PROFILE[A-Z_]*|MARKETING_VERSION|CURRENT_PROJECT_VERSION|PRODUCT_BUNDLE_IDENTIFIER|ENABLE_HARDENED_RUNTIME|OTHER_CODE_SIGN_FLAGS)\b/m;

/** Xcode project edits that add files are fine; signing and version settings are not. */
export function sensitivePbxprojChange(diff: string): string | null {
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const m = line.match(PBX_SENSITIVE);
    if (m) return m[1];
  }
  return null;
}

/** Best-effort test count from xcodebuild / common runners. */
export function parseTestCount(output: string): number | null {
  const xc = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].pop();
  if (xc) return Number(xc[1]);
  const st = [...output.matchAll(/Test run with (\d+) tests? (?:in \d+ suites? )?passed/g)].pop();
  if (st) return Number(st[1]);
  const v = [...output.matchAll(/Tests\s+(\d+) passed/g)].pop();
  if (v) return Number(v[1]);
  return null;
}

export async function verifyWorktree(
  cwd: string,
  o: { baseSha: string; buildCmd: string | null; testCmd: string | null; logFile: string; diff: DiffPolicy; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerifyResult> {
  const { lines, files } = await diffStats(cwd, o.baseSha);
  const problem = checkDiff(files, lines, o.diff);
  if (problem) return { ok: false, step: "checks", buildOk: false, testsOk: null, reason: problem, outputTail: problem, files, lines };

  if (!o.diff.allowSensitive) {
    for (const f of files.filter((f) => f.endsWith(".pbxproj"))) {
      const d = await gitOk(["diff", o.baseSha, "--", f], { cwd });
      const bad = sensitivePbxprojChange(d);
      if (bad) {
        const reason = `The change edits ${bad} in ${f}; fixes may not change signing or version settings.`;
        return { ok: false, step: "checks", buildOk: false, testsOk: null, reason, outputTail: reason, files, lines };
      }
    }
  }

  const timeoutMs = o.timeoutMs ?? 60 * 60_000;
  if (o.buildCmd) {
    fs.appendFileSync(o.logFile, `\n===== build: ${o.buildCmd}\n`);
    const b = await runShellString(o.buildCmd, { cwd, timeoutMs, logFile: o.logFile, signal: o.signal });
    if (!b.ok) {
      return { ok: false, step: "build", buildOk: false, testsOk: null, reason: b.timedOut ? "build timed out" : `build exited ${b.exitCode}`, outputTail: tail(b.stdout + "\n" + b.stderr, 120), files, lines };
    }
  }
  let testCount: number | null = null;
  if (o.testCmd) {
    fs.appendFileSync(o.logFile, `\n===== test: ${o.testCmd}\n`);
    const t = await runShellString(o.testCmd, { cwd, timeoutMs, logFile: o.logFile, signal: o.signal });
    testCount = parseTestCount(t.stdout + "\n" + t.stderr);
    if (!t.ok) {
      return { ok: false, step: "test", buildOk: true, testsOk: false, reason: t.timedOut ? "tests timed out" : `tests exited ${t.exitCode}`, outputTail: tail(t.stdout + "\n" + t.stderr, 120), files, lines };
    }
  }
  // Build tools may leave files behind; the diff we publish is re-checked at commit time.
  await gitOk(["status", "--porcelain"], { cwd });
  return { ok: true, buildOk: true, testsOk: true, files, lines, testCount };
}
