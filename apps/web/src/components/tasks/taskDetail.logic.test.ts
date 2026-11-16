import {
  ProjectId,
  TaskId,
  ThreadId,
  type ReviewDiffPreviewResult,
  type Task,
  type TaskWorktree,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { groupTaskThreads, worktreeDiffInputs, worktreeDiffStat } from "./taskDetail.logic";

const backend = ProjectId.make("project-backend");
const frontend = ProjectId.make("project-frontend");

const worktree = (overrides: Partial<TaskWorktree> & Pick<TaskWorktree, "branch">) =>
  ({
    projectId: backend,
    baseRef: "origin/main",
    kind: "shared",
    worktreePath: `/work/wt/${overrides.branch}`,
    removedAt: null,
    branchDeletedAt: null,
    ...overrides,
  }) satisfies TaskWorktree;

const shell = (id: string, projectId: ProjectId, branch: string | null) => ({
  id: ThreadId.make(id),
  projectId,
  branch,
});

const makeTask = (overrides: Partial<Task>): Task => ({
  id: TaskId.make("task:pay"),
  title: "Оплата картой",
  description: "",
  link: null,
  status: "in_progress",
  primaryProjectId: backend,
  projectIds: [backend],
  worktrees: [],
  threadIds: [],
  sortKey: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  startedAt: "2026-11-02T00:00:00.000Z",
  completedAt: null,
  archivedAt: null,
  ...overrides,
});

describe("groupTaskThreads", () => {
  it("puts chats under the worktree whose project and branch they share, the extra one after the shared", () => {
    const shared = worktree({ branch: "task/card-pay" });
    const extra = worktree({ branch: "card-pay-retry", kind: "extra", baseRef: "task/card-pay" });
    const plan = shell("thread-plan", backend, "task/card-pay");
    const api = shell("thread-api", backend, "task/card-pay");
    const retry = shell("thread-retry", backend, "card-pay-retry");
    const task = makeTask({
      // Stored out of order: the extra worktree was recorded first.
      worktrees: [extra, shared],
      threadIds: [plan.id, retry.id, api.id],
    });

    expect(groupTaskThreads(task, [api, retry, plan], new Set([backend]))).toEqual([
      {
        projectId: backend,
        available: true,
        worktrees: [
          { worktree: shared, threads: [plan, api] },
          { worktree: extra, threads: [retry] },
        ],
        rootThreads: [],
      },
    ]);
  });

  it("keeps a chat in the project root, and one on a branch the task does not track, as root chats", () => {
    const shared = worktree({ branch: "task/card-pay" });
    const root = shell("thread-root", backend, null);
    const elsewhere = shell("thread-elsewhere", backend, "feature/other");
    // Same branch name in another repository is not this worktree.
    const otherRepo = shell("thread-front", frontend, "task/card-pay");
    const task = makeTask({
      projectIds: [backend, frontend],
      worktrees: [shared],
      threadIds: [root.id, elsewhere.id, otherRepo.id],
    });

    const groups = groupTaskThreads(
      task,
      [root, elsewhere, otherRepo],
      new Set([backend, frontend]),
    );

    expect(groups.map((group) => group.projectId)).toEqual([backend, frontend]);
    expect(groups[0]!.worktrees).toEqual([{ worktree: shared, threads: [] }]);
    expect(groups[0]!.rootThreads).toEqual([root, elsewhere]);
    expect(groups[1]!.rootThreads).toEqual([otherRepo]);
  });

  it("marks a project this client cannot see as unavailable and starts from the primary one", () => {
    const shared = worktree({ projectId: frontend, branch: "task/card-pay" });
    const task = makeTask({
      primaryProjectId: frontend,
      projectIds: [backend, frontend],
      worktrees: [shared],
    });

    const groups = groupTaskThreads(task, [], new Set([frontend]));

    expect(groups.map(({ projectId, available }) => ({ projectId, available }))).toEqual([
      { projectId: frontend, available: true },
      { projectId: backend, available: false },
    ]);
  });

  it("ignores chats that are not the task's", () => {
    const task = makeTask({ threadIds: [] });
    expect(groupTaskThreads(task, [shell("stray", backend, null)], new Set([backend]))).toEqual([
      { projectId: backend, available: true, worktrees: [], rootThreads: [] },
    ]);
  });
});

describe("worktree diff", () => {
  it("reads committed and uncommitted changes of a live worktree, nothing of a removed one", () => {
    const live = worktree({ branch: "task/card-pay" });
    expect(worktreeDiffInputs(live)).toEqual({
      branch: { cwd: "/work/wt/task/card-pay", baseRef: "origin/main", sourceKind: "branch-range" },
      workingTree: { cwd: "/work/wt/task/card-pay", sourceKind: "working-tree" },
    });
    expect(worktreeDiffInputs({ ...live, removedAt: "2026-11-03T00:00:00.000Z" })).toBeNull();
    expect(worktreeDiffInputs({ ...live, worktreePath: null })).toBeNull();
  });

  it("sums both sources once either has loaded", () => {
    const preview = (
      kind: "branch-range" | "working-tree",
      stats: ReadonlyArray<[number, number]>,
    ): ReviewDiffPreviewResult => ({
      cwd: "/work/wt",
      generatedAt: DateTime.makeUnsafe(0),
      sources: [
        {
          id: kind,
          kind,
          title: kind,
          baseRef: null,
          headRef: null,
          diff: "",
          diffHash: "hash",
          truncated: false,
          files: stats.map(([additions, deletions], index) => ({
            path: `file-${index}`,
            previousPath: null,
            additions,
            deletions,
          })),
        },
      ],
    });
    expect(worktreeDiffStat([null, null])).toBeNull();
    expect(worktreeDiffStat([preview("branch-range", []), null])).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(
      worktreeDiffStat([
        preview("branch-range", [
          [200, 30],
          [40, 1],
        ]),
        preview("working-tree", [[5, 2]]),
      ]),
    ).toEqual({ additions: 245, deletions: 33 });
  });
});
