import type { TaskWorktree } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface BranchMergeState {
  readonly exists: boolean;
  readonly merged: boolean;
  readonly unmergedCommitCount: number;
}

const OPERATION = "TaskCleanup.git";

/** The commit `ref` names in the repository at `cwd`, or null. */
export const resolveCommit = Effect.fn("TaskCleanup.resolveCommit")(function* (
  cwd: string,
  ref: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: OPERATION,
    cwd,
    args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    allowNonZeroExit: true,
  });
  const commit = result.stdout.trim();
  return result.exitCode === 0 && commit.length > 0 ? commit : null;
});

/**
 * The commit of the first of `candidates` that exists, or null. Pinning the commit keeps a later
 * check on the same base even after cleanup deletes the branch it was named by.
 */
export const resolveBaseCommit = Effect.fn("TaskCleanup.resolveBaseCommit")(function* (
  cwd: string,
  candidates: ReadonlyArray<string>,
) {
  for (const candidate of new Set(candidates)) {
    const commit = yield* resolveCommit(cwd, candidate);
    if (commit !== null) return commit;
  }
  return null;
});

/** The branch the main checkout has checked out, or null when HEAD is detached. */
export const currentBranch = Effect.fn("TaskCleanup.currentBranch")(function* (cwd: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: OPERATION,
    cwd,
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    allowNonZeroExit: true,
  });
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch.length > 0 ? branch : null;
});

/**
 * Whether the local branch has commits that `baseRef` lacks. A missing branch has nothing to
 * lose, so it counts as merged.
 */
export const branchMergeState = Effect.fn("TaskCleanup.branchMergeState")(function* (
  cwd: string,
  branch: string,
  baseRef: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const localRef = `refs/heads/${branch}`;
  if ((yield* resolveCommit(cwd, localRef)) === null) {
    return { exists: false, merged: true, unmergedCommitCount: 0 } satisfies BranchMergeState;
  }
  const result = yield* git.execute({
    operation: OPERATION,
    cwd,
    args: ["rev-list", "--count", "--end-of-options", `${baseRef}..${localRef}`],
  });
  const count = Number.parseInt(result.stdout.trim(), 10);
  const unmergedCommitCount = Number.isFinite(count) ? count : 0;
  return {
    exists: true,
    merged: Number.isFinite(count) && count === 0,
    unmergedCommitCount,
  } satisfies BranchMergeState;
});

/**
 * Where a recorded worktree path stands: Git still lists it, it is gone from disk, or a folder
 * that Git does not list as a worktree sits there.
 */
export type WorktreePathState = "live" | "gone" | "stray";

export interface CleanupPath {
  readonly state: WorktreePathState;
  /** A thread outside the task works there. */
  readonly foreign: boolean;
  /** The project's main checkout. */
  readonly mainCheckout: boolean;
  /** An agent of the task is running there now. */
  readonly running: boolean;
}

/** What cleanup must know about one project of the task. */
export interface CleanupProject {
  /** The project's main checkout, where git commands run. Never removed. */
  readonly cwd: string;
  /** Every recorded worktree path of the task in this project. */
  readonly paths: ReadonlyMap<string, CleanupPath>;
  /** Branches that a thread outside the task uses. */
  readonly foreignBranches: ReadonlySet<string>;
  /** The default branch and the main checkout's branch; never deleted. */
  readonly protectedBranches: ReadonlySet<string>;
  /** Default branch names to measure "merged" against, best first. */
  readonly baseBranches: ReadonlyArray<string>;
}

type CleanupWorktree = Pick<
  TaskWorktree,
  "branch" | "baseRef" | "kind" | "worktreePath" | "removedAt" | "branchDeletedAt"
>;

/** A worktree whose launch has not reported its path yet. */
export const isPendingWorktree = (worktree: CleanupWorktree) =>
  worktree.worktreePath === null && worktree.removedAt === null;

/** Why cleanup may not remove the worktree, or null when it may. */
export const worktreeBlocker = (
  worktree: CleanupWorktree,
  project: CleanupProject,
): string | null => {
  const path = worktree.worktreePath;
  if (path === null || worktree.removedAt !== null) return "it is not a live worktree of this task";
  const known = project.paths.get(path);
  if (known === undefined) return "it is not a worktree of this task";
  if (known.mainCheckout) return "it is the project's main folder, not a task worktree";
  if (known.foreign) return "a thread outside this task uses it";
  if (known.state === "stray")
    return "Git no longer lists it as a worktree, so it is left in place";
  return null;
};

/** The worktree's path when cleanup may offer to remove it. */
export const removableWorktreePath = (worktree: CleanupWorktree, project: CleanupProject) =>
  worktreeBlocker(worktree, project) === null ? worktree.worktreePath : null;

/**
 * Whether cleanup may offer to delete the branch. `records` are the task's worktrees in the
 * branch's project. A branch in a worktree that cleanup may not remove stays too.
 */
export const isDeletableBranch = (
  branch: string,
  records: ReadonlyArray<CleanupWorktree>,
  project: CleanupProject,
) => {
  if (project.protectedBranches.has(branch) || project.foreignBranches.has(branch)) return false;
  const own = records.filter((worktree) => worktree.branch === branch);
  // No record, or all deleted already: `every` is true for an empty list.
  if (own.every((worktree) => worktree.branchDeletedAt !== null)) return false;
  return own.every(
    (worktree) =>
      !isPendingWorktree(worktree) &&
      (worktree.removedAt !== null || removableWorktreePath(worktree, project) !== null),
  );
};

/**
 * Refs to measure "merged" against, best first. The shared worktree diffs against the
 * default branch; an extra one against its own base, usually the task branch.
 */
export const mergeBaseCandidates = (worktree: CleanupWorktree, project: CleanupProject) => {
  const defaults = project.baseBranches.flatMap((branch) => [`origin/${branch}`, branch]);
  return worktree.kind === "extra" ? [worktree.baseRef, ...defaults] : defaults;
};
