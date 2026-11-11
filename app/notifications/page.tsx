import { Suspense } from "react";
import { getNotifications } from "../lib/data";
import { markAllRead, markRead } from "../actions";
import { ActionButton, Btn, Empty, L, Time } from "../components/ui";

export default function Page() {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notifications</h1>
        <form action={markAllRead}>
          <Btn>Mark all read</Btn>
        </form>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <List />
      </Suspense>
    </div>
  );
}

const ICON: Record<string, string> = {
  pr_opened: "🔀",
  pr_merged: "✅",
  pr_closed: "🚫",
  fix_verified: "🎉",
  regression: "⚠️",
  attempt_failed: "❌",
  run_failed: "💥",
  run_summary: "📋",
  pr_revised: "✏️",
  revision_failed: "❌",
  revisions_exhausted: "✋",
  usage_limit: "⏳",
  project_ready: "📦",
  project_error: "💥",
  config_test: "🧪",
};

async function List() {
  const ns = await getNotifications();
  if (!ns.length) return <Empty>No notifications yet.</Empty>;
  return (
    <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
      {ns.map((n) => (
        <li key={n.id} className={`flex items-start gap-3 px-3 py-2 text-sm ${n.readAt ? "opacity-60" : ""}`}>
          <span aria-hidden>{ICON[n.kind] ?? "•"}</span>
          <div className="flex-1">
            <div className="font-medium">{n.link ? <L href={n.link}>{n.title}</L> : n.title}</div>
            {n.body && <p className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{n.body}</p>}
          </div>
          <span className="shrink-0 text-xs text-zinc-500">
            <Time iso={n.createdAt} />
          </span>
          {!n.readAt && (
            <ActionButton action={markRead} fields={{ id: n.id }}>
              Read
            </ActionButton>
          )}
        </li>
      ))}
    </ul>
  );
}
