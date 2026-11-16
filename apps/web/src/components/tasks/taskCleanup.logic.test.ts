import {
  ProjectId,
  TaskId,
  type Task,
  type TaskCleanupPreview,
  type TaskWorktree,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoCleanupPlan,
  cleanupBranchKey,
  cleanupSelectionInput,
  cleanupSummary,
  initialCleanupSelection,
  leavingDoneConfirmation,
  toggleBranch,
  toggleWorktree,
} from "./taskCleanup.logic";

const backend = ProjectId.make("project-backend");
const frontend = ProjectId.make("project-frontend");

type PreviewWorktree = TaskCleanupPreview["worktrees"][number];
type PreviewBranch = TaskCleanupPreview["branches"][number];

const wt = (projectId: ProjectId, branch: string, dirtyFileCount = 0): PreviewWorktree => ({
  projectId,
  branch,
  path: `/work/${projectId}/${branch}`,
  dirtyFileCount,
});
const br = (projectId: ProjectId, branch: string, unmergedCommitCount = 0): PreviewBranch => ({
  projectId,
  branch,
  merged: unmergedCommitCount === 0,
  unmergedCommitCount,
});

// The spec's dialog sketch: two clean backend worktrees, one dirty frontend one.
const preview: TaskCleanupPreview = {
  worktrees: [
    wt(backend, "task/card-pay"),
    wt(backend, "card-pay-retry"),
    wt(frontend, "task/card-pay", 3),
  ],
  branches: [
    br(backend, "task/card-pay"),
    br(backend, "card-pay-retry", 2),
    { ...br(frontend, "task/card-pay"), merged: false },
  ],
};

describe("initialCleanupSelection", () => {
  it("checks clean worktrees and merged branches, leaves dirty and unmerged ones", () => {
    const selection = initialCleanupSelection(preview);
    expect([...selection.worktrees]).toEqual([
      "/work/project-backend/task/card-pay",
      "/work/project-backend/card-pay-retry",
    ]);
    expect([...selection.branches]).toEqual([cleanupBranchKey(backend, "task/card-pay")]);
  });

  it("leaves a merged branch unchecked while its worktree is dirty", () => {
    const selection = initialCleanupSelection({
      worktrees: [wt(backend, "task/x", 1)],
      branches: [br(backend, "task/x")],
    });
    expect(selection.worktrees.size).toBe(0);
    expect(selection.branches.size).toBe(0);
  });
});

describe("toggleBranch", () => {
  it("checking a branch checks its worktree too", () => {
    const selection = toggleBranch(
      initialCleanupSelection(preview),
      preview,
      cleanupBranchKey(frontend, "task/card-pay"),
    );
    expect(selection.branches.has(cleanupBranchKey(frontend, "task/card-pay"))).toBe(true);
    expect(selection.worktrees.has("/work/project-frontend/task/card-pay")).toBe(true);
  });

  it("unchecking a branch keeps its worktree", () => {
    const key = cleanupBranchKey(backend, "task/card-pay");
    const selection = toggleBranch(initialCleanupSelection(preview), preview, key);
    expect(selection.branches.has(key)).toBe(false);
    expect(selection.worktrees.has("/work/project-backend/task/card-pay")).toBe(true);
  });
});

describe("toggleWorktree", () => {
  it("unchecking a worktree unchecks the branch it holds", () => {
    const selection = toggleWorktree(
      initialCleanupSelection(preview),
      preview,
      "/work/project-backend/task/card-pay",
    );
    expect(selection.worktrees.has("/work/project-backend/task/card-pay")).toBe(false);
    expect(selection.branches.has(cleanupBranchKey(backend, "task/card-pay"))).toBe(false);
  });
});

describe("cleanupSelectionInput", () => {
  it("forces only the unmerged branches", () => {
    let selection = initialCleanupSelection(preview);
    selection = toggleBranch(selection, preview, cleanupBranchKey(backend, "card-pay-retry"));
    expect(cleanupSelectionInput(preview, selection)).toEqual({
      worktreePaths: [
        "/work/project-backend/task/card-pay",
        "/work/project-backend/card-pay-retry",
      ],
      branches: [
        { projectId: backend, branch: "task/card-pay", force: false },
        { projectId: backend, branch: "card-pay-retry", force: true },
      ],
    });
  });
});

describe("autoCleanupPlan", () => {
  it("removes the clean worktree silently and asks only about the dirty one", () => {
    const plan = autoCleanupPlan({
      worktrees: [wt(backend, "task/a"), wt(backend, "b", 2)],
      branches: [],
    });
    expect(plan.silent).toEqual({ worktreePaths: ["/work/project-backend/task/a"], branches: [] });
    expect(plan.needsDialog).toEqual({ worktrees: [wt(backend, "b", 2)], branches: [] });
  });

  it("asks about unmerged branches and merged ones held by a dirty worktree", () => {
    const plan = autoCleanupPlan(preview);
    expect(plan.silent).toEqual({
      worktreePaths: [
        "/work/project-backend/task/card-pay",
        "/work/project-backend/card-pay-retry",
      ],
      branches: [{ projectId: backend, branch: "task/card-pay", force: false }],
    });
    expect(plan.needsDialog).toEqual({
      worktrees: [wt(frontend, "task/card-pay", 3)],
      branches: [
        br(backend, "card-pay-retry", 2),
        { ...br(frontend, "task/card-pay"), merged: false },
      ],
    });
  });

  it("needs no dialog when everything is clean and merged", () => {
    const plan = autoCleanupPlan({
      worktrees: [wt(backend, "task/a")],
      branches: [br(backend, "task/a")],
    });
    expect(plan.needsDialog).toBeNull();
    expect(plan.silent.branches).toEqual([{ projectId: backend, branch: "task/a", force: false }]);
  });
});

describe("cleanupSummary", () => {
  it.each([
    [1, 1, "Удалено 1 worktree, 1 ветка"],
    [2, 3, "Удалено 2 worktree, 3 ветки"],
    [0, 5, "Удалено 0 worktree, 5 веток"],
    [1, 11, "Удалено 1 worktree, 11 веток"],
    [1, 21, "Удалено 1 worktree, 21 ветка"],
  ])("%i worktree and %i branches", (worktrees, branches, text) => {
    expect(cleanupSummary(worktrees, branches)).toBe(text);
  });
});

const taskWorktree = (overrides: Partial<TaskWorktree>): TaskWorktree => ({
  projectId: backend,
  branch: "task/card-pay",
  baseRef: "origin/main",
  kind: "shared",
  worktreePath: "/work/wt/card-pay",
  removedAt: null,
  branchDeletedAt: null,
  ...overrides,
});

const makeTask = (overrides: Partial<Task>): Task => ({
  id: TaskId.make("task:pay"),
  title: "Оплата картой",
  description: "",
  link: null,
  status: "done",
  primaryProjectId: backend,
  projectIds: [backend],
  worktrees: [],
  threadIds: [],
  sortKey: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  startedAt: "2026-11-02T00:00:00.000Z",
  completedAt: "2026-11-03T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

describe("leavingDoneConfirmation", () => {
  const deleted = taskWorktree({ branchDeletedAt: "2026-11-03T00:00:00.000Z" });

  it("warns when a done task with a deleted shared branch moves back", () => {
    expect(leavingDoneConfirmation(makeTask({ worktrees: [deleted] }), "review")).toBe(
      "Ветка задачи удалена, новый чат создаст её заново от базы",
    );
  });

  it("stays quiet while the branch is kept, for an extra branch, or when not leaving Done", () => {
    expect(
      leavingDoneConfirmation(makeTask({ worktrees: [taskWorktree({})] }), "review"),
    ).toBeNull();
    expect(
      leavingDoneConfirmation(makeTask({ worktrees: [{ ...deleted, kind: "extra" }] }), "review"),
    ).toBeNull();
    expect(
      leavingDoneConfirmation(makeTask({ status: "review", worktrees: [deleted] }), "backlog"),
    ).toBeNull();
  });
});
