import type {
  ProjectId,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  Task,
  TaskWorktree,
  ThreadId,
} from "@t3tools/contracts";

/** The fields of a thread shell that place it on the task page. */
export interface TaskThreadShell {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
}

export interface TaskWorktreeThreads<T> {
  readonly worktree: TaskWorktree;
  readonly threads: T[];
}

export interface TaskThreadGroup<T> {
  readonly projectId: ProjectId;
  /** False when this client has no such project, for example one deleted after it joined the task. */
  readonly available: boolean;
  /** The shared worktree first, then the extra ones. */
  readonly worktrees: TaskWorktreeThreads<T>[];
  /** Chats in the project root, or on a branch the task does not track. */
  readonly rootThreads: T[];
}

/**
 * One block per repository of the task, primary first. A chat belongs to a task worktree when
 * it is in the same project on the same branch; the chat itself knows its branch.
 */
export function groupTaskThreads<T extends TaskThreadShell>(
  task: Task,
  threadShells: ReadonlyArray<T>,
  availableProjectIds: ReadonlySet<ProjectId>,
): TaskThreadGroup<T>[] {
  const shellsById = new Map(threadShells.map((shell) => [shell.id, shell]));
  const threads = task.threadIds.flatMap((threadId) => {
    const shell = shellsById.get(threadId);
    return shell ? [shell] : [];
  });
  const projectIds = [
    ...new Set([
      task.primaryProjectId,
      ...task.projectIds,
      ...task.worktrees.map((worktree) => worktree.projectId),
      ...threads.map((thread) => thread.projectId),
    ]),
  ];
  return projectIds.map((projectId) => {
    const worktrees = task.worktrees
      .filter((worktree) => worktree.projectId === projectId)
      .toSorted((a, b) => Number(a.kind === "extra") - Number(b.kind === "extra"))
      .map((worktree): TaskWorktreeThreads<T> => ({ worktree, threads: [] }));
    const rootThreads: T[] = [];
    for (const thread of threads) {
      if (thread.projectId !== projectId) continue;
      const home = worktrees.find(
        ({ worktree }) => thread.branch !== null && worktree.branch === thread.branch,
      );
      if (home) home.threads.push(thread);
      else rootThreads.push(thread);
    }
    return { projectId, available: availableProjectIds.has(projectId), worktrees, rootThreads };
  });
}

/** A task worktree whose diff can be read: it still exists on disk where the task recorded it. */
export function worktreeDiffInputs(worktree: TaskWorktree): {
  readonly branch: ReviewDiffPreviewInput;
  readonly workingTree: ReviewDiffPreviewInput;
} | null {
  if (worktree.removedAt !== null || worktree.worktreePath === null) return null;
  const cwd = worktree.worktreePath;
  return {
    branch: { cwd, baseRef: worktree.baseRef, sourceKind: "branch-range" },
    workingTree: { cwd, sourceKind: "working-tree" },
  };
}

export interface DiffStat {
  readonly additions: number;
  readonly deletions: number;
}

/** Committed branch changes plus uncommitted ones; null until either preview has loaded. */
export function worktreeDiffStat(
  previews: ReadonlyArray<ReviewDiffPreviewResult | null>,
): DiffStat | null {
  if (previews.every((preview) => preview === null)) return null;
  let additions = 0;
  let deletions = 0;
  for (const preview of previews) {
    for (const source of preview?.sources ?? []) {
      for (const file of source.files ?? []) {
        additions += file.additions;
        deletions += file.deletions;
      }
    }
  }
  return { additions, deletions };
}

export type TaskErrorCode = "already_attached" | "worktree_preparing" | "not_found";

/** The `code` of a `TaskError` the server answered with, if the failure is one. */
export function taskErrorCode(error: unknown): TaskErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, code } = error as { readonly _tag?: unknown; readonly code?: unknown };
  return _tag === "TaskError" &&
    (code === "already_attached" || code === "worktree_preparing" || code === "not_found")
    ? code
    : null;
}
