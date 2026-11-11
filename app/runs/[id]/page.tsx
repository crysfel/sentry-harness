import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getRun } from "../../lib/data";
import { cancelRun } from "../../actions";
import { AutoRefresh } from "../../components/auto-refresh";
import { ActionButton, Badge, Empty, ExtLink, L, Section, Table, Time, duration, usd } from "../../components/ui";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <Run params={params} />
    </Suspense>
  );
}

const LEVEL = { debug: "text-zinc-400", info: "", warn: "text-amber-700 dark:text-amber-400", error: "text-red-700 dark:text-red-400" } as const;

async function Run({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getRun(Number(id));
  if (!data) notFound();
  const { run, project, events, attempts } = data;
  const live = run.status === "queued" || run.status === "running";
  return (
    <div>
      <AutoRefresh enabled={live} ms={3000} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">
          Run #{run.id} · <L href={`/projects/${project.id}`}>{project.name}</L>
        </h1>
        <Badge status={run.status} />
        <span className="text-sm text-zinc-500">
          {run.trigger}
          {run.dryRun ? " · dry run" : ""}
          {run.requestedIssueId ? (
            <>
              {" · fix now for "}
              <L href={`/issues/${run.requestedIssueId}`}>issue {run.requestedIssueId}</L>
            </>
          ) : null}
        </span>
        <span className="text-sm text-zinc-500">
          <Time iso={run.startedAt ?? run.createdAt} /> · {duration(run.startedAt, run.finishedAt)} · {usd(run.costUsd)}
        </span>
        {live && (
          <div className="ml-auto">
            {run.cancelRequested ? (
              <span className="text-sm text-amber-700">Cancelling…</span>
            ) : (
              <ActionButton action={cancelRun} fields={{ runId: run.id }} variant="danger">
                Cancel
              </ActionButton>
            )}
          </div>
        )}
      </div>
      {run.summary && <p className="mb-4 rounded bg-zinc-50 p-3 text-sm dark:bg-zinc-900">{run.summary}</p>}
      {run.error && <pre className="mb-4 overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">{run.error}</pre>}

      {attempts.length > 0 && (
        <Section title="Attempts">
          <Table>
            <thead>
              <tr>
                <th>Issue</th>
                <th>Attempt</th>
                <th>Status</th>
                <th>PR</th>
                <th>Summary</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map(({ attempt: a, shortId }) => (
                <tr key={a.id}>
                  <td>
                    <L href={`/issues/${a.issueId}`}>{shortId}</L>
                  </td>
                  <td>#{a.number}</td>
                  <td>
                    <Badge status={a.status} />
                  </td>
                  <td>{a.prUrl ? <ExtLink href={a.prUrl}>#{a.prNumber}</ExtLink> : "—"}</td>
                  <td className="max-w-xl">{a.fixSummary ?? a.error ?? "—"}</td>
                  <td className="text-right tabular-nums">{usd(a.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      )}

      <Section title="Selection">
        {run.selection?.length ? (
          <Table>
            <thead>
              <tr>
                <th>Issue</th>
                <th>Picked</th>
                <th className="text-right">Score</th>
                <th>Group</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {run.selection.map((s) => (
                <tr key={s.issueId}>
                  <td>
                    <L href={`/issues/${s.issueId}`}>{s.shortId}</L>
                  </td>
                  <td>{s.selected ? "✅" : "—"}</td>
                  <td className="text-right tabular-nums">{s.score}</td>
                  <td>{s.groupId ? `#${s.groupId}` : ""}</td>
                  <td>{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty>{live ? "Selection happens after triage." : "No candidates were considered in this run."}</Empty>
        )}
      </Section>

      <Section title={`Event log (${events.length})`}>
        {events.length === 0 ? (
          <Empty>{run.status === "queued" ? "Waiting for the worker to pick this run up." : "No events."}</Empty>
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-200 font-mono text-xs dark:border-zinc-800">
            {events.map((e) => (
              <div key={e.id} className={`flex gap-3 border-b border-zinc-100 px-2 py-1 dark:border-zinc-900 ${LEVEL[e.level]}`}>
                <span className="shrink-0 text-zinc-400">{e.ts.slice(11, 19)}</span>
                <span className="w-24 shrink-0 text-zinc-500">{e.stage}</span>
                <span className="whitespace-pre-wrap break-words">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
