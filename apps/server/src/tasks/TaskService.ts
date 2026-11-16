import {
  type ProjectId,
  type Task,
  type TaskAddProjectInput,
  type TaskAttachThreadInput,
  type TaskCleanupInput,
  type TaskCleanupPreview,
  type TaskCleanupPreviewInput,
  type TaskCleanupResult,
  TaskCleanupMode,
  type TaskDetachThreadInput,
  TaskError,
  TaskId,
  type TaskIdInput,
  type TaskListResult,
  type TaskMutationResult,
  type TaskNewThreadInput,
  type TaskSetCleanupModeInput,
  type TaskSetStatusInput,
  type TaskStartInput,
  type TaskThreadResult,
  type TaskUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskStore from "./TaskStore.ts";

const CLEANUP_MODE_KEY = "cleanupMode";
const isCleanupMode = Schema.is(TaskCleanupMode);

export class TaskService extends Context.Service<
  TaskService,
  {
    readonly list: () => Effect.Effect<TaskListResult, TaskError>;
    /** The current list, then the full list again after every change. */
    readonly subscribeList: () => Stream.Stream<TaskListResult, TaskError>;
    readonly upsert: (input: TaskUpsertInput) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly setStatus: (input: TaskSetStatusInput) => Effect.Effect<TaskMutationResult, TaskError>;
    /** Removes only the task and its links; threads, worktrees and branches stay. */
    readonly delete: (input: TaskIdInput) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly archive: (input: TaskIdInput) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly unarchive: (input: TaskIdInput) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly attachThread: (
      input: TaskAttachThreadInput,
    ) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly detachThread: (
      input: TaskDetachThreadInput,
    ) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly addProject: (
      input: TaskAddProjectInput,
    ) => Effect.Effect<TaskMutationResult, TaskError>;
    readonly setCleanupMode: (
      input: TaskSetCleanupModeInput,
    ) => Effect.Effect<TaskSetCleanupModeInput, TaskError>;
    readonly start: (input: TaskStartInput) => Effect.Effect<TaskThreadResult, TaskError>;
    readonly newThread: (input: TaskNewThreadInput) => Effect.Effect<TaskThreadResult, TaskError>;
    readonly cleanupPreview: (
      input: TaskCleanupPreviewInput,
    ) => Effect.Effect<TaskCleanupPreview, TaskError>;
    readonly cleanup: (input: TaskCleanupInput) => Effect.Effect<TaskCleanupResult, TaskError>;
  }
>()("t3/tasks/TaskService") {}

/** Pairs each task project with whether the environment still knows it. */
export const resolveTaskProjects = (
  task: Pick<Task, "projectIds">,
  knownProjectIds: ReadonlyArray<ProjectId>,
): ReadonlyArray<{ readonly projectId: ProjectId; readonly available: boolean }> => {
  const known = new Set(knownProjectIds);
  return task.projectIds.map((projectId) => ({ projectId, available: known.has(projectId) }));
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const notImplemented = (operation: string, taskId: TaskId) =>
  Effect.fail(new TaskError({ message: `tasks.${operation} is not implemented yet.`, taskId }));

const make = Effect.gen(function* () {
  const store = yield* TaskStore.TaskStore;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  // Mutations read, modify and rewrite a whole task, so they run one at a time.
  const writeLock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => writeLock.withPermits(1)(effect);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const requireTask = Effect.fn("TaskService.requireTask")(function* (id: TaskId) {
    const task = yield* store.get(id);
    if (task === null) {
      return yield* new TaskError({ message: "Task not found.", taskId: id, code: "not_found" });
    }
    return task;
  });

  const save = Effect.fn("TaskService.save")(function* (task: Task) {
    const saved = { ...task, updatedAt: yield* nowIso };
    yield* store.update(saved);
    yield* notifyChanged;
    return { task: saved };
  });

  const readCleanupMode = store
    .getSetting(CLEANUP_MODE_KEY)
    .pipe(Effect.map((value) => (value !== null && isCleanupMode(value) ? value : "ask")));

  /** A thread is gone when its shell is missing or deleted; a failed lookup keeps it. */
  const isThreadGone = (threadId: ThreadId) =>
    threadManagement.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell === null || shell.deletedAt !== null),
      Effect.orElseSucceed(() => false),
    );

  // Thread deletion has no task hook, so deleted threads are dropped here, lazily.
  const list = Effect.fn("TaskService.list")(function* () {
    const tasks = yield* store.listAll();
    const goneThreadIds = yield* Effect.filter(
      tasks.flatMap((task) => task.threadIds),
      isThreadGone,
      { concurrency: 8 },
    );
    yield* Effect.forEach(goneThreadIds, store.removeThreadEverywhere, { discard: true });
    const gone = new Set(goneThreadIds);
    return {
      tasks:
        gone.size === 0
          ? tasks
          : tasks.map((task) => ({
              ...task,
              threadIds: task.threadIds.filter((threadId) => !gone.has(threadId)),
            })),
      settings: { cleanupMode: yield* readCleanupMode },
    } satisfies TaskListResult;
  });

  const subscribeList: TaskService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const upsert = Effect.fn("TaskService.upsert")(function* (input: TaskUpsertInput) {
    const projectIds = input.projectIds.includes(input.primaryProjectId)
      ? input.projectIds
      : [input.primaryProjectId, ...input.projectIds];
    const fields = {
      title: input.title,
      description: input.description,
      link: input.link,
      primaryProjectId: input.primaryProjectId,
      projectIds,
    };
    if (input.id !== undefined) {
      const existing = yield* requireTask(input.id);
      return yield* save({ ...existing, ...fields });
    }
    const now = yield* nowIso;
    const backlog = (yield* store.listAll()).filter((task) => task.status === "backlog");
    const task: Task = {
      id: TaskId.make(`task:${yield* randomUuidV4}`),
      ...fields,
      status: "backlog",
      worktrees: [],
      threadIds: [],
      sortKey: nextSortKey(backlog),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      archivedAt: null,
    };
    yield* store.insert(task);
    yield* notifyChanged;
    return { task };
  }, serialized);

  const setStatus = Effect.fn("TaskService.setStatus")(function* (input: TaskSetStatusInput) {
    const task = yield* requireTask(input.id);
    const now = yield* nowIso;
    const column = (yield* store.listAll()).filter(
      (other) => other.status === input.status && other.id !== task.id,
    );
    return yield* save({
      ...task,
      status: input.status,
      sortKey: input.sortKey ?? nextSortKey(column),
      startedAt: task.startedAt ?? (input.status === "backlog" ? null : now),
      completedAt:
        input.status === "done" ? (task.status === "done" ? task.completedAt : now) : null,
    });
  }, serialized);

  const remove = Effect.fn("TaskService.delete")(function* (input: TaskIdInput) {
    const task = yield* requireTask(input.id);
    yield* store.delete(task.id);
    yield* notifyChanged;
    return { task };
  }, serialized);

  const archive = Effect.fn("TaskService.archive")(function* (input: TaskIdInput) {
    const task = yield* requireTask(input.id);
    return yield* save({ ...task, archivedAt: task.archivedAt ?? (yield* nowIso) });
  }, serialized);

  const unarchive = Effect.fn("TaskService.unarchive")(function* (input: TaskIdInput) {
    const task = yield* requireTask(input.id);
    return yield* save({ ...task, archivedAt: null });
  }, serialized);

  /** `origin/<default branch>`, the base every task worktree diffs against. */
  const defaultBaseRef = Effect.fn("TaskService.defaultBaseRef")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) return "origin/main";
    const branch = yield* git
      .resolveDefaultBranchName(project.value.workspaceRoot, "origin")
      .pipe(Effect.orElseSucceed(() => null));
    return `origin/${branch ?? "main"}`;
  });

  const attachThread = Effect.fn("TaskService.attachThread")(function* (
    input: TaskAttachThreadInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id, "thread.id": input.threadId });
    const task = yield* requireTask(input.id);
    const shell = yield* threadManagement
      .getThreadShell(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TaskError({ message: "Could not read the thread.", taskId: task.id, cause }),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* new TaskError({
        message: "That thread no longer exists.",
        taskId: task.id,
        code: "not_found",
      });
    }
    const owner = yield* store.findTaskByThread(input.threadId);
    if (owner !== null && owner !== task.id) {
      if (!input.moveFromOtherTask) {
        return yield* new TaskError({
          message: "That thread already belongs to another task.",
          taskId: owner,
          code: "already_attached",
        });
      }
      yield* store.removeThreadEverywhere(input.threadId);
    }
    const projectIds = task.projectIds.includes(shell.projectId)
      ? task.projectIds
      : [...task.projectIds, shell.projectId];
    const branch = shell.branch;
    const knownWorktree = task.worktrees.some(
      (worktree) => worktree.projectId === shell.projectId && worktree.branch === branch,
    );
    const worktrees =
      shell.worktreePath === null || branch === null || knownWorktree
        ? task.worktrees
        : [
            ...task.worktrees,
            {
              projectId: shell.projectId,
              branch,
              baseRef: yield* defaultBaseRef(shell.projectId),
              kind: "extra" as const,
              worktreePath: shell.worktreePath,
              removedAt: null,
              branchDeletedAt: null,
            },
          ];
    const threadIds = task.threadIds.includes(input.threadId)
      ? task.threadIds
      : [...task.threadIds, input.threadId];
    return yield* save({ ...task, projectIds, worktrees, threadIds });
  }, serialized);

  const detachThread = Effect.fn("TaskService.detachThread")(function* (
    input: TaskDetachThreadInput,
  ) {
    const task = yield* requireTask(input.id);
    return yield* save({
      ...task,
      threadIds: task.threadIds.filter((threadId) => threadId !== input.threadId),
    });
  }, serialized);

  const addProject = Effect.fn("TaskService.addProject")(function* (input: TaskAddProjectInput) {
    const task = yield* requireTask(input.id);
    if (task.projectIds.includes(input.projectId)) return { task };
    return yield* save({ ...task, projectIds: [...task.projectIds, input.projectId] });
  }, serialized);

  const setCleanupMode = Effect.fn("TaskService.setCleanupMode")(function* (
    input: TaskSetCleanupModeInput,
  ) {
    yield* store.setSetting(CLEANUP_MODE_KEY, input.mode);
    yield* notifyChanged;
    return { mode: input.mode };
  });

  // Tasks 4 and 5 of the plan implement these.
  const start = Effect.fn("TaskService.start")(function* (input: TaskStartInput) {
    return yield* notImplemented("start", input.id);
  });
  const newThread = Effect.fn("TaskService.newThread")(function* (input: TaskNewThreadInput) {
    return yield* notImplemented("newThread", input.id);
  });
  const cleanupPreview = Effect.fn("TaskService.cleanupPreview")(function* (
    input: TaskCleanupPreviewInput,
  ) {
    return yield* notImplemented("cleanupPreview", input.id);
  });
  const cleanup = Effect.fn("TaskService.cleanup")(function* (input: TaskCleanupInput) {
    return yield* notImplemented("cleanup", input.id);
  });

  return TaskService.of({
    list,
    subscribeList,
    upsert,
    setStatus,
    delete: remove,
    archive,
    unarchive,
    attachThread,
    detachThread,
    addProject,
    setCleanupMode,
    start,
    newThread,
    cleanupPreview,
    cleanup,
  });
});

/** One past the column's highest sort key, so a moved card lands at the end. */
const nextSortKey = (column: ReadonlyArray<Task>) =>
  column.reduce((max, task) => Math.max(max, task.sortKey), 0) + 1;

export const layer = Layer.effect(TaskService, make);
