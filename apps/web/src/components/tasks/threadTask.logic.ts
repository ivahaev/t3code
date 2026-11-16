import type { Task, ThreadId } from "@t3tools/contracts";

import type { ThreadShell } from "../../types";

type TaskThreadWorkspace = Pick<ThreadShell, "id" | "projectId" | "branch" | "worktreePath">;

/**
 * Worktrees the tasks still keep; deleting a chat must not remove them as orphans. A worktree
 * whose path the task has not learned yet is known by the task's chats on its branch.
 */
export function liveTaskWorktreePaths(
  tasks: ReadonlyArray<Task>,
  threads: ReadonlyArray<TaskThreadWorkspace>,
): ReadonlyArray<string> {
  return tasks.flatMap((task) =>
    task.worktrees.flatMap((worktree) => {
      if (worktree.removedAt !== null) return [];
      if (worktree.worktreePath !== null) return [worktree.worktreePath];
      return threads.flatMap((thread) =>
        task.threadIds.includes(thread.id) &&
        thread.projectId === worktree.projectId &&
        thread.branch === worktree.branch &&
        thread.worktreePath !== null
          ? [thread.worktreePath]
          : [],
      );
    }),
  );
}

/** Each chat's task; a chat belongs to at most one task. */
export function threadTaskIndex(tasks: ReadonlyArray<Task>): ReadonlyMap<ThreadId, Task> {
  const index = new Map<ThreadId, Task>();
  for (const task of tasks) for (const threadId of task.threadIds) index.set(threadId, task);
  return index;
}

const CHIP_LABEL_LENGTH = 12;

/** The task title on a sidebar chip, at most 12 characters with the ellipsis. */
export function taskChipLabel(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= CHIP_LABEL_LENGTH) return title;
  return `${characters
    .slice(0, CHIP_LABEL_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}
