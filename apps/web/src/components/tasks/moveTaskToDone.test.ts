import {
  EnvironmentId,
  ProjectId,
  TaskId,
  type Task,
  type TaskCleanupMode,
  type TaskCleanupPreview,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: { add: (toast: unknown) => toasts.push(toast) },
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: () => undefined }));

import { moveTaskToDone, type MoveTaskToDoneDeps } from "./moveTaskToDone";

const environmentId = EnvironmentId.make("local");
const backend = ProjectId.make("project-backend");
const task: Task = {
  id: TaskId.make("task:pay"),
  title: "Оплата картой",
  description: "",
  link: null,
  status: "review",
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
};
const preview: TaskCleanupPreview = {
  worktrees: [
    { projectId: backend, path: "/work/clean", branch: "task/pay", dirtyFileCount: 0 },
    { projectId: backend, path: "/work/dirty", branch: "pay-retry", dirtyFileCount: 2 },
  ],
  branches: [],
};

function setup(statusFails = false) {
  toasts.length = 0;
  const deps = {
    setTaskStatus: vi.fn<MoveTaskToDoneDeps["setTaskStatus"]>(async () =>
      statusFails
        ? AsyncResult.failure(Cause.fail(new Error("offline")))
        : AsyncResult.success({ task: { ...task, status: "done" } }),
    ),
    previewTaskCleanup: vi.fn<MoveTaskToDoneDeps["previewTaskCleanup"]>(async () =>
      AsyncResult.success(preview),
    ),
    cleanupTask: vi.fn<MoveTaskToDoneDeps["cleanupTask"]>(async () =>
      AsyncResult.success({ task, removedWorktrees: 1, deletedBranches: 0 }),
    ),
    openCleanupDialog: vi.fn<MoveTaskToDoneDeps["openCleanupDialog"]>(),
  };
  const run = (cleanupMode: TaskCleanupMode) =>
    moveTaskToDone({ environmentId, task, cleanupMode, deps });
  return { deps, run };
}

describe("moveTaskToDone", () => {
  it("only moves the task when cleanup is off", async () => {
    const { deps, run } = setup();
    expect((await run("never"))._tag).toBe("Success");
    expect(deps.setTaskStatus).toHaveBeenCalledWith({
      environmentId,
      input: { id: task.id, status: "done" },
    });
    expect(deps.previewTaskCleanup).not.toHaveBeenCalled();
  });

  it("checks nothing when the move fails", async () => {
    const { deps, run } = setup(true);
    expect((await run("ask"))._tag).toBe("Failure");
    expect(deps.previewTaskCleanup).not.toHaveBeenCalled();
    expect(deps.openCleanupDialog).not.toHaveBeenCalled();
  });

  it("asks about everything in ask mode", async () => {
    const { deps, run } = setup();
    await run("ask");
    expect(deps.cleanupTask).not.toHaveBeenCalled();
    expect(deps.openCleanupDialog).toHaveBeenCalledWith({
      environmentId,
      task,
      preview,
      offerAlways: true,
    });
  });

  it("removes the clean worktree silently and asks only about the dirty one in always mode", async () => {
    const { deps, run } = setup();
    await run("always");
    expect(deps.cleanupTask).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        id: task.id,
        worktrees: [{ path: "/work/clean", acceptedDirtyFileCount: 0 }],
        branches: [],
      },
    });
    expect(toasts).toEqual([
      expect.objectContaining({ type: "success", title: "Удалено 1 worktree, 0 веток" }),
    ]);
    expect(deps.openCleanupDialog).toHaveBeenCalledWith({
      environmentId,
      task,
      preview: { worktrees: [preview.worktrees[1]], branches: [] },
      offerAlways: false,
    });
  });
});
