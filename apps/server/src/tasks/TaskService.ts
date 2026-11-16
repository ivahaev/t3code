import {
  CommandId,
  type OrchestrationV2ThreadShell,
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
  type TaskStatus,
  type TaskUpsertInput,
  type TaskWorktree,
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
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { formatTaskPrompt, taskBranchName } from "./taskBranch.ts";
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
    /** Drops a deleted thread from its task; thread deletion cleanup calls it. */
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void>;
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

/**
 * Fills a missing worktree path from the first live thread of the task on the same branch
 * in the same project. Launch creates the worktree after it returns, so the path comes late.
 */
const fillWorktreePaths = (
  worktrees: ReadonlyArray<TaskWorktree>,
  shells: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "projectId" | "branch" | "worktreePath" | "deletedAt">
  >,
): ReadonlyArray<TaskWorktree> =>
  worktrees.map((worktree) => {
    if (worktree.worktreePath !== null || worktree.removedAt !== null) return worktree;
    const worktreePath =
      shells.find(
        (shell) =>
          shell.deletedAt === null &&
          shell.worktreePath !== null &&
          shell.projectId === worktree.projectId &&
          shell.branch === worktree.branch,
      )?.worktreePath ?? null;
    return worktreePath === null ? worktree : { ...worktree, worktreePath };
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const notImplemented = (operation: string, taskId: TaskId) =>
  Effect.fail(new TaskError({ message: `tasks.${operation} is not implemented yet.`, taskId }));

const worktreePreparing = (taskId: TaskId) =>
  new TaskError({
    message: "The task's worktree is still being prepared. Try again in a moment.",
    taskId,
    code: "worktree_preparing",
  });

const newWorktree = (
  fields: Pick<TaskWorktree, "projectId" | "branch" | "baseRef" | "kind">,
): TaskWorktree => ({ ...fields, worktreePath: null, removedAt: null, branchDeletedAt: null });

interface TaskLaunch {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceStrategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
  readonly text: string;
  /** False keeps the task title; true lets the first message name the thread. */
  readonly generateTitle: boolean;
  readonly options: Pick<TaskStartInput, "modelSelection" | "runtimeMode" | "interactionMode">;
}

const make = Effect.gen(function* () {
  const store = yield* TaskStore.TaskStore;
  const sql = yield* SqlClient.SqlClient;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
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

  const list = Effect.fn("TaskService.list")(function* () {
    return {
      tasks: yield* store.listAll(),
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

  const withStatus = Effect.fn("TaskService.withStatus")(function* (
    task: Task,
    status: TaskStatus,
    sortKey?: number,
  ) {
    const now = yield* nowIso;
    const column = (yield* store.listAll()).filter(
      (other) => other.status === status && other.id !== task.id,
    );
    return {
      ...task,
      status,
      sortKey: sortKey ?? nextSortKey(column),
      startedAt: task.startedAt ?? (status === "backlog" ? null : now),
      completedAt: status === "done" ? (task.status === "done" ? task.completedAt : now) : null,
    } satisfies Task;
  });

  const setStatus = Effect.fn("TaskService.setStatus")(function* (input: TaskSetStatusInput) {
    const task = yield* requireTask(input.id);
    return yield* save(yield* withStatus(task, input.status, input.sortKey));
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

  // The thread lookup and the git call run before the write lock, so they do not hold up writes.
  const attachThread = Effect.fn("TaskService.attachThread")(function* (
    input: TaskAttachThreadInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id, "thread.id": input.threadId });
    const shell = yield* threadManagement
      .getThreadShell(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TaskError({ message: "Could not read the thread.", taskId: input.id, cause }),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* new TaskError({
        message: "That thread no longer exists.",
        taskId: input.id,
        code: "not_found",
      });
    }
    const { branch, worktreePath, projectId } = shell;
    const extraWorktree =
      worktreePath === null || branch === null
        ? null
        : {
            projectId,
            branch,
            baseRef: yield* defaultBaseRef(projectId),
            kind: "extra" as const,
            worktreePath,
            removedAt: null,
            branchDeletedAt: null,
          };
    return yield* serialized(
      Effect.gen(function* () {
        const task = yield* requireTask(input.id);
        const owner = yield* store.findTaskByThread(input.threadId);
        const previous = owner === null || owner === task.id ? null : yield* store.get(owner);
        if (previous !== null && !input.moveFromOtherTask) {
          return yield* new TaskError({
            message: "That thread already belongs to another task.",
            taskId: previous.id,
            code: "already_attached",
          });
        }
        const knownWorktree = task.worktrees.some(
          (worktree) => worktree.projectId === projectId && worktree.branch === branch,
        );
        const updated: Task = {
          ...task,
          projectIds: task.projectIds.includes(projectId)
            ? task.projectIds
            : [...task.projectIds, projectId],
          worktrees:
            extraWorktree === null || knownWorktree
              ? task.worktrees
              : [...task.worktrees, extraWorktree],
          threadIds: task.threadIds.includes(input.threadId)
            ? task.threadIds
            : [...task.threadIds, input.threadId],
          updatedAt: yield* nowIso,
        };
        // A move leaves the thread in exactly one task, even if the second write fails.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (previous !== null) {
                yield* store.update({
                  ...previous,
                  threadIds: previous.threadIds.filter((id) => id !== input.threadId),
                  updatedAt: updated.updatedAt,
                });
              }
              yield* store.update(updated);
            }),
          )
          .pipe(Effect.orDie);
        yield* notifyChanged;
        return { task: updated };
      }),
    );
  });

  const removeThread = Effect.fn("TaskService.removeThread")(function* (threadId: ThreadId) {
    const owner = yield* store.findTaskByThread(threadId);
    if (owner === null) return;
    yield* store.removeThreadEverywhere(threadId);
    yield* notifyChanged;
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

  /** Branch names a new task branch in the project must avoid. */
  const takenBranches = Effect.fn("TaskService.takenBranches")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    // Deleting a task keeps its branches, so a new task must not reuse one.
    const local = Option.isNone(project)
      ? []
      : yield* git
          .listLocalBranchNames(project.value.workspaceRoot)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const recorded = (yield* store.listAll()).flatMap((task) =>
      task.worktrees
        .filter((worktree) => worktree.projectId === projectId)
        .map((worktree) => worktree.branch),
    );
    return new Set([...local, ...recorded]);
  });

  /** A new shared worktree: branch `task/<slug>` from `origin/<default branch>`. */
  const sharedWorktreeStrategy = Effect.fn("TaskService.sharedWorktreeStrategy")(function* (
    task: Task,
    projectId: ProjectId,
  ) {
    return {
      type: "worktree",
      baseRef: yield* defaultBaseRef(projectId),
      branch: taskBranchName(task.title, yield* takenBranches(projectId)),
      startFromOrigin: true,
    } as const;
  });

  // Runs outside the write lock: launch may take a while. A retry with the same command id
  // replays the accepted launch, so it returns the same thread.
  const launchThread = Effect.fn("TaskService.launchThread")(function* (
    task: Task,
    launch: TaskLaunch,
  ) {
    const failed = (cause: { readonly message: string }) =>
      new TaskError({ message: cause.message, taskId: task.id, cause });
    if (launch.workspaceStrategy.type === "worktree") {
      yield* launches
        .checkWorktreeBase({
          commandId: launch.commandId,
          projectId: launch.projectId,
          workspaceStrategy: launch.workspaceStrategy,
        })
        .pipe(Effect.mapError(failed));
    }
    const launched = yield* launches
      .launch({
        commandId: launch.commandId,
        projectId: launch.projectId,
        title: task.title,
        ...(launch.generateTitle ? { generateTitle: true } : {}),
        ...launch.options,
        workspaceStrategy: launch.workspaceStrategy,
        initialMessage: { text: launch.text, attachments: [] },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failed));
    // A replayed launch keeps the branch it was accepted with.
    return { threadId: launched.threadId, branch: launched.projection.thread.branch };
  });

  /** Links a launched thread, its project and its new worktree to the task. */
  const recordThread = Effect.fn("TaskService.recordThread")(function* (
    taskId: TaskId,
    record: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly worktree: TaskWorktree | null;
      readonly markInProgress: boolean;
    },
  ) {
    const task = yield* requireTask(taskId);
    const { threadId, projectId, worktree } = record;
    const knownWorktree =
      worktree === null ||
      task.worktrees.some(
        (existing) => existing.projectId === projectId && existing.branch === worktree.branch,
      );
    const linked: Task = {
      ...task,
      projectIds: task.projectIds.includes(projectId)
        ? task.projectIds
        : [...task.projectIds, projectId],
      worktrees: knownWorktree ? task.worktrees : [...task.worktrees, worktree],
      threadIds: task.threadIds.includes(threadId) ? task.threadIds : [...task.threadIds, threadId],
    };
    const updated =
      record.markInProgress && linked.status !== "in_progress"
        ? yield* withStatus(linked, "in_progress")
        : linked;
    return { task: (yield* save(updated)).task, threadId } satisfies TaskThreadResult;
  }, serialized);

  /** Fills missing worktree paths from the task's own threads. Cleanup reuses it. */
  const resolveWorktreePaths = Effect.fn("TaskService.resolveWorktreePaths")(function* (
    task: Task,
  ) {
    if (!task.worktrees.some((w) => w.worktreePath === null && w.removedAt === null)) return task;
    const shells = (yield* Effect.forEach(
      task.threadIds,
      (threadId) =>
        threadManagement.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 4 },
    )).filter((shell) => shell !== null);
    if (fillWorktreePaths(task.worktrees, shells).every((w, i) => w === task.worktrees[i])) {
      return task;
    }
    return yield* serialized(
      Effect.gen(function* () {
        const current = yield* requireTask(task.id);
        const worktrees = fillWorktreePaths(current.worktrees, shells);
        if (worktrees.every((w, i) => w === current.worktrees[i])) return current;
        return (yield* save({ ...current, worktrees })).task;
      }),
    );
  });

  const start = Effect.fn("TaskService.start")(function* (input: TaskStartInput) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id });
    const task = yield* requireTask(input.id);
    const firstThreadId = task.threadIds[0];
    if (firstThreadId !== undefined) {
      const current =
        task.status === "in_progress"
          ? task
          : (yield* setStatus({ id: task.id, status: "in_progress" })).task;
      return { task: current, threadId: firstThreadId } satisfies TaskThreadResult;
    }
    const projectId = task.primaryProjectId;
    const strategy = yield* sharedWorktreeStrategy(task, projectId);
    const launched = yield* launchThread(task, {
      commandId: input.commandId,
      projectId,
      workspaceStrategy: strategy,
      text: formatTaskPrompt(task),
      generateTitle: false,
      options: input,
    });
    return yield* recordThread(task.id, {
      threadId: launched.threadId,
      projectId,
      worktree: newWorktree({
        projectId,
        branch: launched.branch ?? strategy.branch,
        baseRef: strategy.baseRef,
        kind: "shared",
      }),
      markInProgress: true,
    });
  });

  const newThread = Effect.fn("TaskService.newThread")(function* (input: TaskNewThreadInput) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id, "project.id": input.projectId });
    const task = yield* resolveWorktreePaths(yield* requireTask(input.id));
    const { projectId } = input;
    const launch = (workspaceStrategy: TaskLaunch["workspaceStrategy"]) =>
      launchThread(task, {
        commandId: input.commandId,
        projectId,
        workspaceStrategy,
        text: input.text,
        generateTitle: true,
        options: input,
      });

    if (input.workspace === "root") {
      const launched = yield* launch({ type: "root" });
      return yield* recordThread(task.id, {
        threadId: launched.threadId,
        projectId,
        worktree: null,
        markInProgress: false,
      });
    }

    const shared = task.worktrees.find(
      (worktree) =>
        worktree.projectId === projectId &&
        worktree.kind === "shared" &&
        worktree.removedAt === null,
    );
    if (shared === undefined) {
      const strategy = yield* sharedWorktreeStrategy(task, projectId);
      // An extra worktree branches off the shared one, so the shared one comes first. Its
      // thread gets the task prompt and its own command id; the user's text waits for the retry.
      const forExtra = input.workspace === "extra";
      const launched = yield* forExtra
        ? launchThread(task, {
            commandId: CommandId.make(`${input.commandId}:shared`),
            projectId,
            workspaceStrategy: strategy,
            text: formatTaskPrompt(task),
            generateTitle: false,
            options: input,
          })
        : launch(strategy);
      const result = yield* recordThread(task.id, {
        threadId: launched.threadId,
        projectId,
        worktree: newWorktree({
          projectId,
          branch: launched.branch ?? strategy.branch,
          baseRef: strategy.baseRef,
          kind: "shared",
        }),
        markInProgress: false,
      });
      if (forExtra) return yield* worktreePreparing(task.id);
      return result;
    }
    // Review Focus 1: the shared worktree is still being created by its first thread.
    if (shared.worktreePath === null) return yield* worktreePreparing(task.id);

    if (input.workspace === "shared") {
      const launched = yield* launch({
        type: "existing_worktree",
        worktreePath: shared.worktreePath,
        branch: shared.branch,
      });
      return yield* recordThread(task.id, {
        threadId: launched.threadId,
        projectId,
        worktree: null,
        markInProgress: false,
      });
    }

    const ordinal =
      task.worktrees.filter((worktree) => worktree.projectId === projectId).length + 1;
    const branch = taskBranchName(`${task.title}-${ordinal}`, yield* takenBranches(projectId));
    const launched = yield* launch({
      type: "worktree",
      baseRef: shared.branch,
      branch,
      startFromOrigin: false,
    });
    return yield* recordThread(task.id, {
      threadId: launched.threadId,
      projectId,
      worktree: newWorktree({
        projectId,
        branch: launched.branch ?? branch,
        baseRef: shared.branch,
        kind: "extra",
      }),
      markInProgress: false,
    });
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
    removeThread,
  });
});

/** One past the column's highest sort key, so a moved card lands at the end. */
const nextSortKey = (column: ReadonlyArray<Task>) =>
  column.reduce((max, task) => Math.max(max, task.sortKey), 0) + 1;

export const layer = Layer.effect(TaskService, make);
