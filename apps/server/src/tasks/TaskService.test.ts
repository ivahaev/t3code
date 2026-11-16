import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  type TaskError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskService from "./TaskService.ts";
import * as TaskStore from "./TaskStore.ts";

const p1 = ProjectId.make("p1");
const p2 = ProjectId.make("p2");

const shell = (
  id: string,
  fields: { projectId: ProjectId; worktreePath?: string | null; branch?: string | null },
) =>
  ({
    id: ThreadId.make(id),
    projectId: fields.projectId,
    worktreePath: fields.worktreePath ?? null,
    branch: fields.branch ?? null,
    deletedAt: null,
    archivedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map<string, OrchestrationV2ThreadShell>([
  ["th-x", shell("th-x", { projectId: p2, worktreePath: "/wt/x", branch: "feat/x" })],
  ["th-plain", shell("th-plain", { projectId: p1 })],
]);

// Every test gets its own launch recorder, so launches never leak between tests.
const makeTestLayer = () => {
  const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const layer = TaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TaskStore.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          checkWorktreeBase: () => Effect.void,
          launch: (input) =>
            Effect.sync(() => {
              launches.push(input);
              const strategy = input.workspaceStrategy;
              return {
                threadId: ThreadId.make(`launched-${input.commandId}`),
                resumed: false,
                projection: {
                  thread: { branch: strategy.type === "root" ? null : (strategy.branch ?? null) },
                } as unknown as OrchestrationV2ThreadProjection,
              };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeedSome({ id: projectId, workspaceRoot: `/repo/${projectId}` } as Project),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          resolveDefaultBranchName: () => Effect.succeed("main"),
          listLocalBranchNames: () => Effect.succeed(["main"]),
        }),
      ),
    ),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  return { layer, launches };
};

const testLayer = makeTestLayer().layer;

const launchOptions = {
  modelSelection: { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

const newTask = Effect.fn(function* (title: string = "Task") {
  const tasks = yield* TaskService.TaskService;
  const result = yield* tasks.upsert({
    title,
    description: "",
    link: null,
    primaryProjectId: p1,
    projectIds: [p1],
  });
  return result.task;
});

it.effect("upsert creates a backlog task that appears in list", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask();
    assert.strictEqual(task.status, "backlog");
    const listed = yield* tasks.list();
    assert.deepStrictEqual(
      listed.tasks.map((t) => t.id),
      [task.id],
    );
    assert.strictEqual(listed.settings.cleanupMode, "ask");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("setStatus done sets completedAt and leaving done clears it", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask();
    const done = (yield* tasks.setStatus({ id: task.id, status: "done" })).task;
    assert.notStrictEqual(done.completedAt, null);
    assert.notStrictEqual(done.startedAt, null);
    const review = (yield* tasks.setStatus({ id: task.id, status: "review" })).task;
    assert.strictEqual(review.completedAt, null);
    assert.strictEqual(review.startedAt, done.startedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("setStatus places the task after the column's last card by default", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const a = yield* newTask("A");
    const b = yield* newTask("B");
    const movedA = (yield* tasks.setStatus({ id: a.id, status: "review", sortKey: 10 })).task;
    const movedB = (yield* tasks.setStatus({ id: b.id, status: "review" })).task;
    assert.strictEqual(movedA.sortKey, 10);
    assert.strictEqual(movedB.sortKey, 11);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("subscribeList emits a snapshot, then the new list after upsert", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    // The change happens once the snapshot is out, so the subscription already exists.
    const emitted = yield* tasks.subscribeList().pipe(
      Stream.tap((result) => (result.tasks.length === 0 ? newTask() : Effect.void)),
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepStrictEqual(
      Array.from(emitted).map((result) => result.tasks.length),
      [0, 1],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("attachThread adds the thread's project and its worktree as extra", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask();
    const attached = (yield* tasks.attachThread({
      id: task.id,
      threadId: ThreadId.make("th-x"),
      moveFromOtherTask: false,
    })).task;
    assert.deepStrictEqual(attached.projectIds, [p1, p2]);
    assert.deepStrictEqual(attached.threadIds, [ThreadId.make("th-x")]);
    assert.deepStrictEqual(attached.worktrees, [
      {
        projectId: p2,
        branch: "feat/x",
        baseRef: "origin/main",
        kind: "extra",
        worktreePath: "/wt/x",
        removedAt: null,
        branchDeletedAt: null,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("attachThread refuses a thread of another task unless moving it", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const first = yield* newTask("First");
    const second = yield* newTask("Second");
    const threadId = ThreadId.make("th-plain");
    yield* tasks.attachThread({ id: first.id, threadId, moveFromOtherTask: false });
    const error: TaskError = yield* Effect.flip(
      tasks.attachThread({ id: second.id, threadId, moveFromOtherTask: false }),
    );
    assert.strictEqual(error.code, "already_attached");
    yield* TestClock.adjust("1 minute");
    yield* tasks.attachThread({ id: second.id, threadId, moveFromOtherTask: true });
    const listed = (yield* tasks.list()).tasks;
    const movedFrom = listed.find((t) => t.id === first.id);
    assert.deepStrictEqual(movedFrom?.threadIds, []);
    assert.notStrictEqual(movedFrom?.updatedAt, first.updatedAt);
    assert.deepStrictEqual(listed.find((t) => t.id === second.id)?.threadIds, [threadId]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("removeThread drops a deleted thread and notifies subscribers", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const store = yield* TaskStore.TaskStore;
    const task = yield* newTask();
    const kept = ThreadId.make("th-plain");
    const deleted = ThreadId.make("th-gone");
    yield* store.update({ ...task, threadIds: [kept, deleted] });
    // The removal happens once the snapshot is out, so the subscription already exists.
    const emitted = yield* tasks.subscribeList().pipe(
      Stream.tap((result) =>
        result.tasks[0]?.threadIds.length === 2 ? tasks.removeThread(deleted) : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepStrictEqual(
      Array.from(emitted).map((result) => result.tasks[0]?.threadIds),
      [[kept, deleted], [kept]],
    );
    assert.strictEqual(yield* store.findTaskByThread(deleted), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("detachThread, archive, unarchive, addProject, setCleanupMode and delete", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask();
    const threadId = ThreadId.make("th-plain");
    yield* tasks.attachThread({ id: task.id, threadId, moveFromOtherTask: false });
    assert.deepStrictEqual(
      (yield* tasks.detachThread({ id: task.id, threadId })).task.threadIds,
      [],
    );
    assert.notStrictEqual((yield* tasks.archive({ id: task.id })).task.archivedAt, null);
    assert.strictEqual((yield* tasks.unarchive({ id: task.id })).task.archivedAt, null);
    assert.deepStrictEqual(
      (yield* tasks.addProject({ id: task.id, projectId: p2 })).task.projectIds,
      [p1, p2],
    );
    assert.deepStrictEqual(yield* tasks.setCleanupMode({ mode: "always" }), { mode: "always" });
    assert.strictEqual((yield* tasks.list()).settings.cleanupMode, "always");
    yield* tasks.delete({ id: task.id });
    assert.deepStrictEqual((yield* tasks.list()).tasks, []);
    const missing: TaskError = yield* Effect.flip(tasks.archive({ id: task.id }));
    assert.strictEqual(missing.code, "not_found");
  }).pipe(Effect.provide(testLayer)),
);

it("resolveTaskProjects marks projects missing from the environment unavailable", () => {
  assert.deepStrictEqual(TaskService.resolveTaskProjects({ projectIds: [p1, p2] }, [p1]), [
    { projectId: p1, available: true },
    { projectId: p2, available: false },
  ]);
});

it.effect(
  "start launches the first thread in a task worktree and marks the task in progress",
  () => {
    const { layer, launches } = makeTestLayer();
    return Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      const task = yield* newTask("Оплата картой");
      const started = yield* tasks.start({
        id: task.id,
        commandId: CommandId.make("start-1"),
        ...launchOptions,
      });
      assert.strictEqual(launches.length, 1);
      const launch = launches[0]!;
      assert.strictEqual(launch.projectId, p1);
      assert.strictEqual(launch.title, "Оплата картой");
      assert.deepStrictEqual(launch.workspaceStrategy, {
        type: "worktree",
        baseRef: "origin/main",
        branch: "task/oplata-kartoj",
        startFromOrigin: true,
      });
      assert.isTrue(launch.initialMessage?.text.startsWith("Оплата картой"));
      assert.strictEqual(started.threadId, ThreadId.make("launched-start-1"));
      assert.strictEqual(started.task.status, "in_progress");
      assert.deepStrictEqual(started.task.threadIds, [started.threadId]);
      assert.deepStrictEqual(started.task.worktrees, [
        {
          projectId: p1,
          branch: "task/oplata-kartoj",
          baseRef: "origin/main",
          kind: "shared",
          worktreePath: null,
          removedAt: null,
          branchDeletedAt: null,
        },
      ]);

      // Review Focus 2: a started task only changes status again.
      yield* tasks.setStatus({ id: task.id, status: "review" });
      const again = yield* tasks.start({
        id: task.id,
        commandId: CommandId.make("start-2"),
        ...launchOptions,
      });
      assert.strictEqual(launches.length, 1);
      assert.strictEqual(again.threadId, started.threadId);
      assert.strictEqual(again.task.status, "in_progress");
      assert.deepStrictEqual(again.task.worktrees, started.task.worktrees);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("newThread waits for the shared worktree path, then reuses it", () => {
  const { layer, launches } = makeTestLayer();
  return Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask("Shared path");
    const started = yield* tasks.start({
      id: task.id,
      commandId: CommandId.make("shared-start"),
      ...launchOptions,
    });
    const request = {
      id: task.id,
      projectId: p1,
      workspace: "shared",
      text: "Second agent",
      ...launchOptions,
    } as const;

    // Review Focus 1: the shared worktree exists, but no thread knows its path yet.
    const preparing: TaskError = yield* Effect.flip(
      tasks.newThread({ ...request, commandId: CommandId.make("shared-early") }),
    );
    assert.strictEqual(preparing.code, "worktree_preparing");
    assert.strictEqual(launches.length, 1);

    shells.set(
      started.threadId,
      shell(started.threadId, {
        projectId: p1,
        worktreePath: "/wt/shared",
        branch: "task/shared-path",
      }),
    );
    const second = yield* tasks.newThread({ ...request, commandId: CommandId.make("shared-2") });
    assert.strictEqual(launches.length, 2);
    assert.deepStrictEqual(launches[1]!.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/wt/shared",
      branch: "task/shared-path",
    });
    assert.strictEqual(launches[1]!.initialMessage?.text, "Second agent");
    assert.deepStrictEqual(second.task.threadIds, [started.threadId, second.threadId]);
    assert.strictEqual(second.task.worktrees[0]?.worktreePath, "/wt/shared");
  }).pipe(Effect.provide(layer));
});

it.effect("newThread extra branches off the shared worktree's branch", () => {
  const { layer, launches } = makeTestLayer();
  return Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask("Extra work");
    const started = yield* tasks.start({
      id: task.id,
      commandId: CommandId.make("extra-start"),
      ...launchOptions,
    });
    shells.set(
      started.threadId,
      shell(started.threadId, {
        projectId: p1,
        worktreePath: "/wt/extra",
        branch: "task/extra-work",
      }),
    );
    const extra = yield* tasks.newThread({
      id: task.id,
      commandId: CommandId.make("extra-1"),
      projectId: p1,
      workspace: "extra",
      text: "Try another way",
      ...launchOptions,
    });
    const strategy = launches[1]!.workspaceStrategy;
    assert.strictEqual(strategy.type, "worktree");
    if (strategy.type !== "worktree") return;
    assert.strictEqual(strategy.baseRef, "task/extra-work");
    assert.strictEqual(strategy.startFromOrigin, false);
    assert.isTrue(strategy.branch?.startsWith("task/extra-work-"));
    const recorded = extra.task.worktrees.find((worktree) => worktree.kind === "extra");
    assert.deepStrictEqual(recorded, {
      projectId: p1,
      branch: strategy.branch!,
      baseRef: "task/extra-work",
      kind: "extra",
      worktreePath: null,
      removedAt: null,
      branchDeletedAt: null,
    });
    assert.deepStrictEqual(extra.task.threadIds, [started.threadId, extra.threadId]);
  }).pipe(Effect.provide(layer));
});

it.effect("newThread in a new project opens its shared worktree; root records no worktree", () => {
  const { layer, launches } = makeTestLayer();
  return Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask("Cross repo");
    const shared = yield* tasks.newThread({
      id: task.id,
      commandId: CommandId.make("cross-1"),
      projectId: p2,
      workspace: "shared",
      text: "Do it in p2",
      ...launchOptions,
    });
    assert.deepStrictEqual(launches[0]!.workspaceStrategy, {
      type: "worktree",
      baseRef: "origin/main",
      branch: "task/cross-repo",
      startFromOrigin: true,
    });
    assert.deepStrictEqual(shared.task.projectIds, [p1, p2]);
    assert.deepStrictEqual(
      shared.task.worktrees.map((worktree) => [worktree.projectId, worktree.kind]),
      [[p2, "shared"]],
    );
    const root = yield* tasks.newThread({
      id: task.id,
      commandId: CommandId.make("cross-root"),
      projectId: p1,
      workspace: "root",
      text: "At the root",
      ...launchOptions,
    });
    assert.deepStrictEqual(launches[1]!.workspaceStrategy, { type: "root" });
    assert.strictEqual(root.task.worktrees.length, 1);
    assert.deepStrictEqual(root.task.threadIds, [shared.threadId, root.threadId]);
  }).pipe(Effect.provide(layer));
});

it.effect("newThread extra without a shared worktree starts the shared one first", () => {
  const { layer, launches } = makeTestLayer();
  return Effect.gen(function* () {
    const tasks = yield* TaskService.TaskService;
    const task = yield* newTask("No shared yet");
    const error: TaskError = yield* Effect.flip(
      tasks.newThread({
        id: task.id,
        commandId: CommandId.make("extra-first"),
        projectId: p1,
        workspace: "extra",
        text: "Side quest",
        ...launchOptions,
      }),
    );
    assert.strictEqual(error.code, "worktree_preparing");
    assert.strictEqual(launches.length, 1);
    assert.deepStrictEqual(launches[0]!.workspaceStrategy, {
      type: "worktree",
      baseRef: "origin/main",
      branch: "task/no-shared-yet",
      startFromOrigin: true,
    });
    const [listed] = (yield* tasks.list()).tasks;
    assert.deepStrictEqual(
      listed?.worktrees.map((worktree) => worktree.kind),
      ["shared"],
    );
    assert.strictEqual(listed?.threadIds.length, 1);
  }).pipe(Effect.provide(layer));
});
