import { Suspense } from "react";
import { getSetting } from "../lib/data";
import { runHealthCheck } from "../actions";
import type { HealthReport } from "@/src/core/health";
import { Btn, Empty, Section, Time } from "../components/ui";

export default function Page() {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings &amp; health</h1>
        <form action={runHealthCheck}>
          <Btn variant="primary">Run health checks</Btn>
        </form>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <Health />
      </Suspense>
      <Section title="Global defaults">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Per-project settings (schedule, caps, model, commands) live on each project&apos;s page. Credentials live in <code>.env</code> on the worker machine and are never stored in the database.
        </p>
      </Section>
    </div>
  );
}

async function Health() {
  const h = await getSetting<HealthReport>("health");
  return (
    <Section title={h ? <>Health checks · <Time iso={h.checkedAt} /></> : "Health checks"}>
      {!h ? (
        <Empty>Not run yet. The worker runs them when you press the button.</Empty>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 text-sm dark:divide-zinc-900 dark:border-zinc-800">
          {h.checks.map((c) => (
            <li key={c.name} className="flex gap-3 px-3 py-1.5">
              <span>{c.ok === null ? "➖" : c.ok ? "✅" : "❌"}</span>
              <span className="w-72 shrink-0 font-medium">{c.name}</span>
              <span className="text-zinc-600 dark:text-zinc-400">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
