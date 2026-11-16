import { assert, it } from "@effect/vitest";
import { type Task, TaskId, ProjectId, ThreadId, type TaskWorktree } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { TaskStore, layer } from "./TaskStore.ts";

const sqlLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.provideMerge(layer, sqlLayer);

const worktree = (projectId: string, branch: string): TaskWorktree => ({
  projectId: ProjectId.make(projectId),
  branch,
  baseRef: "origin/main",
  kind: "shared",
  worktreePath: "/tmp/wt",
  removedAt: null,
  branchDeletedAt: "2026-01-02T00:00:00.000Z",
});

const makeTask = (id: string, threadIds: ReadonlyArray<string> = []): Task => ({
  id: TaskId.make(id),
  title: "Title",
  description: "Desc",
  link: "https://example.com",
  status: "in_progress",
  primaryProjectId: ProjectId.make("p1"),
  projectIds: [ProjectId.make("p1"), ProjectId.make("p2")],
  worktrees: [worktree("p1", "task/a"), worktree("p2", "task/a")],
  threadIds: threadIds.map((t) => ThreadId.make(t)),
  sortKey: 1.5,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  startedAt: "2026-01-01T00:00:02.000Z",
  completedAt: null,
  archivedAt: null,
});

it.effect("round-trips a task with children", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    const task = makeTask("t1", ["th1", "th2"]);
    yield* store.insert(task);
    assert.deepStrictEqual(yield* store.get(task.id), task);
    assert.deepStrictEqual(yield* store.listAll(), [task]);
    const updated = { ...task, title: "New", projectIds: [task.primaryProjectId], threadIds: [] };
    yield* store.update({ ...updated, worktrees: [] });
    assert.deepStrictEqual(yield* store.get(task.id), { ...updated, worktrees: [] });
    yield* store.delete(task.id);
    assert.strictEqual(yield* store.get(task.id), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rebuilding the layer keeps data", () =>
  Effect.gen(function* () {
    const first = yield* TaskStore;
    yield* first.insert(makeTask("t1"));
    const ctx = yield* Layer.build(layer);
    const second = yield* Effect.service(TaskStore).pipe(Effect.provideContext(ctx));
    assert.strictEqual((yield* second.listAll()).length, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ version: number }>`SELECT version FROM task_schema_version`;
    assert.deepStrictEqual(rows, [{ version: 1 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a thread belongs to at most one task", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    yield* store.insert(makeTask("t1", ["th1"]));
    const exit = yield* store.insert(makeTask("t2", ["th1"])).pipe(Effect.exit);
    assert.strictEqual(exit._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("findTaskByThread and removeThreadEverywhere", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    yield* store.insert(makeTask("t1", ["th1"]));
    assert.strictEqual(yield* store.findTaskByThread(ThreadId.make("th1")), TaskId.make("t1"));
    yield* store.removeThreadEverywhere(ThreadId.make("th1"));
    assert.strictEqual(yield* store.findTaskByThread(ThreadId.make("th1")), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("settings round-trip", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    assert.strictEqual(yield* store.getSetting("cleanupMode"), null);
    yield* store.setSetting("cleanupMode", "always");
    assert.strictEqual(yield* store.getSetting("cleanupMode"), "always");
    yield* store.setSetting("cleanupMode", "never");
    assert.strictEqual(yield* store.getSetting("cleanupMode"), "never");
  }).pipe(Effect.provide(testLayer)),
);
