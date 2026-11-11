import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getJobEvents, getProject, getProjectJobs, nextScheduledRun } from "../../lib/data";
import { recloneProject, testConfiguration } from "../../actions";
import { AutoRefresh } from "../../components/auto-refresh";
import { ActionButton, Badge, Empty, L, Section, Time, duration } from "../../components/ui";
import { SettingsForm } from "./settings-form";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <ProjectView params={params} />
    </Suspense>
  );
}

async function ProjectView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getProject(Number(id));
  if (!p) notFound();
  const jobs = await getProjectJobs(p.id);
  const lastJob = jobs[0];
  const lastJobEvents = lastJob ? await getJobEvents(lastJob.id) : [];
  const live = p.cloneStatus === "pending" || p.cloneStatus === "cloning" || jobs.some((j) => j.status === "queued" || j.status === "running");
  const info = (p.presetInfo ?? {}) as Record<string, unknown>;
  const next = nextScheduledRun(p.scheduleCron, p.enabled);
  const testJob = jobs.find((j) => j.kind === "test_config");

  return (
    <div>
      <AutoRefresh enabled={live} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{p.name}</h1>
        <Badge status={p.cloneStatus} />
        <span className="font-mono text-xs text-zinc-500">
          {p.repoSlug}
          {p.defaultBranch ? `@${p.defaultBranch}` : ""} · {p.sentryOrg}/{p.sentryProject}
        </span>
        <span className="text-sm text-zinc-500">{p.enabled ? <>Next run <Time iso={next?.toISOString()} /></> : "Scheduled runs disabled"}</span>
        <div className="ml-auto flex gap-2">
          <L href={`/issues?project=${p.id}`}>Issues</L>
          <ActionButton action={recloneProject} fields={{ projectId: p.id }}>
            Re-clone
          </ActionButton>
          {p.cloneStatus === "ready" && (
            <ActionButton action={testConfiguration} fields={{ projectId: p.id }} variant="primary">
              Test configuration
            </ActionButton>
          )}
        </div>
      </div>

      {p.cloneError && <pre className="mb-4 whitespace-pre-wrap rounded bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{p.cloneError}</pre>}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Section title="Detected">
          {p.preset ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-500">Preset</dt>
              <dd>{p.preset}</dd>
              {Object.entries(info)
                .filter(([k, v]) => v !== null && k !== "simulators")
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="font-mono text-xs">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                  </div>
                ))}
            </dl>
          ) : (
            <Empty>{p.cloneStatus === "error" ? "Clone failed." : "Waiting for the clone to finish."}</Empty>
          )}
        </Section>
        <Section title="Configuration test">
          <p className="mb-2 text-sm">
            {p.configTestOk === null ? "Not run since the commands last changed." : p.configTestOk ? "✅ Passed" : "❌ Failed"}
            {p.configTestedAt && (
              <>
                {" "}
                · <Time iso={p.configTestedAt} />
              </>
            )}
            {testJob && (
              <>
                {" "}
                · last job <Badge status={testJob.status} /> {duration(testJob.startedAt, testJob.finishedAt)}
              </>
            )}
          </p>
          <p className="text-xs text-zinc-500">Runs setup, build and test on a clean worktree of the default branch. The project cannot be enabled until this passes once.</p>
        </Section>
      </div>

      {lastJob && (
        <Section title={`Last job: ${lastJob.kind} #${lastJob.id}`}>
          <div className="mb-1 flex items-center gap-2 text-sm">
            <Badge status={lastJob.status} /> <Time iso={lastJob.startedAt ?? lastJob.createdAt} /> {lastJob.error && <span className="text-red-700 dark:text-red-400">{lastJob.error.split("\n")[0].slice(0, 200)}</span>}
          </div>
          <div className="max-h-64 overflow-y-auto rounded border border-zinc-200 font-mono text-xs dark:border-zinc-800">
            {lastJobEvents.map((e) => (
              <div key={e.id} className={`flex gap-3 border-b border-zinc-100 px-2 py-1 dark:border-zinc-900 ${e.level === "error" ? "text-red-700 dark:text-red-400" : ""}`}>
                <span className="shrink-0 text-zinc-400">{e.ts.slice(11, 19)}</span>
                <span className="whitespace-pre-wrap break-words">{e.message}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Settings">
        <SettingsForm project={p} />
      </Section>
    </div>
  );
}
