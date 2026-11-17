import {
  EnvironmentId,
  ProjectId,
  TaskId,
  ThreadId,
  type ReviewDiffPreviewResult,
  type Task,
  type TaskWorktree,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  attachCandidates,
  defaultNewThreadProject,
  groupTaskThreads,
  taskDiffTargets,
  taskStartBlocker,
  worktreeDiffState,
  worktreeDiffStat,
} from "./taskDetail.logic";

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
  title: "Card payments",
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

const environmentId = EnvironmentId.make("local");

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

describe("worktree diff", () => {
  it("reads committed and uncommitted changes of live worktrees only, and none without file access", () => {
    const live = worktree({ branch: "task/card-pay" });
    const removed = worktree({
      branch: "old",
      kind: "extra",
      removedAt: "2026-11-03T00:00:00.000Z",
    });
    const pathless = worktree({ branch: "new", kind: "extra", worktreePath: null });
    const task = makeTask({ worktrees: [live, removed, pathless] });

    expect(taskDiffTargets(environmentId, task, true)).toEqual({
      worktrees: [live],
      targets: [
        {
          environmentId,
          input: {
            cwd: "/work/wt/task/card-pay",
            baseRef: "origin/main",
            sourceKind: "branch-range",
          },
        },
        { environmentId, input: { cwd: "/work/wt/task/card-pay", sourceKind: "working-tree" } },
      ],
    });
    expect(taskDiffTargets(environmentId, task, false)).toEqual({ worktrees: [], targets: [] });
  });

  it("sums both sources once either has loaded", () => {
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

  it("keeps a loaded source when the other fails, and waits for both", () => {
    const loaded = AsyncResult.success(preview("branch-range", [[1, 1]]));
    const failed = AsyncResult.failure<ReviewDiffPreviewResult, string>(Cause.fail("no access"));
    const format = () => "no access";

    expect(worktreeDiffState(loaded, failed, format)).toEqual({
      branch: preview("branch-range", [[1, 1]]),
      workingTree: null,
      pending: false,
      errors: ["Uncommitted changes: no access"],
    });
    expect(worktreeDiffState(loaded, AsyncResult.initial(), format).pending).toBe(true);
  });
});

describe("task actions", () => {
  it("starts only from an available primary project and never in the archive", () => {
    const task = makeTask({ status: "backlog", projectIds: [backend, frontend] });
    expect(taskStartBlocker(task, new Set([backend]))).toBeNull();
    expect(taskStartBlocker(task, new Set([frontend]))).toBe(
      "The task's main project isn't available in this environment.",
    );
    expect(
      taskStartBlocker({ ...task, archivedAt: "2026-11-03T00:00:00.000Z" }, new Set([backend])),
    ).toBe("The task is archived.");
  });

  it("opens a new chat in the primary project, another available one, or none", () => {
    const task = makeTask({ projectIds: [backend, frontend] });
    expect(defaultNewThreadProject(task, new Set([backend, frontend]))).toBe(backend);
    expect(defaultNewThreadProject(task, new Set([frontend]))).toBe(frontend);
    expect(defaultNewThreadProject(task, new Set())).toBeNull();
  });

  it("finds chats to attach by title, branch or project, leaving out the task's and deleted ones", () => {
    const chat = (id: string, title: string, branch: string | null, updatedAt: string) => ({
      ...shell(id, backend, branch),
      title,
      updatedAt,
      deletedAt: null as string | null,
    });
    const own = chat("own", "Payments API", null, "2026-11-05");
    const deleted = {
      ...chat("deleted", "Payments UI", null, "2026-11-05"),
      deletedAt: "2026-11-06",
    };
    const older = chat("older", "Retries", "pay-retry", "2026-11-01");
    const newer = chat("newer", "Other", null, "2026-11-04");
    const task = makeTask({ threadIds: [own.id] });
    const shells = [own, deleted, older, newer];
    const projectTitles = new Map([[backend, "backend"]]);

    expect(attachCandidates(shells, { task, query: "", projectTitles, limit: 10 })).toEqual([
      newer,
      older,
    ]);
    expect(attachCandidates(shells, { task, query: " RETRY ", projectTitles, limit: 10 })).toEqual([
      older,
    ]);
    expect(attachCandidates(shells, { task, query: "back", projectTitles, limit: 1 })).toEqual([
      newer,
    ]);
  });
});
