import type { Db } from "../db/client";
import { notifications } from "../db/schema";

/**
 * Notification kinds (PLAN §6.8, §6.9). One implementation (database) in v1;
 * outbound channels can be added behind `Notifier` later.
 */
export type NotificationKind =
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "fix_verified"
  | "regression"
  | "attempt_failed"
  | "run_failed"
  | "run_summary"
  | "pr_revised"
  | "revision_failed"
  | "revisions_exhausted"
  | "usage_limit"
  | "project_ready"
  | "project_error"
  | "config_test";

export type NotificationInput = {
  projectId?: number | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  issueId?: number | null;
  attemptId?: number | null;
  runId?: number | null;
};

export interface Notifier {
  send(n: NotificationInput): void;
}

export class DbNotifier implements Notifier {
  constructor(private d: Db) {}
  send(n: NotificationInput) {
    this.d.insert(notifications).values({ ...n, projectId: n.projectId ?? null }).run();
  }
}

export function notify(d: Db, n: NotificationInput) {
  new DbNotifier(d).send(n);
}
