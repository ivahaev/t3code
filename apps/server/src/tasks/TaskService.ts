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
  shells: ReadonlyArray<TaskShell>,
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

const hasPendingWorktree = (task: Task) =>
  task.worktrees.some((worktree) => worktree.worktreePath === null && worktree.removedAt === null);

/** A run that ended without a worktree path: its workspace preparation failed. */
const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

type TaskShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "branch" | "worktreePath" | "deletedAt" | "status" | "lastError"
>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const notImplemented = (operation: string, taskId: TaskId) =>
  Effect.fail(new TaskError({ message: `tasks.${operation} is not implemented yet.`, taskId }));

const worktreePreparing = (taskId: TaskId) =>
  new TaskError({
    message: "The task's worktree is still being prepared. Try again in a moment.",
    taskId,
    code: "worktree_preparing",
  });

const worktreeFailed = (taskId: TaskId, detail: string | null | undefined) =>
  new TaskError({
    message: `Worktree задачи не удалось подготовить${detail ? `: ${detail}` : "."} Новый чат создаст его заново.`,
    taskId,
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

  /** Shells of the task's threads, read only while one of its worktrees waits for a path. */
  const readPendingShells = Effect.fn("TaskService.readPendingShells")(function* (task: Task) {
    if (!hasPendingWorktree(task)) return [];
    return (yield* Effect.forEach(
      task.threadIds,
      (threadId) =>
        threadManagement.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 4 },
    )).filter((shell) => shell !== null);
  });

  /**
   * Fills missing worktree paths from the task's own threads and saves them once found.
   * Launch creates the worktree after it returns, so the path comes late. Cleanup reuses it.
   */
  const resolveWorktreePaths = Effect.fn("TaskService.resolveWorktreePaths")(function* (
    task: Task,
    shells: ReadonlyArray<TaskShell>,
  ) {
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

  // Only tasks with a worktree still waiting for its path read thread shells; normally none.
  const list = Effect.fn("TaskService.list")(function* () {
    const tasks = yield* Effect.forEach(
      yield* store.listAll(),
      (task) =>
        hasPendingWorktree(task)
          ? readPendingShells(task).pipe(
              Effect.flatMap((shells) => resolveWorktreePaths(task, shells)),
            )
          : Effect.succeed(task),
      { concurrency: 4 },
    );
    return {
      tasks,
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

  /** Branch names a new task branch in the project must avoid, apart from other tasks' ones. */
  const localBranches = Effect.fn("TaskService.localBranches")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    // Deleting a task keeps its branches, so a new task must not reuse one.
    if (Option.isNone(project)) return [];
    return yield* git
      .listLocalBranchNames(project.value.workspaceRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  });

  const takenBranches = Effect.fn("TaskService.takenBranches")(function* (
    projectId: ProjectId,
    local: ReadonlyArray<string>,
  ) {
    const recorded = (yield* store.listAll()).flatMap((task) =>
      task.worktrees
        .filter((worktree) => worktree.projectId === projectId)
        .map((worktree) => worktree.branch),
    );
    return new Set([...local, ...recorded]);
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

  // The command that is creating a project's shared worktree right now, per task. Only code
  // under the write lock reads or changes it.
  const sharedLaunches = new Map<string, CommandId>();
  const sharedKey = (taskId: TaskId, projectId: ProjectId) => `${taskId}\u0000${projectId}`;

  const isLiveShared = (projectId: ProjectId) => (worktree: TaskWorktree) =>
    worktree.projectId === projectId && worktree.kind === "shared" && worktree.removedAt === null;

  type SharedWorktree =
    | { readonly type: "started"; readonly task: Task; readonly threadId: ThreadId }
    | { readonly type: "ready"; readonly worktreePath: string; readonly branch: string }
    | {
        readonly type: "reserved";
        readonly strategy: {
          readonly type: "worktree";
          readonly baseRef: string;
          readonly branch: string;
          readonly startFromOrigin: true;
        };
      };

  /**
   * Finds the project's shared worktree or reserves one for this command. The reservation
   * is saved before launch, so a concurrent start or new thread sees it and waits instead of
   * creating a second shared worktree.
   */
  const acquireShared = Effect.fn("TaskService.acquireShared")(function* (input: {
    readonly task: Task;
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly forStart: boolean;
  }) {
    const { projectId, commandId } = input;
    // Thread shells and git reads happen before the lock.
    const shells = yield* readPendingShells(input.task);
    const task = yield* resolveWorktreePaths(input.task, shells);
    const known = task.worktrees.find(isLiveShared(projectId));
    const fresh =
      known === undefined
        ? {
            baseRef: yield* defaultBaseRef(projectId),
            local: yield* localBranches(projectId),
          }
        : null;
    return yield* serialized(
      Effect.gen(function* () {
        const current = yield* requireTask(task.id);
        const firstThreadId = current.threadIds[0];
        if (input.forStart && firstThreadId !== undefined) {
          return { type: "started", task: current, threadId: firstThreadId } as SharedWorktree;
        }
        const key = sharedKey(current.id, projectId);
        const shared = current.worktrees.find(isLiveShared(projectId));
        if (shared === undefined) {
          if (fresh === null) return yield* worktreePreparing(current.id);
          const strategy = {
            type: "worktree",
            baseRef: fresh.baseRef,
            branch: taskBranchName(current.title, yield* takenBranches(projectId, fresh.local)),
            startFromOrigin: true,
          } as const;
          yield* save({
            ...current,
            worktrees: [
              ...current.worktrees,
              newWorktree({
                projectId,
                branch: strategy.branch,
                baseRef: strategy.baseRef,
                kind: "shared",
              }),
            ],
          });
          sharedLaunches.set(key, commandId);
          return { type: "reserved", strategy } as SharedWorktree;
        }
        if (shared.worktreePath !== null) {
          return {
            type: "ready",
            worktreePath: shared.worktreePath,
            branch: shared.branch,
          } as SharedWorktree;
        }
        const reserved: SharedWorktree = {
          type: "reserved",
          strategy: {
            type: "worktree",
            baseRef: shared.baseRef,
            branch: shared.branch,
            startFromOrigin: true,
          },
        };
        const inFlight = sharedLaunches.get(key);
        // The same command again is a retry, and launch replays it.
        if (inFlight !== undefined) {
          if (inFlight === commandId) return reserved;
          return yield* worktreePreparing(current.id);
        }
        // A thread linked after the shells were read may be creating it.
        const inspected = new Set(shells.map((shell) => shell.id));
        if (current.threadIds.some((threadId) => !inspected.has(threadId))) {
          return yield* worktreePreparing(current.id);
        }
        const owners = shells.filter(
          (shell) =>
            shell.deletedAt === null &&
            current.threadIds.includes(shell.id) &&
            shell.projectId === projectId &&
            shell.branch === shared.branch,
        );
        // No thread came of the reservation (its launch was cut short): this command takes it.
        if (owners.length === 0) {
          sharedLaunches.set(key, commandId);
          return reserved;
        }
        // Every thread meant to create it ended without a worktree, so preparation failed.
        // The reservation is dropped, so the next thread creates the worktree again.
        if (owners.every((shell) => ENDED_RUN_STATUSES.has(shell.status))) {
          yield* save({ ...current, worktrees: current.worktrees.filter((w) => w !== shared) });
          return yield* worktreeFailed(current.id, owners[0]?.lastError);
        }
        return yield* worktreePreparing(current.id);
      }),
    );
  });

  /** Launches into a reserved shared worktree; a failed launch gives the reservation back. */
  const launchShared = Effect.fn("TaskService.launchShared")(function* (
    task: Task,
    projectId: ProjectId,
    strategy: Extract<SharedWorktree, { type: "reserved" }>["strategy"],
    launch: Omit<TaskLaunch, "workspaceStrategy" | "projectId">,
    markInProgress: boolean,
  ) {
    const key = sharedKey(task.id, projectId);
    const release = serialized(
      Effect.gen(function* () {
        if (sharedLaunches.get(key) === launch.commandId) sharedLaunches.delete(key);
      }),
    );
    const launched = yield* launchThread(task, {
      ...launch,
      projectId,
      workspaceStrategy: strategy,
    }).pipe(
      Effect.onError(() =>
        serialized(
          Effect.gen(function* () {
            if (sharedLaunches.get(key) !== launch.commandId) return;
            sharedLaunches.delete(key);
            const current = yield* store.get(task.id);
            if (current === null) return;
            const worktrees = current.worktrees.filter(
              (worktree) =>
                !(
                  isLiveShared(projectId)(worktree) &&
                  worktree.branch === strategy.branch &&
                  worktree.worktreePath === null
                ),
            );
            if (worktrees.length !== current.worktrees.length) {
              yield* save({ ...current, worktrees });
            }
          }),
        ),
      ),
    );
    const result = yield* recordThread(task.id, {
      threadId: launched.threadId,
      projectId,
      worktree: null,
      markInProgress,
    }).pipe(Effect.ensuring(release));
    return result;
  });

  const start = Effect.fn("TaskService.start")(function* (input: TaskStartInput) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id });
    const task = yield* requireTask(input.id);
    const projectId = task.primaryProjectId;
    const shared =
      task.threadIds[0] === undefined
        ? yield* acquireShared({ task, projectId, commandId: input.commandId, forStart: true })
        : ({ type: "started", task, threadId: task.threadIds[0] } as const);
    const launch = {
      commandId: input.commandId,
      text: formatTaskPrompt(task),
      generateTitle: false,
      options: input,
    };
    switch (shared.type) {
      case "started": {
        // Review Focus 2: a started task only changes status again.
        const current =
          shared.task.status === "in_progress"
            ? shared.task
            : (yield* setStatus({ id: task.id, status: "in_progress" })).task;
        return { task: current, threadId: shared.threadId } satisfies TaskThreadResult;
      }
      case "ready": {
        // Its threads were detached, but the shared worktree is still there.
        const launched = yield* launchThread(task, {
          ...launch,
          projectId,
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: shared.worktreePath,
            branch: shared.branch,
          },
        });
        return yield* recordThread(task.id, {
          threadId: launched.threadId,
          projectId,
          worktree: null,
          markInProgress: true,
        });
      }
      case "reserved":
        return yield* launchShared(task, projectId, shared.strategy, launch, true);
    }
  });

  const newThread = Effect.fn("TaskService.newThread")(function* (input: TaskNewThreadInput) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id, "project.id": input.projectId });
    const task = yield* requireTask(input.id);
    const { projectId } = input;
    const userLaunch = {
      commandId: input.commandId,
      text: input.text,
      generateTitle: true,
      options: input,
    };
    const launch = (workspaceStrategy: TaskLaunch["workspaceStrategy"]) =>
      launchThread(task, { ...userLaunch, projectId, workspaceStrategy });
    const linkPlain = (threadId: ThreadId) =>
      recordThread(task.id, { threadId, projectId, worktree: null, markInProgress: false });

    if (input.workspace === "root") {
      return yield* linkPlain((yield* launch({ type: "root" })).threadId);
    }

    const forExtra = input.workspace === "extra";
    // An extra worktree branches off the shared one, so the shared one comes first. Its
    // thread gets the task prompt and its own command id; the user's text waits for the retry.
    const sharedCommandId = forExtra
      ? CommandId.make(`${input.commandId}:shared`)
      : input.commandId;
    const shared = yield* acquireShared({
      task,
      projectId,
      commandId: sharedCommandId,
      forStart: false,
    });
    if (shared.type === "started") return yield* worktreePreparing(task.id);
    if (shared.type === "reserved") {
      const result = yield* launchShared(
        task,
        projectId,
        shared.strategy,
        forExtra
          ? {
              commandId: sharedCommandId,
              text: formatTaskPrompt(task),
              generateTitle: false,
              options: input,
            }
          : userLaunch,
        false,
      );
      if (forExtra) return yield* worktreePreparing(task.id);
      return result;
    }

    if (!forExtra) {
      return yield* linkPlain(
        (yield* launch({
          type: "existing_worktree",
          worktreePath: shared.worktreePath,
          branch: shared.branch,
        })).threadId,
      );
    }

    const current = yield* requireTask(task.id);
    const ordinal =
      current.worktrees.filter((worktree) => worktree.projectId === projectId).length + 1;
    const branch = taskBranchName(
      `${task.title}-${ordinal}`,
      yield* takenBranches(projectId, yield* localBranches(projectId)),
    );
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
