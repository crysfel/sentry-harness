import { Suspense } from "react";
import { getRuns } from "../lib/data";
import { AutoRefresh } from "../components/auto-refresh";
import { Badge, Empty, L, Table, Time, duration, usd } from "../components/ui";

export default function Page() {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Runs</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <Runs />
      </Suspense>
    </div>
  );
}

async function Runs() {
  const rows = await getRuns();
  if (!rows.length) return <Empty>No runs yet.</Empty>;
  const live = rows.some((r) => r.run.status === "queued" || r.run.status === "running");
  return (
    <>
      <AutoRefresh enabled={live} />
      <Table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Project</th>
            <th>Started</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Summary</th>
            <th className="text-right">Cost</th>
            <th className="text-right">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run: r, projectName }) => (
            <tr key={r.id}>
              <td>
                <L href={`/runs/${r.id}`}>#{r.id}</L>
              </td>
              <td>{projectName}</td>
              <td className="text-xs">
                <Time iso={r.startedAt ?? r.createdAt} />
              </td>
              <td className="text-xs">
                {r.trigger}
                {r.dryRun ? " · dry" : ""}
                {r.requestedIssueId ? " · fix now" : ""}
              </td>
              <td>
                <Badge status={r.status} />
              </td>
              <td className="max-w-xl">{r.summary ?? (r.status === "running" ? "In progress…" : "—")}</td>
              <td className="text-right tabular-nums">{usd(r.costUsd)}</td>
              <td className="text-right tabular-nums">{duration(r.startedAt, r.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
