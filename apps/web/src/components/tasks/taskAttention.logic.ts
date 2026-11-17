import type { Task } from "@t3tools/contracts";

import {
  hasUnseenCompletion,
  resolveSidebarFolderDot,
  resolveSidebarRowStatus,
} from "../Sidebar.logic";
import { resolveThreadTopStatus, type ThreadTopStatus } from "../sidebar/threadTopStatus";

export type TaskAttention = ReturnType<typeof resolveSidebarFolderDot>;

/** The most urgent state among a task's threads, using the same rule as a closed sidebar folder. */
export function taskAttention(
  threads: Parameters<typeof resolveSidebarFolderDot>[0],
): TaskAttention {
  return resolveSidebarFolderDot(threads);
}

/** One thread's status, as its sidebar row shows it. */
export function threadRowStatus(
  thread: Parameters<typeof resolveSidebarFolderDot>[0][number],
): ThreadTopStatus | null {
  return resolveThreadTopStatus({
    status: resolveSidebarRowStatus(thread),
    isUnread: hasUnseenCompletion(thread),
    isWoke: false,
    goalActive: false,
  });
}

/** The status the task shows: its most urgent thread's row status, in the sidebar's words. */
export function taskAttentionStatus(
  threads: Parameters<typeof resolveSidebarFolderDot>[0],
): ThreadTopStatus | null {
  const attention = resolveSidebarFolderDot(threads);
  if (attention === null) return null;
  for (const thread of threads) {
    const status = resolveSidebarRowStatus(thread);
    const matches =
      attention === "attention"
        ? status === "input" ||
          status === "approval" ||
          status === "request" ||
          status === "limited"
        : attention === "failed"
          ? status === "failed"
          : attention === "unread"
            ? status === "ready" && hasUnseenCompletion(thread)
            : status === "working" || status === "preparing";
    if (matches) return threadRowStatus(thread);
  }
  return null;
}

/** Tasks that need the user (a question or an unseen result) come first, then board order. */
export function sortColumn(
  tasks: ReadonlyArray<Task>,
  attentionById: Readonly<Record<string, TaskAttention | undefined>>,
): Task[] {
  const flagged = (task: Task) => {
    const attention = attentionById[task.id];
    return attention === "attention" || attention === "unread";
  };
  return tasks.toSorted((a, b) => {
    const byFlag = Number(flagged(b)) - Number(flagged(a));
    return byFlag !== 0 ? byFlag : a.sortKey - b.sortKey;
  });
}

const STATUS_RANK: Record<ThreadTopStatus["icon"], number> = {
  input: 0,
  approval: 0,
  request: 0,
  failed: 1,
  done: 2,
  woke: 2,
  working: 3,
  waiting: 4,
};

/** A task card's threads: those that need the user first, then the most recently active. */
export function orderCardThreads<T extends { readonly updatedAt: string }>(
  threads: ReadonlyArray<{ readonly thread: T; readonly status: ThreadTopStatus | null }>,
) {
  const rank = (status: ThreadTopStatus | null) => (status === null ? 5 : STATUS_RANK[status.icon]);
  return threads.toSorted(
    (a, b) =>
      rank(a.status) - rank(b.status) || b.thread.updatedAt.localeCompare(a.thread.updatedAt),
  );
}
