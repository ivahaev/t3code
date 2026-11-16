import type { TaskWorktree } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface BranchMergeState {
  readonly exists: boolean;
  readonly merged: boolean;
  readonly unmergedCommitCount: number;
}

const OPERATION = "TaskCleanup.git";

/** True when `ref` names a commit in the repository at `cwd`. */
export const refExists = Effect.fn("TaskCleanup.refExists")(function* (cwd: string, ref: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: OPERATION,
    cwd,
    args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    allowNonZeroExit: true,
  });
  return result.exitCode === 0;
});

/** The first of `candidates` that exists, or null. */
export const resolveBaseRef = Effect.fn("TaskCleanup.resolveBaseRef")(function* (
  cwd: string,
  candidates: ReadonlyArray<string>,
) {
  for (const candidate of new Set(candidates)) {
    if (yield* refExists(cwd, candidate)) return candidate;
  }
  return null;
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
  if (!(yield* refExists(cwd, localRef))) {
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

/** What cleanup must know about one project of the task. */
export interface CleanupProject {
  /** The project's main checkout, where git commands run. Never removed. */
  readonly cwd: string;
  /** Worktrees Git still lists for the repository. */
  readonly livePaths: ReadonlySet<string>;
  /** Worktree paths and branches that a thread outside the task uses. */
  readonly foreignPaths: ReadonlySet<string>;
  readonly foreignBranches: ReadonlySet<string>;
  readonly defaultBranch: string;
}

type CleanupWorktree = Pick<
  TaskWorktree,
  "branch" | "baseRef" | "kind" | "worktreePath" | "removedAt" | "branchDeletedAt"
>;

/** A worktree whose launch has not reported its path yet. */
export const isPendingWorktree = (worktree: CleanupWorktree) =>
  worktree.worktreePath === null && worktree.removedAt === null;

/** The worktree's path when cleanup may offer to remove it. */
export const removableWorktreePath = (
  worktree: CleanupWorktree,
  project: CleanupProject,
): string | null => {
  const path = worktree.worktreePath;
  if (path === null || worktree.removedAt !== null) return null;
  if (path === project.cwd || project.foreignPaths.has(path)) return null;
  return path;
};

/**
 * Whether cleanup may offer to delete the branch. `records` are the task's worktrees in the
 * branch's project. A branch in a worktree that cleanup may not remove stays too.
 */
export const isDeletableBranch = (
  branch: string,
  records: ReadonlyArray<CleanupWorktree>,
  project: CleanupProject,
) => {
  if (branch === project.defaultBranch || project.foreignBranches.has(branch)) return false;
  const own = records.filter((worktree) => worktree.branch === branch);
  if (own.length === 0 || own.every((worktree) => worktree.branchDeletedAt !== null)) return false;
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
  const defaults = [`origin/${project.defaultBranch}`, project.defaultBranch];
  return worktree.kind === "extra" ? [worktree.baseRef, ...defaults] : defaults;
};
