import { Suspense } from "react";
import { getProjects, getSentryConnections } from "../lib/data";
import { AutoRefresh } from "../components/auto-refresh";
import { Badge, Empty, L, Section, Table } from "../components/ui";
import { AddProjectForm } from "./add-form";

export default function Page() {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Projects</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <ProjectList />
      </Suspense>
      <Section title="Add a project">
        <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
          <AddProject />
        </Suspense>
      </Section>
    </div>
  );
}

async function AddProject() {
  return <AddProjectForm connections={await getSentryConnections()} />;
}

async function ProjectList() {
  const ps = await getProjects();
  const live = ps.some((p) => p.cloneStatus === "pending" || p.cloneStatus === "cloning");
  return (
    <Section title="Registered">
      <AutoRefresh enabled={live} />
      {ps.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Repository</th>
              <th>Sentry</th>
              <th>Clone</th>
              <th>Preset</th>
              <th>Config test</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {ps.map((p) => (
              <tr key={p.id}>
                <td>
                  <L href={`/projects/${p.id}`}>{p.name}</L>
                </td>
                <td className="font-mono text-xs">
                  {p.repoSlug}
                  {p.defaultBranch ? `@${p.defaultBranch}` : ""}
                </td>
                <td className="font-mono text-xs">
                  {p.sentryConnection !== "default" && <span className="text-zinc-500">{p.sentryConnection}: </span>}
                  {p.sentryOrg}/{p.sentryProject}
                </td>
                <td>
                  <Badge status={p.cloneStatus} title={p.cloneError ?? undefined} />
                </td>
                <td>{p.preset ?? "—"}</td>
                <td>{p.configTestOk === null ? "—" : p.configTestOk ? "✅ passed" : "❌ failed"}</td>
                <td>{p.enabled ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
