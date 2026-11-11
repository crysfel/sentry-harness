"use client";

import { useActionState } from "react";
import { saveProjectSettings } from "../../actions";
import type { Project } from "@/src/db/schema";

function Text({ name, label, value, hint, mono, wide }: { name: string; label: string; value: string | number | null; hint?: string; mono?: boolean; wide?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "md:col-span-2" : ""}`}>
      <span>{label}</span>
      {wide ? (
        <textarea name={name} defaultValue={value ?? ""} rows={2} className={mono ? "font-mono text-xs" : ""} />
      ) : (
        <input name={name} defaultValue={value ?? ""} className={mono ? "font-mono text-xs" : ""} />
      )}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

function Check({ name, label, checked, hint }: { name: string; label: string; checked: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1" />
      <span>
        {label}
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

export function SettingsForm({ project: p }: { project: Project }) {
  const [state, action, pending] = useActionState(saveProjectSettings, undefined);
  return (
    <form action={action} className="grid max-w-4xl gap-3 text-sm md:grid-cols-2">
      <input type="hidden" name="projectId" value={p.id} />
      <Text name="name" label="Name" value={p.name} />
      <Text name="model" label="Model" value={p.model} hint="Used for triage and fix sessions." />
      <Text name="sentryOrg" label="Sentry organization" value={p.sentryOrg} mono />
      <Text name="sentryProject" label="Sentry project" value={p.sentryProject} mono />
      <Text name="sentryQueryFilter" label="Sentry query filter" value={p.sentryQueryFilter} mono wide hint="Extra issue-search terms. Note: release.version:>=X is not supported by issue search; legacy-app issues are handled by triage (not_in_repo)." />
      <Text name="setupCmd" label="Setup command" value={p.setupCmd} mono wide hint="Optional. Runs in each fresh worktree before the agent." />
      <Text name="buildCmd" label="Build command" value={p.buildCmd} mono wide />
      <Text name="testCmd" label="Test command" value={p.testCmd} mono wide />
      <Text name="versionCmd" label="Version command" value={p.versionCmd} mono wide hint="Prints the app version of the checkout; used for base and ship versions." />
      <Text name="scheduleCron" label="Schedule (cron, local time)" value={p.scheduleCron} mono />
      <Text name="feedbackPollMinutes" label="PR feedback poll (minutes)" value={p.feedbackPollMinutes} />
      <Text name="maxFixesPerRun" label="Max fixes per run" value={p.maxFixesPerRun} />
      <Text name="maxOpenPrs" label="Max open harness PRs" value={p.maxOpenPrs} />
      <Text name="maxAttemptsPerIssue" label="Max attempts per issue" value={p.maxAttemptsPerIssue} />
      <Text name="maxBudgetUsdPerAttempt" label="Max USD per agent session" value={p.maxBudgetUsdPerAttempt} hint="May not bind under a subscription; turn and time limits apply too." />
      <Text name="impactThreshold" label="Impact threshold" value={p.impactThreshold} hint="users × severity × trend" />
      <Text name="maxDiffLines" label="Max changed lines per fix" value={p.maxDiffLines} />
      <Text name="reviewAuthors" label="Review authors (GitHub logins)" value={(p.reviewAuthors ?? []).join(", ")} hint="Only their PR comments steer revisions." />
      <Text name="maxRevisionsPerPr" label="Max revisions per PR" value={p.maxRevisionsPerPr} />
      <div className="flex flex-col gap-2 md:col-span-2">
        <Check name="prDraft" label="Open PRs as drafts" checked={p.prDraft} />
        <Check name="sentryNotes" label="Add a note with the PR link to the Sentry issue" checked={p.sentryNotes} hint="Needs a Sentry token with write scope. Off by default." />
        <Check name="enabled" label="Enabled (scheduled runs)" checked={p.enabled} hint={p.configTestOk ? undefined : 'Requires a passing "Test configuration".'} />
      </div>
      <div className="flex items-center gap-3 md:col-span-2">
        <button disabled={pending} className="rounded bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {pending ? "Saving…" : "Save settings"}
        </button>
        {state?.error && <span className="text-red-700 dark:text-red-400">{state.error}</span>}
        {state?.ok && <span className="text-green-700 dark:text-green-400">Saved.</span>}
      </div>
    </form>
  );
}
