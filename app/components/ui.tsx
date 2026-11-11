import Link from "next/link";
import type { ReactNode } from "react";

const STATUS_STYLE: Record<string, string> = {
  new: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  triaged: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  queued: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  fixing: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  pr_open: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  merged: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  awaiting_release: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fixed_unreleased: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
  verified_fixed: "bg-green-200 text-green-900 dark:bg-green-900 dark:text-green-100",
  regressed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  attempt_failed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  needs_human: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pr_closed: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  not_in_repo: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  not_actionable: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  low_impact: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  ignored: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-900 dark:text-zinc-500",
  // runs / attempts / jobs
  running: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  no_fix: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  verify_failed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  closed_unmerged: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ready: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  cloning: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  pushed: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  replied_only: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
};

export function Badge({ status, title }: { status: string; title?: string }) {
  return (
    <span title={title} className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function fmtDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric", year: "numeric" });
}

export function Time({ iso, withTime = true }: { iso: string | null | undefined; withTime?: boolean }) {
  return (
    <time dateTime={iso ?? undefined} title={iso ?? undefined} className="whitespace-nowrap tabular-nums">
      {fmtDate(iso, withTime)}
    </time>
  );
}

export function duration(start: string | null | undefined, end: string | null | undefined) {
  if (!start) return "—";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function usd(n: number | null | undefined) {
  return n ? `$${n.toFixed(2)}` : "—";
}

/** Tiny inline trend of users per snapshot. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 48;
  const h = 14;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ");
  const up = values.at(-1)! > values[0];
  return (
    <svg width={w} height={h} className={up ? "text-red-500" : "text-zinc-400"} aria-label={`trend ${values.join(", ")}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-medium [&_th]:text-zinc-500 [&_thead]:bg-zinc-50 dark:[&_thead]:bg-zinc-900 [&_tr]:border-b [&_tr]:border-zinc-100 dark:[&_tr]:border-zinc-900">
        {children}
      </table>
    </div>
  );
}

export function Btn({ children, variant = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" }) {
  const v =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      : variant === "danger"
        ? "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        : "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";
  return (
    <button {...props} className={`rounded px-2.5 py-1 text-sm font-medium disabled:opacity-50 ${v} ${props.className ?? ""}`}>
      {children}
    </button>
  );
}

/** A one-button form posting to a server action. */
export function ActionButton({ action, fields, children, variant }: { action: (fd: FormData) => Promise<void>; fields: Record<string, string | number>; children: ReactNode; variant?: "default" | "primary" | "danger" }) {
  return (
    <form action={action} className="inline">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={String(v)} />
      ))}
      <Btn variant={variant}>{children}</Btn>
    </form>
  );
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline dark:text-blue-400">
      {children}
    </a>
  );
}

export function L({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-blue-700 hover:underline dark:text-blue-400">
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">{children}</p>;
}
