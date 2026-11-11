"use client";

import { useActionState } from "react";
import { addProject } from "../actions";
import { SentryConnectionSelect, type SentryConnectionOption } from "./connection-select";

export function AddProjectForm({ connections }: { connections: SentryConnectionOption[] }) {
  const [state, action, pending] = useActionState(addProject, undefined);
  return (
    <form action={action} className="grid max-w-2xl gap-3 text-sm md:grid-cols-2">
      <label className="flex flex-col gap-1 md:col-span-2">
        <span>GitHub repository</span>
        <input name="repo" required placeholder="owner/name or https://github.com/owner/name" />
        <span className="text-xs text-zinc-500">The harness clones it over HTTPS with its scoped token. Add the repository to the token on GitHub first.</span>
      </label>
      <SentryConnectionSelect options={connections} />
      <div className="hidden md:block" />
      <label className="flex flex-col gap-1">
        <span>Sentry organization slug</span>
        <input name="sentryOrg" required placeholder="peacefulhymns-backend" />
      </label>
      <label className="flex flex-col gap-1">
        <span>Sentry project slug</span>
        <input name="sentryProject" required placeholder="himnario-mobile" />
      </label>
      <label className="flex flex-col gap-1 md:col-span-2">
        <span>Sentry query filter (optional)</span>
        <input name="sentryQueryFilter" placeholder="extra search terms, e.g. environment:production" />
      </label>
      <div className="flex items-center gap-3 md:col-span-2">
        <button disabled={pending} className="rounded bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {pending ? "Adding…" : "Add project"}
        </button>
        {state?.error && <span className="text-red-700 dark:text-red-400">{state.error}</span>}
      </div>
    </form>
  );
}
