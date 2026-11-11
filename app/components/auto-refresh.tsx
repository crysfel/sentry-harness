"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetch server components every few seconds while something is live. */
export function AutoRefresh({ ms = 4000, enabled = true }: { ms?: number; enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [router, ms, enabled]);
  return null;
}
