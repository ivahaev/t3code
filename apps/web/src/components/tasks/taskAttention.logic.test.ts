import { TaskId, ProjectId } from "@t3tools/contracts";
import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderCardThreads,
  sortColumn,
  taskAttention,
  taskAttentionStatus,
  threadRowStatus,
} from "./taskAttention.logic";

const idle = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestRun: null,
  lastVisitedAt: null,
  runtime: null,
};
const working = {
  ...idle,
  runtime: {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: "codex",
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  },
};
const input = { ...idle, hasPendingUserInput: true };

const makeTask = (id: string, sortKey: number): Task => ({
  id: TaskId.make(id),
  title: id as Task["title"],
  description: "",
  link: null,
  status: "in_progress",
  primaryProjectId: ProjectId.make("p"),
  projectIds: [],
  worktrees: [],
  threadIds: [],
  sortKey,
  createdAt: "2026-03-09T10:00:00.000Z" as Task["createdAt"],
  updatedAt: "2026-03-09T10:00:00.000Z" as Task["updatedAt"],
  startedAt: null,
  completedAt: null,
  archivedAt: null,
});

describe("taskAttention", () => {
  it("is null without threads", () => {
    expect(taskAttention([])).toBeNull();
  });
  it("prefers attention over working", () => {
    expect(taskAttention([working as never, input as never])).toBe("attention");
  });
});

describe("taskAttentionStatus", () => {
  it("shows the most urgent thread's status in the sidebar's words", () => {
    expect(taskAttentionStatus([working as never, input as never])?.label).toBe("Input");
    expect(taskAttentionStatus([working as never])?.label).toBe("Working");
    expect(taskAttentionStatus([idle as never])).toBeNull();
  });
});

describe("orderCardThreads", () => {
  it("puts threads that need the user first, then the newest", () => {
    const rows = [
      { ...idle, id: "old", updatedAt: "2026-03-09T09:00:00.000Z" },
      { ...working, id: "busy", updatedAt: "2026-03-09T08:00:00.000Z" },
      { ...idle, id: "new", updatedAt: "2026-03-09T11:00:00.000Z" },
      { ...input, id: "asks", updatedAt: "2026-03-09T07:00:00.000Z" },
    ];
    const ordered = orderCardThreads(
      rows.map((thread) => ({ thread, status: threadRowStatus(thread as never) })),
    );
    expect(ordered.map(({ thread }) => thread.id)).toEqual(["asks", "busy", "new", "old"]);
  });
});

describe("sortColumn", () => {
  it("puts flagged tasks first, then by sortKey", () => {
    const a = makeTask("a", 1);
    const b = makeTask("b", 5);
    const c = makeTask("c", 3);
    const d = makeTask("d", 0);
    const result = sortColumn([a, b, c, d], { b: "attention", d: "working" });
    expect(result.map((t) => t.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("treats unread as flagged", () => {
    const a = makeTask("a", 1);
    const b = makeTask("b", 5);
    expect(sortColumn([a, b], { b: "unread" })[0]?.id).toBe(b.id);
  });
});
