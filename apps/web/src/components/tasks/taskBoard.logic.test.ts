import { EnvironmentId, ProjectId, TaskId, type Task, type TaskStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardColumns, chatCountLabel, DONE_COLUMN_LIMIT } from "./taskBoard.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");

function entry(
  id: string,
  status: TaskStatus,
  overrides: Partial<Pick<Task, "completedAt" | "archivedAt">> = {},
) {
  const task: Task = {
    id: TaskId.make(id),
    title: id,
    description: "",
    link: null,
    status,
    primaryProjectId: projectId,
    projectIds: [projectId],
    worktrees: [],
    threadIds: [],
    sortKey: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
  return { environmentId, task };
}

describe("boardColumns", () => {
  it("keeps only the latest finished tasks in Done and archived ones out of the board", () => {
    const done = Array.from({ length: DONE_COLUMN_LIMIT + 2 }, (_, index) =>
      entry(`done-${index}`, "done", {
        completedAt: new Date(Date.UTC(2026, 10, 1, index)).toISOString(),
      }),
    );
    const archived = entry("archived", "review", { archivedAt: "2026-11-03T00:00:00.000Z" });
    const columns = boardColumns([...done, archived], {}, { archived: false });
    const doneColumn = columns.find((column) => column.status === "done")!;
    expect(doneColumn.total).toBe(DONE_COLUMN_LIMIT + 2);
    expect(doneColumn.entries.map(({ task }) => task.id)).not.toContain("done-0");
    expect(doneColumn.entries.map(({ task }) => task.id)).not.toContain("done-1");
    expect(columns.find((column) => column.status === "review")!.entries).toEqual([]);

    const archive = boardColumns([...done, archived], {}, { archived: true });
    expect(archive.find((column) => column.status === "review")!.entries).toEqual([archived]);
    expect(archive.find((column) => column.status === "done")!.entries).toEqual([]);
  });
});

describe("chatCountLabel", () => {
  it.each([
    [1, "1 thread"],
    [3, "3 threads"],
    [21, "21 threads"],
  ])("%i", (count, label) => {
    expect(chatCountLabel(count)).toBe(label);
  });
});
