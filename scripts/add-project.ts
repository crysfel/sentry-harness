/**
 * CLI equivalent of the dashboard's "Add project" form:
 *   npm run project:add -- owner/name <sentry-org> <sentry-project> [query filter]
 */
import { eq } from "drizzle-orm";
import { ensureDataDirs } from "../src/core/config";
import { db, runMigrations } from "../src/db/client";
import { projects } from "../src/db/schema";
import { enqueueJob } from "../src/db/queries/jobs";
import { parseRepoSlug } from "../src/github/git";

const [repo, org, proj, ...filter] = process.argv.slice(2);
const slug = repo && parseRepoSlug(repo);
if (!slug || !org || !proj) {
  console.error("usage: npm run project:add -- owner/name <sentry-org> <sentry-project> [query filter]");
  process.exit(1);
}
ensureDataDirs();
const d = db();
runMigrations(d);
let p = d.select().from(projects).where(eq(projects.repoSlug, slug)).get();
if (!p) {
  p = d
    .insert(projects)
    .values({ name: slug.split("/")[1], repoSlug: slug, repoUrl: `https://github.com/${slug}.git`, sentryOrg: org, sentryProject: proj, sentryQueryFilter: filter.join(" ") || null })
    .returning()
    .get();
}
const job = enqueueJob("clone_project", { projectId: p.id }, d);
console.log(`project #${p.id} ${slug}: queued clone job #${job.id}; start the worker to run it`);
