import { Suspense } from "react";
import { getIssues, getProjects } from "../lib/data";
import { ISSUE_STATUSES } from "@/src/db/schema";
import { Badge, Empty, ExtLink, L, Sparkline, Table, Time } from "../components/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Issues</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <Issues searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function Issues({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const f = { project: Number(one(sp.project)) || undefined, status: one(sp.status) || undefined, q: one(sp.q) || undefined, sort: one(sp.sort) || undefined };
  const [rows, projects] = await Promise.all([getIssues(f), getProjects()]);
  return (
    <>
      <form className="mb-3 flex flex-wrap items-end gap-2 text-sm" method="get">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-zinc-500">Project</span>
          <select name="project" defaultValue={f.project ?? ""}>
            <option value="">All</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-zinc-500">Status</span>
          <select name="status" defaultValue={f.status ?? ""}>
            <option value="">All</option>
            <option value="open">Open (not fixed / ignored / not in repo)</option>
            {ISSUE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-zinc-500">Sort</span>
          <select name="sort" defaultValue={f.sort ?? ""}>
            <option value="">Impact</option>
            <option value="users">Users</option>
            <option value="events">Events</option>
            <option value="recent">Last seen</option>
            <option value="status">Status</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-zinc-500">Search</span>
          <input name="q" defaultValue={f.q ?? ""} placeholder="ID, title, culprit" />
        </label>
        <button className="rounded border border-zinc-300 px-2.5 py-1 dark:border-zinc-700">Filter</button>
        <span className="ml-auto text-xs text-zinc-500">{rows.length} issues</span>
      </form>
      {rows.length === 0 ? (
        <Empty>No issues match. Issues appear after the first triage run.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Title</th>
              <th>Status</th>
              <th className="text-right">Users</th>
              <th className="text-right">Events</th>
              <th>Trend</th>
              <th className="text-right">Impact</th>
              <th>Last attempt</th>
              <th>Version</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ issue: i, projectName, lastAttempt: a, trend }) => (
              <tr key={i.id} className="align-top">
                <td className="whitespace-nowrap font-mono text-xs">
                  <ExtLink href={i.sentryUrl}>{i.shortId}</ExtLink>
                  {projects.length > 1 && <div className="text-zinc-500">{projectName}</div>}
                </td>
                <td className="max-w-md">
                  <L href={`/issues/${i.id}`}>{i.title.length > 110 ? i.title.slice(0, 110) + "…" : i.title}</L>
                  {i.culprit && <div className="truncate text-xs text-zinc-500">{i.culprit}</div>}
                  {(i.pinned || i.groupId) && (
                    <div className="text-xs text-zinc-500">
                      {i.pinned && "📌 pinned "}
                      {i.groupId && `group #${i.groupId}`}
                    </div>
                  )}
                </td>
                <td>
                  <Badge status={i.status} title={i.statusReason ?? undefined} />
                </td>
                <td className="text-right tabular-nums">{i.users14d}</td>
                <td className="text-right tabular-nums">{i.events14d}</td>
                <td>
                  <Sparkline values={trend} />
                </td>
                <td className="text-right tabular-nums">{i.impactScore ?? "—"}</td>
                <td className="whitespace-nowrap">
                  {a ? (
                    <>
                      <Badge status={a.status} /> {a.prUrl && <ExtLink href={a.prUrl}>#{a.prNumber}</ExtLink>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums text-xs">{a?.shipVersion ? `ships ${a.shipVersion}` : i.expectedVersion ? `expect ${i.expectedVersion}` : a?.baseVersion ? `base ${a.baseVersion}` : "—"}</td>
                <td className="text-xs">
                  <Time iso={i.lastSeen} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
