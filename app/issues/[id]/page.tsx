import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getIssue } from "../../lib/data";
import { addToGroup, fixNow, removeFromGroup, retryIssue, toggleIgnore, togglePin } from "../../actions";
import { AutoRefresh } from "../../components/auto-refresh";
import { ActionButton, Badge, Btn, Empty, ExtLink, L, Section, Sparkline, Time, usd } from "../../components/ui";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <IssueView params={params} />
    </Suspense>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}

async function IssueView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getIssue(Number(id));
  if (!data) notFound();
  const { issue: i, project, group, groupMembers, groupCandidates, attempts, covered, revisions, feedback, snapshots, timeline, pendingRun } = data;
  const live = !!pendingRun || ["queued", "fixing"].includes(i.status);
  const canFix = !["queued", "fixing", "pr_open", "ignored"].includes(i.status) && !pendingRun;
  const openPr = attempts.find((a) => a.status === "pr_open");

  return (
    <div>
      <AutoRefresh enabled={live} />
      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
        <L href={`/projects/${project.id}`}>{project.name}</L> ·
        <ExtLink href={i.sentryUrl}>{i.shortId} in Sentry ↗</ExtLink>
        {openPr?.prUrl && (
          <>
            · <ExtLink href={openPr.prUrl}>PR #{openPr.prNumber} ↗</ExtLink>
          </>
        )}
      </div>
      <h1 className="mb-2 text-lg font-semibold">{i.title}</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge status={i.status} />
        {i.verificationConfidence && <Badge status={i.verificationConfidence === "confirmed" ? "succeeded" : "pending"} title="Verification confidence" />}
        {i.pinned && <span className="text-xs">📌 pinned</span>}
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{i.statusReason}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <ActionButton action={togglePin} fields={{ issueId: i.id }}>
            {i.pinned ? "Unpin" : "Pin"}
          </ActionButton>
          <ActionButton action={toggleIgnore} fields={{ issueId: i.id }}>
            {i.ignored ? "Un-ignore" : "Ignore"}
          </ActionButton>
          {["pr_closed", "needs_human", "attempt_failed", "not_actionable", "regressed"].includes(i.status) && !pendingRun && (
            <ActionButton action={retryIssue} fields={{ issueId: i.id }}>
              Retry
            </ActionButton>
          )}
          {canFix && (
            <ActionButton action={fixNow} fields={{ issueId: i.id }} variant="primary">
              Fix now
            </ActionButton>
          )}
          {pendingRun && <L href={`/runs/${pendingRun.id}`}>Run #{pendingRun.id} {pendingRun.status}…</L>}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 rounded border border-zinc-200 p-3 text-sm md:grid-cols-6 dark:border-zinc-800">
        <Field label="Users (14d)">
          <span className="tabular-nums">{i.users14d}</span> <Sparkline values={snapshots.map((s) => s.users14d)} />
        </Field>
        <Field label="Events (14d)">{i.events14d}</Field>
        <Field label="Impact score">{i.impactScore ?? "—"}</Field>
        <Field label="Substatus / level">
          {i.substatus ?? "—"} · {i.level ?? "—"}
        </Field>
        <Field label="First seen">
          <Time iso={i.firstSeen} /> <div className="text-xs text-zinc-500">{i.firstRelease}</div>
        </Field>
        <Field label="Last seen">
          <Time iso={i.lastSeen} /> <div className="text-xs text-zinc-500">{i.lastReleaseSeen}</div>
        </Field>
        <Field label="Culprit">
          <span className="font-mono text-xs">{i.culprit ?? "—"}</span>
        </Field>
        <Field label="Classification">
          {i.classification ?? "—"} · fixability {i.fixability ?? "—"}
        </Field>
        {i.expectedVersion && <Field label="Expected fixed in">{i.expectedVersion}</Field>}
        {i.fixedByCommit && <Field label="Fixed by commit">{i.fixedByCommit.slice(0, 10)}</Field>}
        {i.baselineEventsPerDay !== null && <Field label="Baseline events/day">{i.baselineEventsPerDay}</Field>}
        <Field label="Last triaged">
          <Time iso={i.lastTriagedAt} />
        </Field>
      </div>

      <Section title="Triage reasoning">
        {i.triageSummary ? (
          <div className="text-sm">
            <p>{i.triageSummary}</p>
            {!!i.relevantFiles?.length && <p className="mt-1 font-mono text-xs text-zinc-500">{i.relevantFiles.join(" · ")}</p>}
          </div>
        ) : (
          <Empty>Not triaged yet.</Empty>
        )}
      </Section>

      <Section title={group ? `Group #${group.id}${group.locked ? " (locked)" : ""}` : "Group"}>
        {group ? (
          <div className="text-sm">
            <p className="font-medium">{group.title}</p>
            <p className="mb-2 text-zinc-600 dark:text-zinc-400">{group.reasoning}</p>
            <ul className="mb-2 space-y-1">
              {groupMembers.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Badge status={m.status} />
                  {m.id === i.id ? <span className="font-mono text-xs">{m.shortId}</span> : <L href={`/issues/${m.id}`}>{m.shortId}</L>}
                  <span className="truncate text-zinc-600 dark:text-zinc-400">{m.title}</span>
                  <span className="text-xs text-zinc-500">{m.users14d} users</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mb-2 text-sm text-zinc-500">Not grouped with other issues.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {group && (
            <ActionButton action={removeFromGroup} fields={{ issueId: i.id }}>
              Remove from group
            </ActionButton>
          )}
          {groupCandidates.length > 0 && (
            <form action={addToGroup} className="flex items-center gap-2">
              <input type="hidden" name="issueId" value={i.id} />
              <select name="otherIssueId" defaultValue="">
                <option value="" disabled>
                  Add issue to {group ? "this group" : "a new group"}…
                </option>
                {groupCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shortId}: {c.title.slice(0, 60)}
                  </option>
                ))}
              </select>
              <Btn>Add to group</Btn>
            </form>
          )}
          <span className="text-xs text-zinc-500">Editing a group locks it so triage leaves it alone.</span>
        </div>
      </Section>

      <Section title={`Attempts (${attempts.length})`}>
        {attempts.length === 0 && <Empty>No fix attempts yet.</Empty>}
        <div className="space-y-3">
          {attempts.map((a) => {
            const cov = covered.filter((c) => c.ai.attemptId === a.id);
            const revs = revisions.filter((r) => r.attemptId === a.id);
            return (
              <div key={a.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium">Attempt {a.number}</span>
                  <Badge status={a.status} />
                  {a.issueId !== i.id && <span className="text-xs text-zinc-500">(as part of a group fix)</span>}
                  {a.prUrl && <ExtLink href={a.prUrl}>PR #{a.prNumber}</ExtLink>}
                  {a.runId && <L href={`/runs/${a.runId}`}>run #{a.runId}</L>}
                  <span className="ml-auto text-xs text-zinc-500">
                    <Time iso={a.startedAt} /> · {usd(a.costUsd)} · {a.turns} turns
                  </span>
                </div>
                <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
                  <Field label="Base">
                    {a.baseVersion ?? "?"} ({a.baseSha?.slice(0, 10) ?? "?"}) {a.branch && <span className="font-mono text-xs">· {a.branch}</span>}
                  </Field>
                  <Field label="Ships in">{a.shipVersion ?? (a.status === "merged" ? "unknown" : "—")}</Field>
                  <Field label="Build / tests">
                    {a.buildOk === null ? "—" : a.buildOk ? "build ✅" : "build ❌"} {a.testsOk === null ? "" : a.testsOk ? "· tests ✅" : "· tests ❌"} · confidence {a.confidence ?? "—"}
                  </Field>
                  <Field label="Covers">
                    {cov.length ? cov.map((c) => `${c.shortId}${c.ai.covered === false ? " (not addressed)" : ""}`).join(", ") : "—"}
                  </Field>
                </div>
                {a.rootCause && (
                  <p className="mt-2">
                    <span className="text-xs text-zinc-500">Root cause: </span>
                    {a.rootCause}
                  </p>
                )}
                {a.fixSummary && (
                  <p className="mt-1">
                    <span className="text-xs text-zinc-500">Fix: </span>
                    {a.fixSummary}
                  </p>
                )}
                {!!a.filesChanged?.length && <p className="mt-1 font-mono text-xs text-zinc-500">{a.filesChanged.join(" · ")}</p>}
                {a.error && <pre className="mt-2 whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">{a.error}</pre>}
                <p className="mt-2 text-xs text-zinc-500">
                  {a.transcriptPath && <>Transcript: <code>{a.transcriptPath}</code> </>}
                  {a.verifyLogPath && <>· Verify log: <code>{a.verifyLogPath}</code></>}
                </p>
                {revs.length > 0 && (
                  <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-900">
                    <div className="mb-1 text-xs font-medium uppercase text-zinc-500">Revisions</div>
                    {revs.map((r) => (
                      <div key={r.id} className="mb-2">
                        <div className="flex items-center gap-2">
                          Revision {r.number} <Badge status={r.status} /> {r.replyCommentUrl && <ExtLink href={r.replyCommentUrl}>reply</ExtLink>}
                          <span className="text-xs text-zinc-500">
                            <Time iso={r.startedAt} /> · {usd(r.costUsd)}
                          </span>
                        </div>
                        {r.summary && <p>{r.summary}</p>}
                        {r.error && <p className="text-xs text-red-700">{r.error}</p>}
                        <ul className="ml-4 list-disc text-xs text-zinc-600 dark:text-zinc-400">
                          {feedback
                            .filter((f) => f.revisionId === r.id)
                            .map((f) => (
                              <li key={f.id}>
                                @{f.author}
                                {f.path ? ` on ${f.path}:${f.line ?? ""}` : ""}: {f.body?.slice(0, 200)}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Timeline">
        {timeline.length === 0 ? (
          <Empty>No recorded events.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {timeline.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="shrink-0 text-xs text-zinc-500">
                  <Time iso={e.ts} />
                </span>
                <span className="w-24 shrink-0 text-xs text-zinc-500">{e.stage}</span>
                <span className={e.level === "error" ? "text-red-700 dark:text-red-400" : e.level === "warn" ? "text-amber-700 dark:text-amber-400" : ""}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
