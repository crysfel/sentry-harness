import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { unreadCount, workerAlive } from "./lib/data";

export const metadata: Metadata = {
  title: "Sentry Harness",
  description: "Daily Sentry triage and autofix",
};

async function Bell() {
  const n = await unreadCount();
  return (
    <Link href="/notifications" className="relative rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={`${n} unread notifications`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {n > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white">{n > 99 ? "99+" : n}</span>}
    </Link>
  );
}

async function WorkerDot() {
  const alive = await workerAlive();
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-500" title={alive ? "Worker heartbeat within the last 3 minutes" : "No worker heartbeat in 3 minutes: is `npm run worker` running?"}>
      <span className={`inline-block h-2 w-2 rounded-full ${alive ? "bg-green-500" : "bg-red-500"}`} />
      worker {alive ? "up" : "down"}
    </span>
  );
}

const NAV = [
  ["/", "Overview"],
  ["/issues", "Issues"],
  ["/runs", "Runs"],
  ["/projects", "Projects"],
  ["/settings", "Settings"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <div className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-2">
            <Link href="/" className="font-semibold">
              sentry-harness
            </Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                  {label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <Suspense fallback={null}>
                <WorkerDot />
              </Suspense>
              <Suspense fallback={<span className="w-8" />}>
                <Bell />
              </Suspense>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
