import {
  type Task,
  type TaskId,
  type TaskStatus,
  type TaskWorktree,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const SCHEMA_VERSION = 1;

export class TaskStore extends Context.Service<
  TaskStore,
  {
    readonly listAll: () => Effect.Effect<ReadonlyArray<Task>>;
    readonly get: (id: TaskId) => Effect.Effect<Task | null>;
    readonly insert: (task: Task) => Effect.Effect<void>;
    readonly update: (task: Task) => Effect.Effect<void>;
    readonly delete: (id: TaskId) => Effect.Effect<void>;
    readonly findTaskByThread: (threadId: ThreadId) => Effect.Effect<TaskId | null>;
    readonly removeThreadEverywhere: (threadId: ThreadId) => Effect.Effect<void>;
    readonly getSetting: (key: string) => Effect.Effect<string | null>;
    readonly setSetting: (key: string, value: string) => Effect.Effect<void>;
  }
>()("t3/tasks/TaskStore") {}

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly link: string | null;
  readonly status: string;
  readonly primary_project_id: string;
  readonly sort_key: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly archived_at: string | null;
}

const makeTaskStore = Effect.fn("TaskStore.make")(function* () {
  {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS task_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        link TEXT,
        status TEXT NOT NULL,
        primary_project_id TEXT NOT NULL,
        sort_key REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        archived_at TEXT
      )`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS task_projects (
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        PRIMARY KEY (task_id, project_id)
      )`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS task_worktrees (
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        worktree_path TEXT,
        removed_at TEXT,
        branch_deleted_at TEXT,
        PRIMARY KEY (task_id, project_id, branch)
      )`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS task_threads (
        task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        attached_at TEXT NOT NULL
      )`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS task_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`;
    yield* sql`CREATE TABLE IF NOT EXISTS task_schema_version (version INTEGER NOT NULL)`;
    yield* sql`
      INSERT INTO task_schema_version (version)
      SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM task_schema_version)`;

    const hydrate = Effect.fnUntraced(function* (rows: ReadonlyArray<TaskRow>) {
      const projects = yield* sql<{
        task_id: string;
        project_id: string;
      }>`SELECT task_id, project_id FROM task_projects ORDER BY rowid`;
      const worktrees = yield* sql<{
        task_id: string;
        project_id: string;
        branch: string;
        base_ref: string;
        kind: string;
        worktree_path: string | null;
        removed_at: string | null;
        branch_deleted_at: string | null;
      }>`SELECT * FROM task_worktrees ORDER BY rowid`;
      const threads = yield* sql<{
        task_id: string;
        thread_id: string;
      }>`SELECT task_id, thread_id FROM task_threads ORDER BY rowid`;
      return rows.map((row): Task => ({
        id: row.id as TaskId,
        title: row.title as Task["title"],
        description: row.description,
        link: row.link,
        status: row.status as TaskStatus,
        primaryProjectId: row.primary_project_id as ProjectId,
        projectIds: projects
          .filter((p) => p.task_id === row.id)
          .map((p) => p.project_id as ProjectId),
        worktrees: worktrees
          .filter((w) => w.task_id === row.id)
          .map((w): TaskWorktree => ({
            projectId: w.project_id as ProjectId,
            branch: w.branch,
            baseRef: w.base_ref,
            kind: w.kind as TaskWorktree["kind"],
            worktreePath: w.worktree_path,
            removedAt: w.removed_at,
            branchDeletedAt: w.branch_deleted_at,
          })),
        threadIds: threads.filter((t) => t.task_id === row.id).map((t) => t.thread_id as ThreadId),
        sortKey: row.sort_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        archivedAt: row.archived_at,
      }));
    });

    const writeChildren = Effect.fnUntraced(function* (task: Task) {
      for (const projectId of task.projectIds) {
        yield* sql`INSERT INTO task_projects (task_id, project_id) VALUES (${task.id}, ${projectId})`;
      }
      for (const w of task.worktrees) {
        yield* sql`
          INSERT INTO task_worktrees (
            task_id, project_id, branch, base_ref, kind, worktree_path, removed_at, branch_deleted_at
          ) VALUES (
            ${task.id}, ${w.projectId}, ${w.branch}, ${w.baseRef}, ${w.kind},
            ${w.worktreePath}, ${w.removedAt}, ${w.branchDeletedAt}
          )`;
      }
      for (const threadId of task.threadIds) {
        yield* sql`
          INSERT INTO task_threads (task_id, thread_id, attached_at)
          VALUES (${task.id}, ${threadId}, ${task.updatedAt})`;
      }
    });

    const deleteChildren = (id: TaskId) =>
      sql`DELETE FROM task_projects WHERE task_id = ${id}`.pipe(
        Effect.andThen(sql`DELETE FROM task_worktrees WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM task_threads WHERE task_id = ${id}`),
      );

    const listAll = Effect.fn("TaskStore.listAll")(function* () {
      const rows = yield* sql<TaskRow>`SELECT * FROM task_tasks ORDER BY created_at, rowid`;
      return yield* hydrate(rows);
    });

    const get = Effect.fn("TaskStore.get")(function* (id: TaskId) {
      const rows = yield* sql<TaskRow>`SELECT * FROM task_tasks WHERE id = ${id}`;
      return (yield* hydrate(rows))[0] ?? null;
    });

    const insert = Effect.fn("TaskStore.insert")(function* (task: Task) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO task_tasks (
              id, title, description, link, status, primary_project_id, sort_key,
              created_at, updated_at, started_at, completed_at, archived_at
            ) VALUES (
              ${task.id}, ${task.title}, ${task.description}, ${task.link}, ${task.status},
              ${task.primaryProjectId}, ${task.sortKey}, ${task.createdAt}, ${task.updatedAt},
              ${task.startedAt}, ${task.completedAt}, ${task.archivedAt}
            )`;
          yield* writeChildren(task);
        }),
      );
    });

    const update = Effect.fn("TaskStore.update")(function* (task: Task) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE task_tasks SET
              title = ${task.title}, description = ${task.description}, link = ${task.link},
              status = ${task.status}, primary_project_id = ${task.primaryProjectId},
              sort_key = ${task.sortKey}, created_at = ${task.createdAt},
              updated_at = ${task.updatedAt}, started_at = ${task.startedAt},
              completed_at = ${task.completedAt}, archived_at = ${task.archivedAt}
            WHERE id = ${task.id}`;
          yield* deleteChildren(task.id);
          yield* writeChildren(task);
        }),
      );
    });

    const remove = Effect.fn("TaskStore.delete")(function* (id: TaskId) {
      yield* sql.withTransaction(
        deleteChildren(id).pipe(Effect.andThen(sql`DELETE FROM task_tasks WHERE id = ${id}`)),
      );
    });

    const findTaskByThread = Effect.fn("TaskStore.findTaskByThread")(function* (
      threadId: ThreadId,
    ) {
      const rows = yield* sql<{
        task_id: string;
      }>`SELECT task_id FROM task_threads WHERE thread_id = ${threadId}`;
      return (rows[0]?.task_id as TaskId | undefined) ?? null;
    });

    const removeThreadEverywhere = Effect.fn("TaskStore.removeThreadEverywhere")(function* (
      threadId: ThreadId,
    ) {
      yield* sql`DELETE FROM task_threads WHERE thread_id = ${threadId}`;
    });

    const getSetting = Effect.fn("TaskStore.getSetting")(function* (key: string) {
      const rows = yield* sql<{
        value: string;
      }>`SELECT value FROM task_settings WHERE key = ${key}`;
      return rows[0]?.value ?? null;
    });

    const setSetting = Effect.fn("TaskStore.setSetting")(function* (key: string, value: string) {
      yield* sql`
        INSERT INTO task_settings (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    });

    // SQL failures are unrecoverable defects for callers.
    const orDie =
      <A, Args extends ReadonlyArray<unknown>>(f: (...args: Args) => Effect.Effect<A, SqlError>) =>
      (...args: Args): Effect.Effect<A> =>
        Effect.orDie(f(...args));

    return TaskStore.of({
      listAll: orDie(listAll),
      get: orDie(get),
      insert: orDie(insert),
      update: orDie(update),
      delete: orDie(remove),
      findTaskByThread: orDie(findTaskByThread),
      removeThreadEverywhere: orDie(removeThreadEverywhere),
      getSetting: orDie(getSetting),
      setSetting: orDie(setSetting),
    });
  }
});

export const layer = Layer.effect(TaskStore, makeTaskStore());
