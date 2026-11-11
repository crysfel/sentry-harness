import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";
import { loadConfig, resetConfig } from "../src/core/config";

// Every test file gets its own data dir; nothing touches data/ or real secrets.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentry-harness-test-"));
process.env.HARNESS_DATA_DIR = dir;
process.env.LOG_LEVEL = "error";
delete process.env.HARNESS_GITHUB_TOKEN;
delete process.env.SENTRY_AUTH_TOKEN;

beforeEach(() => {
  resetConfig(loadConfig({ ...process.env, HARNESS_DATA_DIR: dir, NODE_ENV: "test", LOG_LEVEL: "error" }));
});
