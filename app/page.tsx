import { Suspense } from "react";
import { getOverview } from "./lib/data";
import { runNow } from "./actions";
import { AutoRefresh } from "./components/auto-refresh";
import { ActionButton, Badge, Empty, ExtLink, L, Section, Time } from "./components/ui";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <Overview />
    </Suspense>
  );
}

const COUNT_ORDER = ["triaged", "low_impact", "queued", "fixing", "pr_open", "awaiting_release", "fixed_unreleased", "verified_fixed", "regressed", "attempt_failed", "needs_human", "pr_closed", "not_actionable", "not_in_repo", "ignored", "new", "merged"];

async function Overview() {
  const rows = await getOverview();
  if (!rows.length) {
    return (
      <Empty>
        No projects yet. <L href="/projects">Add a project</L> by giving its GitHub repository and Sentry slugs.
      </Empty>
    );
  }
  const live = rows.some((r) => r.pending);
  return (
    <div>
      <AutoRefresh enabled={live} ms={5000} />
      {rows.map(({ project: p, lastRun, statusCounts, attention, pending, nextRun }) => (
        <Section
          key={p.id}
          title={
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <L href={`/projects/${p.id}`}>{p.name}</L>
              {!p.enabled && <Badge status="pending" title="Scheduled runs are off until the project is enabled" />}
            </span>
          }
          actions={
            <div className="flex gap-2">
              {pending ? (
                <L href={`/runs/${pending.id}`}>Run #{pending.id} {pending.status}…</L>
              ) : (
                <>
                  <ActionButton action={runNow} fields={{ projectId: p.id, dryRun: "1" }}>
                    Dry run
                  </ActionButton>
                  <ActionButton action={runNow} fields={{ projectId: p.id }} variant="primary">
                    Run now
                  </ActionButton>
                </>
              )}
            </div>
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="mb-1 text-xs uppercase text-zinc-500">Last run</div>
              {lastRun ? (
                <>
                  <div className="flex items-center gap-2">
                    <L href={`/runs/${lastRun.id}`}>#{lastRun.id}</L> <Badge status={lastRun.status} /> <Time iso={lastRun.startedAt ?? lastRun.createdAt} />
                  </div>
                  <p className="mt-1">{lastRun.summary ?? "—"}</p>
                </>
              ) : (
                <p>Never run.</p>
              )}
              <div className="mt-2 text-xs text-zinc-500">
                Next scheduled: {nextRun ? <Time iso={nextRun.toISOString()} /> : p.enabled ? "invalid schedule" : "disabled"} ({p.scheduleCron})
              </div>
            </div>
            <div className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="mb-1 text-xs uppercase text-zinc-500">Issues by status</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {COUNT_ORDER.filter((s) => statusCounts[s as keyof typeof statusCounts]).map((s) => (
                  <a key={s} href={`/issues?project=${p.id}&status=${s}`} className="flex items-center gap-1 hover:underline">
                    <Badge status={s} /> <span className="tabular-nums">{statusCounts[s as keyof typeof statusCounts]}</span>
                  </a>
                ))}
                {!Object.keys(statusCounts).length && <span className="text-zinc-500">No issues synced yet.</span>}
              </div>
            </div>
            <div className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="mb-1 text-xs uppercase text-zinc-500">Needs attention</div>
              {attention.length ? (
                <ul className="space-y-1">
                  {attention.slice(0, 8).map(({ issue: i, attempt: a }) => (
                    <li key={`${i.id}-${a?.id ?? 0}`} className="flex items-center gap-2">
                      <Badge status={i.status} />
                      <L href={`/issues/${i.id}`}>{i.shortId}</L>
                      {a?.prUrl && i.status === "pr_open" && <ExtLink href={a.prUrl}>PR #{a.prNumber}</ExtLink>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-zinc-500">Nothing waiting on you.</p>
              )}
            </div>
          </div>
        </Section>
      ))}
    </div>
  );
}
