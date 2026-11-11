/**
 * CLI equivalent of the dashboard's "Add project" form:
 *   npm run project:add -- owner/name <sentry-org> <sentry-project> [--sentry=<connection>] [query filter]
 * <connection> names a Sentry login in .env: SENTRY_AUTH_TOKEN_<NAME> (default: SENTRY_AUTH_TOKEN).
 */
import { eq } from "drizzle-orm";
import { config, DEFAULT_SENTRY_CONNECTION, ensureDataDirs, sentryTokenVar } from "../src/core/config";
import { db, runMigrations } from "../src/db/client";
import { projects } from "../src/db/schema";
import { enqueueJob } from "../src/db/queries/jobs";
import { parseRepoSlug } from "../src/github/git";

const argv = process.argv.slice(2);
const flag = argv.find((a) => a.startsWith("--sentry="));
const connection = flag ? flag.slice("--sentry=".length).toLowerCase() : DEFAULT_SENTRY_CONNECTION;
const [repo, org, proj, ...filter] = argv.filter((a) => a !== flag);
const slug = repo && parseRepoSlug(repo);
if (!slug || !org || !proj) {
  console.error("usage: npm run project:add -- owner/name <sentry-org> <sentry-project> [--sentry=<connection>] [query filter]");
  process.exit(1);
}
if (!config().sentryConnections.some((c) => c.name === connection)) {
  console.error(`unknown Sentry connection "${connection}": add ${sentryTokenVar(connection)} to .env first`);
  process.exit(1);
}
ensureDataDirs();
const d = db();
runMigrations(d);
let p = d.select().from(projects).where(eq(projects.repoSlug, slug)).get();
if (!p) {
  p = d
    .insert(projects)
    .values({
      name: slug.split("/")[1],
      repoSlug: slug,
      repoUrl: `https://github.com/${slug}.git`,
      sentryConnection: connection,
      sentryOrg: org,
      sentryProject: proj,
      sentryQueryFilter: filter.join(" ") || null,
    })
    .returning()
    .get();
}
const job = enqueueJob("clone_project", { projectId: p.id }, d);
console.log(`project #${p.id} ${slug} (Sentry: ${connection}): queued clone job #${job.id}; start the worker to run it`);
