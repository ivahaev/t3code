import { ProjectId, TaskId, ThreadId, type Task, type TaskWorktree } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { liveTaskWorktreePaths, taskChipLabel, threadTaskIndex } from "./threadTask.logic";

const backend = ProjectId.make("project-backend");

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
  title: "Card payments",
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

describe("liveTaskWorktreePaths", () => {
  it("lists the worktrees no cleanup removed yet", () => {
    const task = makeTask({
      worktrees: [
        taskWorktree({}),
        taskWorktree({ worktreePath: "/work/wt/gone", removedAt: "2026-11-03T00:00:00.000Z" }),
        taskWorktree({ worktreePath: null }),
      ],
    });
    expect(liveTaskWorktreePaths([task], [])).toEqual(["/work/wt/card-pay"]);
  });

  it("keeps a chat's worktree while its task waits for the path", () => {
    const chat = ThreadId.make("thread-a");
    const task = makeTask({ threadIds: [chat], worktrees: [taskWorktree({ worktreePath: null })] });
    const thread = (id: ThreadId, branch: string) => ({
      id,
      projectId: backend,
      branch,
      worktreePath: `/work/wt/${id}`,
    });
    expect(
      liveTaskWorktreePaths(
        [task],
        [
          thread(chat, "task/card-pay"),
          thread(ThreadId.make("thread-other"), "task/card-pay"),
          { ...thread(chat, "feat/other"), id: ThreadId.make("thread-b") },
        ],
      ),
    ).toEqual(["/work/wt/thread-a"]);
  });
});

describe("threadTaskIndex", () => {
  it("maps each task chat to its task", () => {
    const task = makeTask({ threadIds: [ThreadId.make("thread-a"), ThreadId.make("thread-b")] });
    const index = threadTaskIndex([task]);
    expect(index.get(ThreadId.make("thread-b"))).toBe(task);
    expect(index.get(ThreadId.make("thread-c"))).toBeUndefined();
  });
});

describe("taskChipLabel", () => {
  it("keeps short titles and cuts long ones to 12 characters", () => {
    expect(taskChipLabel("Payments")).toBe("Payments");
    expect(taskChipLabel("Card payments")).toBe("Card paymen…");
    expect(Array.from(taskChipLabel("Card payments in the app"))).toHaveLength(12);
  });
});
