import { assert, it } from "@effect/vitest";
import { type Task, TaskId, ProjectId, ThreadId, type TaskWorktree } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { TaskStore, layer, selectKeptWorktreePaths } from "./TaskStore.ts";

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

it.effect("findTaskByThread", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    yield* store.insert(makeTask("t1", ["th1"]));
    assert.strictEqual(yield* store.findTaskByThread(ThreadId.make("th1")), TaskId.make("t1"));
    assert.strictEqual(yield* store.findTaskByThread(ThreadId.make("th2")), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("kept worktree paths include a linked thread's worktree while its record waits", () =>
  Effect.gen(function* () {
    const store = yield* TaskStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, deleted_at TEXT, payload_json TEXT NOT NULL
      )`;
    const thread = (id: string, branch: string, worktreePath: string, deletedAt: string | null) =>
      sql`INSERT INTO orchestration_v2_projection_threads VALUES (
        ${id}, 'p1', ${deletedAt}, ${JSON.stringify({ branch, worktreePath })}
      )`;
    yield* store.insert({
      ...makeTask("t1", ["th-pending", "th-deleted", "th-other"]),
      worktrees: [
        { ...worktree("p1", "task/a"), worktreePath: "/wt/recorded", branchDeletedAt: null },
        { ...worktree("p1", "task/b"), worktreePath: null, branchDeletedAt: null },
        { ...worktree("p1", "task/c"), worktreePath: null, branchDeletedAt: null },
        {
          ...worktree("p1", "task/gone"),
          worktreePath: "/wt/gone",
          removedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    // The launch has made the worktree, but the task has not learned its path yet.
    yield* thread("th-pending", "task/b", "/wt/pending", null);
    // A deleted chat still linked, before its cleanup unlinks it.
    yield* thread("th-deleted", "task/c", "/wt/deleted", "2026-01-04T00:00:00.000Z");
    yield* thread("th-other", "feat/unrelated", "/wt/unrelated", null);
    yield* thread("th-unlinked", "task/b", "/wt/foreign", null);
    const paths = (yield* selectKeptWorktreePaths(sql)).map((row) => row.taskWorktreePath);
    assert.deepStrictEqual(paths.toSorted(), ["/wt/deleted", "/wt/pending", "/wt/recorded"]);
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
