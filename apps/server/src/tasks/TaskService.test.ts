import { assert, it } from "@effect/vitest";
import {
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

const testLayer = TaskService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TaskStore.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({ id: projectId, workspaceRoot: `/repo/${projectId}` } as Project),
      }),
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        resolveDefaultBranchName: () => Effect.succeed("main"),
      }),
    ),
  ),
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

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
