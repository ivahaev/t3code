import type {
  ProjectId,
  Task,
  TaskCleanupInput,
  TaskCleanupPreview,
  TaskStatus,
} from "@t3tools/contracts";

type PreviewWorktree = TaskCleanupPreview["worktrees"][number];
type PreviewBranch = TaskCleanupPreview["branches"][number];

/** What the cleanup dialog has checked: worktree paths and `projectId:branch` keys. */
export interface CleanupSelection {
  readonly worktrees: ReadonlySet<string>;
  readonly branches: ReadonlySet<string>;
}

/** The cleanup request without the task id, which the caller adds. */
export type CleanupSelectionInput = Omit<TaskCleanupInput, "id">;

export function cleanupBranchKey(projectId: ProjectId, branch: string): string {
  return `${projectId}:${branch}`;
}

const branchKey = (entry: { readonly projectId: ProjectId; readonly branch: string }) =>
  cleanupBranchKey(entry.projectId, entry.branch);

/** Git refuses to delete a branch checked out in a worktree, so a branch goes with its worktrees. */
function worktreesOf(preview: TaskCleanupPreview, key: string): ReadonlyArray<PreviewWorktree> {
  return preview.worktrees.filter((worktree) => branchKey(worktree) === key);
}

/** A merged branch is safe to delete once every worktree holding it is clean. */
function isSafeBranch(preview: TaskCleanupPreview, branch: PreviewBranch): boolean {
  return (
    branch.merged &&
    worktreesOf(preview, branchKey(branch)).every((worktree) => worktree.dirtyFileCount === 0)
  );
}

/** Clean worktrees and merged branches start checked; dirty and unmerged ones wait for the user. */
export function initialCleanupSelection(preview: TaskCleanupPreview): CleanupSelection {
  return {
    worktrees: new Set(
      preview.worktrees
        .filter((worktree) => worktree.dirtyFileCount === 0)
        .map((worktree) => worktree.path),
    ),
    branches: new Set(
      preview.branches.filter((branch) => isSafeBranch(preview, branch)).map(branchKey),
    ),
  };
}

/** Checking a branch checks its worktrees, since the branch cannot go while they hold it. */
export function toggleBranch(
  selection: CleanupSelection,
  preview: TaskCleanupPreview,
  key: string,
): CleanupSelection {
  const branches = new Set(selection.branches);
  const worktrees = new Set(selection.worktrees);
  if (branches.delete(key)) return { worktrees, branches };
  branches.add(key);
  for (const worktree of worktreesOf(preview, key)) worktrees.add(worktree.path);
  return { worktrees, branches };
}

/** Keeping a worktree keeps the branch it holds. */
export function toggleWorktree(
  selection: CleanupSelection,
  preview: TaskCleanupPreview,
  path: string,
): CleanupSelection {
  const branches = new Set(selection.branches);
  const worktrees = new Set(selection.worktrees);
  if (worktrees.delete(path)) {
    const worktree = preview.worktrees.find((entry) => entry.path === path);
    if (worktree) branches.delete(branchKey(worktree));
  } else {
    worktrees.add(path);
  }
  return { worktrees, branches };
}

/**
 * The checked items as a cleanup request. Each worktree carries the uncommitted files the user
 * saw, so the server keeps one that changed since; unmerged branches are deleted with force.
 */
export function cleanupSelectionInput(
  preview: TaskCleanupPreview,
  selection: CleanupSelection,
): CleanupSelectionInput {
  return {
    worktrees: preview.worktrees
      .filter((worktree) => selection.worktrees.has(worktree.path))
      .map((worktree) => ({
        path: worktree.path,
        acceptedDirtyFileCount: worktree.dirtyFileCount,
      })),
    branches: preview.branches
      .filter((branch) => selection.branches.has(branchKey(branch)))
      .map((branch) => ({
        projectId: branch.projectId,
        branch: branch.branch,
        force: !branch.merged,
      })),
  };
}

export function isEmptyCleanupPreview(preview: TaskCleanupPreview): boolean {
  return preview.worktrees.length === 0 && preview.branches.length === 0;
}

/**
 * The `always` mode: clean worktrees and safe merged branches go without asking; the dialog
 * shows only what is left, so nothing with unsaved or unmerged work is removed silently.
 */
export function autoCleanupPlan(preview: TaskCleanupPreview): {
  readonly silent: CleanupSelectionInput;
  readonly needsDialog: TaskCleanupPreview | null;
} {
  const silent = initialCleanupSelection(preview);
  const rest: TaskCleanupPreview = {
    worktrees: preview.worktrees.filter((worktree) => !silent.worktrees.has(worktree.path)),
    branches: preview.branches.filter((branch) => !silent.branches.has(branchKey(branch))),
  };
  return {
    silent: cleanupSelectionInput(preview, silent),
    needsDialog: isEmptyCleanupPreview(rest) ? null : rest,
  };
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function cleanupSummary(removedWorktrees: number, deletedBranches: number): string {
  return `Removed ${removedWorktrees} ${plural(removedWorktrees, "worktree", "worktrees")} and ${deletedBranches} ${plural(deletedBranches, "branch", "branches")}`;
}

/**
 * Moving a task out of Done after its shared branch was deleted: the next thread starts the
 * branch again from the base, so the user confirms first.
 */
export function leavingDoneConfirmation(task: Task, status: TaskStatus): string | null {
  if (task.status !== "done" || status === "done") return null;
  return task.worktrees.some(
    (worktree) => worktree.kind === "shared" && worktree.branchDeletedAt !== null,
  )
    ? "The task's branch was deleted. The next thread will create it again from the base."
    : null;
}
