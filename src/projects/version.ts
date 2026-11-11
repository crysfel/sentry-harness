import { runShellString } from "../core/shell";

/** Run the project's version_cmd in a checkout; returns the first non-empty line. */
export async function readVersion(cwd: string, versionCmd: string | null): Promise<string | null> {
  if (!versionCmd) return null;
  const r = await runShellString(versionCmd, { cwd, timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

export type SemVer = [number, number, number];

/**
 * Parse a Sentry release or a bare version. Release names look like
 * `com.bleext.hymnal@6.3.2+21`: compare the part between `@` and `+` (PLAN §6.3).
 */
export function parseVersion(input: string | null | undefined): SemVer | null {
  if (!input) return null;
  let s = input.trim();
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  s = s.split("+")[0].split("-")[0].replace(/^v/i, "");
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  const pa = typeof a === "string" ? parseVersion(a) : a;
  const pb = typeof b === "string" ? parseVersion(b) : b;
  if (!pa || !pb) throw new Error(`Cannot compare versions ${String(a)} and ${String(b)}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function versionGte(release: string, min: string): boolean {
  const pa = parseVersion(release);
  const pb = parseVersion(min);
  if (!pa || !pb) return false;
  return compareVersions(pa, pb) >= 0;
}

export function formatVersion(v: string | null | undefined) {
  const p = parseVersion(v);
  return p ? p.join(".") : (v ?? null);
}
