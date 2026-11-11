import { config, ensureDataDirs } from "../src/core/config";
import { db, runMigrations } from "../src/db/client";

ensureDataDirs();
runMigrations(db());
console.log(`Database ready at ${config().dbPath}`);
