import fs from "node:fs";
import path from "node:path";
import { run } from "../core/shell";

export type PresetName = "xcode" | "node" | "generic";

export type PresetDetection = {
  preset: PresetName;
  setupCmd: string | null;
  buildCmd: string | null;
  testCmd: string | null;
  versionCmd: string | null;
  info: Record<string, unknown>;
};

/** Quote a value for /bin/sh. Used only for values the harness detected locally. */
export function shq(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function detectPreset(repoDir: string, opts: { derivedDataPath?: string } = {}): Promise<PresetDetection> {
  const entries = fs.readdirSync(repoDir);
  const workspace = entries.find((e) => e.endsWith(".xcworkspace"));
  const project = entries.find((e) => e.endsWith(".xcodeproj"));
  if (workspace || project) return detectXcode(repoDir, { workspace, project, derivedDataPath: opts.derivedDataPath });
  if (entries.includes("package.json")) return detectNode(repoDir);
  return { preset: "generic", setupCmd: null, buildCmd: null, testCmd: null, versionCmd: null, info: {} };
}

type XcodeList = {
  project?: { name: string; schemes: string[]; targets: string[] };
  workspace?: { name: string; schemes: string[] };
};

export async function listSimulators(): Promise<Array<{ name: string; runtime: string; udid: string }>> {
  const r = await run("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeoutMs: 60_000 });
  if (!r.ok) return [];
  const data = JSON.parse(r.stdout) as { devices: Record<string, Array<{ name: string; udid: string; isAvailable: boolean }>> };
  const out: Array<{ name: string; runtime: string; udid: string }> = [];
  for (const [runtime, devices] of Object.entries(data.devices)) {
    if (!runtime.includes("iOS")) continue;
    for (const d of devices) out.push({ name: d.name, runtime: runtime.split(".").pop() ?? runtime, udid: d.udid });
  }
  return out;
}

/** Prefer an iPhone Pro on the newest runtime. */
export function pickSimulator(sims: Array<{ name: string; runtime: string }>): string | null {
  const iphones = sims.filter((s) => s.name.startsWith("iPhone"));
  if (!iphones.length) return null;
  const byRuntime = [...iphones].sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }));
  const newest = byRuntime[0].runtime;
  const candidates = byRuntime.filter((s) => s.runtime === newest);
  return (candidates.find((s) => / Pro$/.test(s.name)) ?? candidates[0]).name;
}

async function detectXcode(
  repoDir: string,
  o: { workspace?: string; project?: string; derivedDataPath?: string },
): Promise<PresetDetection> {
  const container = o.workspace ? ["-workspace", o.workspace] : ["-project", o.project!];
  const listed = await run("xcodebuild", ["-list", "-json", ...container], { cwd: repoDir, timeoutMs: 5 * 60_000 });
  let schemes: string[] = [];
  let targets: string[] = [];
  if (listed.ok) {
    const json = JSON.parse(listed.stdout.slice(listed.stdout.indexOf("{"))) as XcodeList;
    schemes = json.project?.schemes ?? json.workspace?.schemes ?? [];
    targets = json.project?.targets ?? [];
  }
  const baseName = (o.workspace ?? o.project)!.replace(/\.(xcworkspace|xcodeproj)$/, "");
  // Shared schemes of the repo itself come first; SPM package schemes are noise.
  const scheme = schemes.find((s) => s === baseName) ?? schemes.find((s) => targets.includes(s)) ?? schemes[0] ?? null;

  const testPlansDir = ["TestPlans", "."].map((d) => path.join(repoDir, d)).find((d) => fs.existsSync(d));
  const testPlans = testPlansDir
    ? fs.readdirSync(testPlansDir).filter((f) => f.endsWith(".xctestplan")).map((f) => f.replace(/\.xctestplan$/, ""))
    : [];
  const testPlan = testPlans.find((p) => /^unit/i.test(p)) ?? (testPlans.length ? null : null);

  const sims = await listSimulators();
  const simulator = pickSimulator(sims);
  const dest = simulator ? `platform=iOS Simulator,name=${simulator}` : "generic/platform=iOS Simulator";
  const dd = o.derivedDataPath ? ["-derivedDataPath", o.derivedDataPath] : [];

  const common = [...container, ...(scheme ? ["-scheme", scheme] : []), "-destination", dest, ...dd];
  const buildCmd = scheme
    ? ["xcodebuild", "build", ...common, "CODE_SIGNING_ALLOWED=NO", "-quiet"].map(shq).join(" ")
    : null;
  const testCmd = scheme
    ? ["xcodebuild", "test", ...common, ...(testPlan ? ["-testPlan", testPlan] : []), "-parallel-testing-enabled", "NO", "-retry-tests-on-failure", "-test-iterations", "3", "CODE_SIGNING_ALLOWED=NO", "-quiet"]
        .map(shq)
        .join(" ")
    : null;

  const pbxproj = o.project ? path.join(o.project, "project.pbxproj") : null;
  // Highest MARKETING_VERSION in the project file: app targets carry the real
  // version, extensions and test targets usually sit at 1.0.
  const versionCmd = pbxproj
    ? `sed -n 's/^[[:space:]]*MARKETING_VERSION = "\\{0,1\\}\\([^";]*\\)"\\{0,1\\};/\\1/p' ${shq(pbxproj)} | sort -t. -k1,1n -k2,2n -k3,3n | tail -1`
    : null;

  return {
    preset: "xcode",
    setupCmd: null,
    buildCmd,
    testCmd,
    versionCmd,
    info: {
      container: o.workspace ?? o.project,
      schemes,
      targets,
      scheme,
      testPlans,
      testPlan,
      simulator,
      simulators: [...new Set(sims.map((s) => `${s.name} (${s.runtime})`))].slice(0, 20),
      listError: listed.ok ? null : (listed.stderr || listed.stdout).trim().split("\n").slice(-5).join("\n"),
    },
  };
}

function detectNode(repoDir: string): PresetDetection {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    version?: string;
  };
  const scripts = pkg.scripts ?? {};
  const lock = fs.existsSync(path.join(repoDir, "package-lock.json"));
  return {
    preset: "node",
    setupCmd: lock ? "npm ci" : "npm install",
    buildCmd: scripts.build ? "npm run build" : null,
    testCmd: scripts.test ? "npm test" : null,
    versionCmd: `node -p "require('./package.json').version"`,
    info: { scripts: Object.keys(scripts), version: pkg.version ?? null },
  };
}
