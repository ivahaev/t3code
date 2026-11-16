import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  TaskId,
  type Task,
  type TaskListResult,
  type TaskStatus,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-backend");

const state = vi.hoisted(() => ({
  list: null as unknown,
  command: vi.fn<(label: string, request: unknown) => Promise<unknown>>(),
}));

// The board reads its tasks from one subscription per environment; the test feeds that atom.
vi.mock(import("~/state/tasks"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (label: string) => ({ label, permissionAtom: () => allowed });
  return {
    tasksEnvironment: {
      tasksLive: () => Atom.make(state.list),
      upsertTask: command("upsert"),
      setTaskStatus: command("set-status"),
      deleteTask: command("delete"),
      archiveTask: command("archive"),
      unarchiveTask: command("unarchive"),
      startTask: command("start"),
      previewTaskCleanup: command("cleanup-preview"),
      cleanupTask: command("cleanup"),
      setTaskCleanupMode: command("set-cleanup-mode"),
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) => (request: unknown) =>
    state.command(command.label, request)) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useConnectedEnvironmentIds: (() => [environmentId]) as never,
  useEnvironments: (() => ({
    environments: [{ environmentId, label: "Local" }],
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    {
      id: projectId,
      environmentId,
      title: "backend",
      workspaceRoot: "/work/backend",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  ]) as never,
  useThreadShells: () => [],
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { TaskBoard } from "./TaskBoard";

function task(id: string, title: string, status: TaskStatus, sortKey: number): Task {
  return {
    id: TaskId.make(id),
    title,
    description: "",
    link: null,
    status,
    primaryProjectId: projectId,
    projectIds: [projectId],
    worktrees: [],
    threadIds: [],
    sortKey,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    startedAt: status === "backlog" ? null : "2026-11-02T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
  };
}

function setup() {
  vi.clearAllMocks();
  const list: TaskListResult = {
    tasks: [
      task("task:dark", "Тёмная тема", "backlog", 1),
      task("task:pay", "Оплата картой", "in_progress", 1),
      task("task:auth", "Рефакторинг auth", "review", 1),
    ],
    settings: { cleanupMode: "ask" },
  };
  state.list = AsyncResult.success(list);
  state.command.mockResolvedValue(AsyncResult.success({ task: list.tasks[1] }));
}

describe("TaskBoard", () => {
  it("lays tasks out by status and moves one to review from its menu", async () => {
    setup();
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <TaskBoard search={{}} />
      </RegistryContext.Provider>,
    );

    const column = (name: string) => screen.getByRole("region", { name, exact: false });
    await expect.element(column("Бэклог").getByText("Тёмная тема")).toBeVisible();
    await expect.element(column("В работе").getByText("Оплата картой")).toBeVisible();
    await expect.element(column("Ревью").getByText("Рефакторинг auth")).toBeVisible();
    await expect.element(column("Готово")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Действия: Оплата картой" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Перенести в Ревью" }));

    expect(state.command).toHaveBeenCalledWith("set-status", {
      environmentId,
      input: { id: TaskId.make("task:pay"), status: "review" },
    });
  });

  it("moves a focused card with the bracket keys by their physical position", async () => {
    setup();
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <TaskBoard search={{}} />
      </RegistryContext.Provider>,
    );

    const card = screen.getByRole("article", { name: "Оплата картой" });
    await expect.element(card).toBeVisible();
    (card.element() as HTMLElement).focus();
    // A Russian layout types "Ъ" on this key; the shortcut follows the key, not the letter.
    card
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ъ", code: "BracketRight", bubbles: true }),
      );

    expect(state.command).toHaveBeenCalledWith("set-status", {
      environmentId,
      input: { id: TaskId.make("task:pay"), status: "review" },
    });
  });
});
