import type {
  EnvironmentId,
  ProjectId,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  Task,
  TaskWorktree,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

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

/** The two previews of a task worktree that still exists on disk where the task recorded it. */
function worktreeDiffInputs(worktree: TaskWorktree): {
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

export interface DiffTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffPreviewInput;
}

/**
 * The live worktrees of the task and the `review.getDiffPreview` targets they read, two per
 * worktree in that order. Nothing is read where this connection cannot read files.
 */
export function taskDiffTargets(
  environmentId: EnvironmentId,
  task: Task,
  canReadFiles: boolean,
): { readonly worktrees: TaskWorktree[]; readonly targets: DiffTarget[] } {
  const worktrees: TaskWorktree[] = [];
  const targets: DiffTarget[] = [];
  if (!canReadFiles) return { worktrees, targets };
  for (const worktree of task.worktrees) {
    const inputs = worktreeDiffInputs(worktree);
    if (inputs === null) continue;
    worktrees.push(worktree);
    targets.push(
      { environmentId, input: inputs.branch },
      { environmentId, input: inputs.workingTree },
    );
  }
  return { worktrees, targets };
}

export interface WorktreeDiffState {
  readonly branch: ReviewDiffPreviewResult | null;
  readonly workingTree: ReviewDiffPreviewResult | null;
  readonly pending: boolean;
  /** One line per failed source; the other source still shows. */
  readonly errors: string[];
}

/** One worktree's diff state from its two query results. */
export function worktreeDiffState<E>(
  branch: AsyncResult.AsyncResult<ReviewDiffPreviewResult, E>,
  workingTree: AsyncResult.AsyncResult<ReviewDiffPreviewResult, E>,
  formatError: (failure: AsyncResult.Failure<ReviewDiffPreviewResult, E>) => string,
): WorktreeDiffState {
  const errors: string[] = [];
  if (branch._tag === "Failure") errors.push(`Коммиты ветки: ${formatError(branch)}`);
  if (workingTree._tag === "Failure") {
    errors.push(`Незакоммиченные изменения: ${formatError(workingTree)}`);
  }
  return {
    branch: AsyncResult.getOrElse(branch, () => null),
    workingTree: AsyncResult.getOrElse(workingTree, () => null),
    pending: [branch, workingTree].some((result) => result.waiting || result._tag === "Initial"),
    errors,
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

/**
 * Why the task cannot start its first chat, or null when it can. The start opens the shared
 * worktree in the primary project, so that project must be one this client sees.
 */
export function taskStartBlocker(
  task: Task,
  availableProjectIds: ReadonlySet<ProjectId>,
): string | null {
  if (task.archivedAt !== null) return "Задача в архиве.";
  if (!availableProjectIds.has(task.primaryProjectId)) {
    return "Основной проект задачи недоступен в этом environment.";
  }
  return null;
}

/** The repository a new chat starts in: the primary one when available, or none at all. */
export function defaultNewThreadProject(
  task: Task,
  availableProjectIds: ReadonlySet<ProjectId>,
): ProjectId | null {
  if (availableProjectIds.has(task.primaryProjectId)) return task.primaryProjectId;
  return task.projectIds.find((projectId) => availableProjectIds.has(projectId)) ?? null;
}

export interface AttachCandidate {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Chats that can join the task, matching the query by title, branch or project, newest first. */
export function attachCandidates<T extends AttachCandidate>(
  shells: ReadonlyArray<T>,
  input: {
    readonly task: Task;
    readonly query: string;
    readonly projectTitles: ReadonlyMap<ProjectId, string>;
    readonly limit: number;
  },
): T[] {
  const needle = input.query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  return shells
    .filter(
      (shell) =>
        shell.deletedAt === null &&
        !input.task.threadIds.includes(shell.id) &&
        (needle === "" ||
          matches(shell.title) ||
          matches(shell.branch ?? "") ||
          matches(input.projectTitles.get(shell.projectId) ?? "")),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, input.limit);
}
