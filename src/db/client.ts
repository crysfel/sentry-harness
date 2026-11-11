import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { config, projectRoot } from "../core/config";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Open a connection with WAL and a busy timeout: two processes write (PLAN §5). */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema }) as Db;
}

export function migrationsFolder() {
  return path.join(projectRoot(), "drizzle");
}

export function runMigrations(db: Db) {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

const g = globalThis as unknown as { __harnessDb?: Db };

/** Process-wide connection (survives Next.js dev hot reloads). */
export function db(): Db {
  g.__harnessDb ??= openDb(config().dbPath);
  return g.__harnessDb;
}

/** For tests: swap the process-wide connection. */
export function setDb(d: Db | undefined) {
  g.__harnessDb = d;
}

export { schema };
