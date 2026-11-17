import type { EnvironmentId, ProjectId, Task, TaskStatus } from "@t3tools/contracts";

import { sortColumn, type TaskAttention } from "./taskAttention.logic";
import { plural } from "./taskCleanup.logic";

export const TASK_STATUSES = [
  "backlog",
  "in_progress",
  "review",
  "done",
] as const satisfies ReadonlyArray<TaskStatus>;

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

/** The board shows only the latest finished tasks; older ones stay reachable through the archive. */
export const DONE_COLUMN_LIMIT = 20;

/** A task with the environment that stores it; every change goes back to that environment. */
export interface BoardTask {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
}

export interface BoardFilter {
  readonly archived: boolean;
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
}

export interface BoardColumn {
  readonly status: TaskStatus;
  readonly entries: ReadonlyArray<BoardTask>;
  /** Tasks in this status before the Done limit cuts the list. */
  readonly total: number;
}

export function boardTaskKey(entry: BoardTask): string {
  return `${entry.environmentId}\n${entry.task.id}`;
}

function completedTime(task: Task): number {
  return task.completedAt === null ? 0 : Date.parse(task.completedAt);
}

export function boardColumns(
  entries: ReadonlyArray<BoardTask>,
  attentionById: Readonly<Record<string, TaskAttention | undefined>>,
  filter: BoardFilter,
): BoardColumn[] {
  const shown = entries.filter(
    ({ environmentId, task }) =>
      (task.archivedAt !== null) === filter.archived &&
      (filter.environmentId === undefined || filter.environmentId === environmentId) &&
      (filter.projectId === undefined || task.projectIds.includes(filter.projectId)),
  );
  return TASK_STATUSES.map((status) => {
    let inStatus = shown.filter((entry) => entry.task.status === status);
    const total = inStatus.length;
    if (status === "done" && !filter.archived) {
      inStatus = inStatus
        .toSorted((a, b) => completedTime(b.task) - completedTime(a.task))
        .slice(0, DONE_COLUMN_LIMIT);
    }
    const byId = new Map(inStatus.map((entry) => [entry.task.id, entry]));
    const sorted = sortColumn(
      inStatus.map((entry) => entry.task),
      attentionById,
    );
    return { status, entries: sorted.map((task) => byId.get(task.id)!), total };
  });
}

/** The column one step left (-1) or right (1), for the `[` and `]` keys. */
export function neighborStatus(status: TaskStatus, step: -1 | 1): TaskStatus | null {
  return TASK_STATUSES[TASK_STATUSES.indexOf(status) + step] ?? null;
}

export function chatCountLabel(count: number): string {
  return `${count} ${plural(count, "thread", "threads")}`;
}
