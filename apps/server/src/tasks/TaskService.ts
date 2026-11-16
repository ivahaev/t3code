import {
  CommandId,
  type GitCommandError,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { formatTaskPrompt, taskBranchName } from "./taskBranch.ts";
import {
  branchMergeState,
  type CleanupPath,
  type CleanupProject,
  currentBranch,
  isDeletableBranch,
  isPendingWorktree,
  mergeBaseCandidates,
  removableWorktreePath,
  resolveBaseCommit,
  resolveCommit,
  worktreeBlocker,
  type WorktreePathState,
} from "./taskCleanup.ts";
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
 * Fills a missing worktree path from the first of the task's threads on the same branch in
 * the same project. Launch creates the worktree after it returns, so the path comes late.
 */
const fillWorktreePaths = (
  worktrees: ReadonlyArray<TaskWorktree>,
  shells: ReadonlyArray<TaskStore.ThreadWorkspace>,
): ReadonlyArray<TaskWorktree> =>
  worktrees.map((worktree) => {
    if (worktree.worktreePath !== null || worktree.removedAt !== null) return worktree;
    const worktreePath =
      shells.find(
        (shell) =>
          shell.worktreePath !== null &&
          shell.projectId === worktree.projectId &&
          shell.branch === worktree.branch,
      )?.worktreePath ?? null;
    return worktreePath === null ? worktree : { ...worktree, worktreePath };
  });

const hasPendingWorktree = (task: Task) => task.worktrees.some(isPendingWorktree);

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
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
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
   * Fills missing worktree paths from the task's own live threads and saves them once found.
   * Launch creates the worktree after it returns, so the path comes late. Cleanup reuses it.
   * Null when the task was deleted meanwhile.
   */
  const resolveWorktreePaths = Effect.fn("TaskService.resolveWorktreePaths")(function* (
    task: Task,
    shells: ReadonlyArray<TaskStore.ThreadWorkspace & { readonly deletedAt: unknown }>,
  ) {
    const live = shells.filter((shell) => shell.deletedAt === null);
    if (fillWorktreePaths(task.worktrees, live).every((w, i) => w === task.worktrees[i])) {
      return task;
    }
    return yield* serialized(
      Effect.gen(function* () {
        const current = yield* store.get(task.id);
        if (current === null) return null;
        const worktrees = fillWorktreePaths(current.worktrees, live);
        if (worktrees.every((w, i) => w === current.worktrees[i])) return current;
        return (yield* save({ ...current, worktrees })).task;
      }),
    );
  });

  const resolveExistingWorktreePaths = Effect.fn("TaskService.resolveExistingWorktreePaths")(
    function* (task: Task, shells: ReadonlyArray<TaskShell>) {
      const resolved = yield* resolveWorktreePaths(task, shells);
      return resolved ?? (yield* requireTask(task.id));
    },
  );

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
      tasks: tasks.filter((task) => task !== null),
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

  /**
   * Unlinks a thread, first taking the worktree path it made for a record still waiting for
   * one: once unlinked, nothing else would tell the task where its worktree is.
   */
  const unlinkThread = Effect.fn("TaskService.unlinkThread")(function* (
    task: Task,
    threadId: ThreadId,
    workspace: TaskStore.ThreadWorkspace | null,
  ) {
    return yield* save({
      ...task,
      worktrees:
        workspace === null ? task.worktrees : fillWorktreePaths(task.worktrees, [workspace]),
      threadIds: task.threadIds.filter((id) => id !== threadId),
    });
  });

  // The thread is deleted already, so only its projection row still knows its worktree.
  const removeThread = Effect.fn("TaskService.removeThread")(function* (threadId: ThreadId) {
    const owner = yield* store.findTaskByThread(threadId);
    const task = owner === null ? null : yield* store.get(owner);
    if (task === null) return;
    const workspace = hasPendingWorktree(task) ? yield* store.getThreadWorkspace(threadId) : null;
    yield* unlinkThread(task, threadId, workspace);
  }, serialized);

  const detachThread = Effect.fn("TaskService.detachThread")(function* (
    input: TaskDetachThreadInput,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    return yield* serialized(
      Effect.gen(function* () {
        const task = yield* requireTask(input.id);
        return yield* unlinkThread(
          task,
          input.threadId,
          shell === null || shell.deletedAt !== null ? null : shell,
        );
      }),
    );
  });

  /** Saves a worktree path as soon as a task thread reports it, before anyone lists tasks. */
  const trackWorktreePath = Effect.fn("TaskService.trackWorktreePath")(function* (
    thread: TaskStore.ThreadWorkspace & {
      readonly id: ThreadId;
      readonly deletedAt: unknown;
    },
  ) {
    if (thread.worktreePath === null || thread.branch === null) return;
    const owner = yield* store.findTaskByThread(thread.id);
    const task = owner === null ? null : yield* store.get(owner);
    if (task === null || !hasPendingWorktree(task)) return;
    yield* resolveWorktreePaths(task, [thread]);
  });
  yield* forkParked(
    Stream.runForEach(threadManagement.streamDomainEvents, (event) =>
      event.type === "thread.metadata-updated" ? trackWorktreePath(event.payload) : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Task worktree path tracking stopped", { cause }),
      ),
    ),
  );

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
    const task = yield* resolveExistingWorktreePaths(input.task, shells);
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
      Effect.sync(() => {
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

  /** The task with worktree paths that its threads have reported since launch. */
  const resolveForCleanup = Effect.fn("TaskService.resolveForCleanup")(function* (id: TaskId) {
    const task = yield* requireTask(id);
    return yield* resolveExistingWorktreePaths(task, yield* readPendingShells(task));
  });

  const runGit = <A>(
    taskId: TaskId,
    message: string,
    effect: Effect.Effect<A, GitCommandError, GitVcsDriver.GitVcsDriver>,
  ) =>
    effect.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, vcs),
      Effect.mapError((cause) => new TaskError({ message, taskId, cause })),
    );

  /** The real path, so another spelling of the same folder matches; the path itself if missing. */
  const canonicalPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));

  /**
   * Reads what cleanup needs about one project, or null when the project is gone. Any failure
   * to learn which worktrees other threads use fails cleanup, so nothing in use is offered.
   */
  const inspectCleanupProject = Effect.fn("TaskService.inspectCleanupProject")(function* (
    task: Task,
    projectId: ProjectId,
  ) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) return null;
    const cwd = project.value.workspaceRoot;
    const listed = yield* runGit(
      task.id,
      "Could not list the project's worktrees.",
      vcs.listWorktreePaths(cwd),
    );
    const livePaths = new Set(yield* Effect.forEach(listed, canonicalPath));
    // Archived threads count too: unarchiving one brings its worktree back into use.
    const snapshot = yield* threadManagement.getShellSnapshot({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new TaskError({
            message: "Could not read the project's threads.",
            taskId: task.id,
            cause,
          }),
      ),
    );
    const taskThreads = new Set<string>(task.threadIds);
    const foreign = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (shell) =>
        shell.projectId === projectId && shell.deletedAt === null && !taskThreads.has(shell.id),
    );
    const foreignPaths = new Set(
      yield* Effect.forEach(
        foreign.flatMap((shell) => (shell.worktreePath === null ? [] : [shell.worktreePath])),
        canonicalPath,
      ),
    );
    const foreignBranches = new Set(
      foreign.flatMap((shell) => (shell.branch === null ? [] : [shell.branch])),
    );
    const mainCheckout = yield* canonicalPath(cwd);
    const paths = new Map<string, CleanupPath>();
    for (const worktree of task.worktrees) {
      const path = worktree.worktreePath;
      if (worktree.projectId !== projectId || path === null || paths.has(path)) continue;
      const canonical = yield* canonicalPath(path);
      // A failed check counts as present, so the folder is never assumed gone.
      const state: WorktreePathState = livePaths.has(canonical)
        ? "live"
        : (yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => true)))
          ? "stray"
          : "gone";
      paths.set(path, {
        state,
        foreign: foreignPaths.has(canonical),
        mainCheckout: canonical === mainCheckout,
      });
    }
    const defaultBranch = yield* git
      .resolveDefaultBranchName(cwd, "origin")
      .pipe(Effect.orElseSucceed(() => null));
    const checkedOut = yield* runGit(
      task.id,
      "Could not read the project's current branch.",
      currentBranch(cwd),
    );
    const protectedBranches = new Set(["main", "master"]);
    if (defaultBranch !== null) protectedBranches.add(defaultBranch);
    if (checkedOut !== null) protectedBranches.add(checkedOut);
    return {
      cwd,
      paths,
      foreignBranches,
      protectedBranches,
      baseBranches: defaultBranch === null ? ["main", "master"] : [defaultBranch],
    } satisfies CleanupProject;
  });

  const inspectCleanupProjects = Effect.fn("TaskService.inspectCleanupProjects")(function* (
    task: Task,
  ) {
    const projectIds = [...new Set(task.worktrees.map((worktree) => worktree.projectId))];
    const inspected = yield* Effect.forEach(
      projectIds,
      (projectId) =>
        inspectCleanupProject(task, projectId).pipe(
          Effect.map((project) => [projectId, project] as const),
        ),
      { concurrency: 4 },
    );
    return new Map(
      inspected.flatMap(([projectId, project]) =>
        project === null ? [] : [[projectId, project] as const],
      ),
    );
  });

  /** The branch's merge state against its base, with the base commit pinned for a later check. */
  const mergeState = Effect.fn("TaskService.mergeState")(function* (
    taskId: TaskId,
    project: CleanupProject,
    worktree: TaskWorktree,
  ) {
    return yield* runGit(
      taskId,
      `Could not check whether ${worktree.branch} is merged.`,
      Effect.gen(function* () {
        const baseCommit = yield* resolveBaseCommit(
          project.cwd,
          mergeBaseCandidates(worktree, project),
        );
        if (baseCommit !== null) {
          return {
            ...(yield* branchMergeState(project.cwd, worktree.branch, baseCommit)),
            baseCommit,
          };
        }
        // With no base to compare, the branch never counts as merged.
        const exists =
          (yield* resolveCommit(project.cwd, `refs/heads/${worktree.branch}`)) !== null;
        return { exists, merged: !exists, unmergedCommitCount: 0, baseCommit };
      }),
    );
  });

  const dirtyFileCount = Effect.fn("TaskService.dirtyFileCount")(function* (
    taskId: TaskId,
    project: CleanupProject,
    worktreePath: string,
  ) {
    // Git no longer lists it, so there is nothing to read and cleanup only marks it.
    if (project.paths.get(worktreePath)?.state !== "live") return 0;
    const status = yield* runGit(
      taskId,
      "Could not read the worktree's changes.",
      vcs.statusDetailsLocal(worktreePath),
    );
    const files = status.workingTree.files.length;
    return files > 0 || !status.hasWorkingTreeChanges ? files : 1;
  });

  /** Each branch once per project, with the task worktree that decides its base. */
  const branchRecords = (worktrees: ReadonlyArray<TaskWorktree>) => {
    const byBranch = new Map<string, TaskWorktree>();
    for (const worktree of worktrees) {
      const key = `${worktree.projectId}\u0000${worktree.branch}`;
      const known = byBranch.get(key);
      // The shared record wins: its base is the default branch.
      if (known === undefined || (known.kind === "extra" && worktree.kind === "shared")) {
        byBranch.set(key, worktree);
      }
    }
    return [...byBranch.values()];
  };

  // Only git reads; the write lock is not taken.
  const cleanupPreview = Effect.fn("TaskService.cleanupPreview")(function* (
    input: TaskCleanupPreviewInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id });
    const task = yield* resolveForCleanup(input.id);
    const inspected = yield* inspectCleanupProjects(task);
    const worktrees: Array<TaskCleanupPreview["worktrees"][number]> = [];
    for (const worktree of task.worktrees) {
      const project = inspected.get(worktree.projectId);
      const path = project === undefined ? null : removableWorktreePath(worktree, project);
      if (project === undefined || path === null) continue;
      worktrees.push({
        projectId: worktree.projectId,
        path,
        branch: worktree.branch,
        dirtyFileCount: yield* dirtyFileCount(task.id, project, path),
      });
    }
    const branches: Array<TaskCleanupPreview["branches"][number]> = [];
    for (const record of branchRecords(task.worktrees)) {
      const project = inspected.get(record.projectId);
      if (project === undefined) continue;
      const records = task.worktrees.filter((worktree) => worktree.projectId === record.projectId);
      if (!isDeletableBranch(record.branch, records, project)) continue;
      const state = yield* mergeState(task.id, project, record);
      branches.push({
        projectId: record.projectId,
        branch: record.branch,
        merged: state.merged,
        unmergedCommitCount: state.unmergedCommitCount,
      });
    }
    return { worktrees, branches } satisfies TaskCleanupPreview;
  });

  /**
   * Removes the selected worktrees, then the selected branches, and marks them in the task.
   * Everything selected is checked before Git touches anything. Git runs outside the write
   * lock; only the marks are written under it.
   */
  const cleanup = Effect.fn("TaskService.cleanup")(function* (input: TaskCleanupInput) {
    yield* Effect.annotateCurrentSpan({ "task.id": input.id });
    const task = yield* resolveForCleanup(input.id);
    if (input.worktreePaths.length === 0 && input.branches.length === 0) {
      return { task, removedWorktrees: 0, deletedBranches: 0 } satisfies TaskCleanupResult;
    }
    const inspected = yield* inspectCleanupProjects(task);
    const refuse = (message: string) => new TaskError({ message, taskId: task.id });

    interface Removal {
      readonly projectId: ProjectId;
      readonly project: CleanupProject;
      readonly path: string;
      readonly branch: string;
      /** Only a worktree the user selected may lose uncommitted changes. */
      readonly force: boolean;
    }
    const removals: Array<Removal> = [];
    for (const path of new Set(input.worktreePaths)) {
      const worktree = task.worktrees.find(
        (candidate) => candidate.worktreePath === path && candidate.removedAt === null,
      );
      const project = worktree === undefined ? undefined : inspected.get(worktree.projectId);
      if (worktree === undefined || project === undefined) {
        return yield* refuse(`${path} is not a worktree of this task.`);
      }
      const blocker = worktreeBlocker(worktree, project);
      if (blocker !== null) return yield* refuse(`${path} stays: ${blocker}.`);
      removals.push({
        projectId: worktree.projectId,
        project,
        path,
        branch: worktree.branch,
        force: true,
      });
    }

    interface Deletion {
      readonly projectId: ProjectId;
      readonly project: CleanupProject;
      readonly branch: string;
      readonly record: TaskWorktree;
      readonly force: boolean;
      readonly exists: boolean;
      readonly baseCommit: string | null;
    }
    const deletions: Array<Deletion> = [];
    const selectedBranches = new Map(
      input.branches.map((selected) => [`${selected.projectId}\u0000${selected.branch}`, selected]),
    );
    for (const selected of selectedBranches.values()) {
      const records = task.worktrees.filter(
        (worktree) => worktree.projectId === selected.projectId,
      );
      const record = branchRecords(records).find((worktree) => worktree.branch === selected.branch);
      const project = inspected.get(selected.projectId);
      if (record === undefined || project === undefined) {
        return yield* refuse(`${selected.branch} is not a branch of this task.`);
      }
      if (
        records.some(
          (worktree) => worktree.branch === selected.branch && isPendingWorktree(worktree),
        )
      ) {
        return yield* worktreePreparing(task.id);
      }
      if (!isDeletableBranch(selected.branch, records, project)) {
        return yield* refuse(`${selected.branch} is in use outside this task, so it stays.`);
      }
      const state = yield* mergeState(task.id, project, record);
      if (state.exists && !state.merged && !selected.force) {
        return yield* refuse(
          state.baseCommit === null
            ? `The base branch of ${selected.branch} could not be determined; confirm to delete it anyway.`
            : `${selected.branch} has ${state.unmergedCommitCount} unmerged commits; confirm to delete it anyway.`,
        );
      }
      // Git cannot delete a branch while a worktree has it checked out, so that worktree goes too,
      // but only when it is clean: uncommitted changes go only if the user selected the worktree.
      for (const worktree of records) {
        const path =
          worktree.branch === selected.branch ? removableWorktreePath(worktree, project) : null;
        if (path === null || removals.some((removal) => removal.path === path)) continue;
        const dirty = yield* dirtyFileCount(task.id, project, path);
        if (dirty > 0) {
          return yield* refuse(
            `${selected.branch} stays: ${path} has ${dirty} uncommitted files; select that worktree to remove it.`,
          );
        }
        removals.push({
          projectId: selected.projectId,
          project,
          path,
          branch: selected.branch,
          force: false,
        });
      }
      deletions.push({
        projectId: selected.projectId,
        project,
        branch: selected.branch,
        record,
        force: selected.force,
        exists: state.exists,
        baseCommit: state.baseCommit,
      });
    }

    const failures: Array<string> = [];
    const removedPaths = new Set<string>();
    for (const removal of removals) {
      // A path that is gone from disk only leaves Git metadata to prune.
      const effect =
        removal.project.paths.get(removal.path)?.state === "live"
          ? vcs.removeWorktree({
              cwd: removal.project.cwd,
              path: removal.path,
              force: removal.force,
            })
          : vcs.pruneWorktrees({ cwd: removal.project.cwd });
      const result = yield* Effect.result(
        runGit(task.id, `Could not remove ${removal.path}.`, effect),
      );
      if (Result.isSuccess(result)) removedPaths.add(removal.path);
      else failures.push(result.failure.message);
    }

    const deletedBranches = new Set<string>();
    // Extra branches first: they are measured against the task branch.
    const ordered = deletions.toSorted(
      (a, b) => Number(a.record.kind === "shared") - Number(b.record.kind === "shared"),
    );
    for (const deletion of ordered) {
      const key = `${deletion.projectId}\u0000${deletion.branch}`;
      const blocked = removals.some(
        (removal) =>
          removal.projectId === deletion.projectId &&
          removal.branch === deletion.branch &&
          !removedPaths.has(removal.path),
      );
      if (blocked) {
        failures.push(`${deletion.branch} stays: its worktree could not be removed.`);
        continue;
      }
      if (!deletion.exists) {
        deletedBranches.add(key);
        continue;
      }
      const deleted = yield* Effect.result(
        Effect.gen(function* () {
          // Its worktree is gone now, so nothing adds commits after this check. The base is
          // the commit pinned before, so deleting the task branch does not move it.
          const state =
            deletion.baseCommit === null
              ? null
              : yield* runGit(
                  task.id,
                  `Could not check whether ${deletion.branch} is merged.`,
                  branchMergeState(deletion.project.cwd, deletion.branch, deletion.baseCommit),
                );
          if (state !== null && !state.exists) return;
          if ((state === null || !state.merged) && !deletion.force) {
            return yield* refuse(`${deletion.branch} gained unmerged commits, so it stays.`);
          }
          // "Merged" was checked against the task's base; `git branch -d` would check HEAD.
          yield* runGit(
            task.id,
            `Could not delete ${deletion.branch}.`,
            vcs.deleteLocalBranch({
              cwd: deletion.project.cwd,
              refName: deletion.branch,
              force: true,
            }),
          );
        }),
      );
      if (Result.isSuccess(deleted)) deletedBranches.add(key);
      else failures.push(deleted.failure.message);
    }

    const result = yield* serialized(
      Effect.gen(function* () {
        const current = yield* requireTask(task.id);
        const now = yield* nowIso;
        let removedWorktrees = 0;
        const deletedKeys = new Set<string>();
        const worktrees = current.worktrees.map((worktree) => {
          let next = worktree;
          if (
            worktree.removedAt === null &&
            worktree.worktreePath !== null &&
            removedPaths.has(worktree.worktreePath)
          ) {
            next = { ...next, removedAt: now };
            removedWorktrees += 1;
          }
          if (
            worktree.branchDeletedAt === null &&
            deletedBranches.has(`${worktree.projectId}\u0000${worktree.branch}`)
          ) {
            next = { ...next, branchDeletedAt: now };
            deletedKeys.add(`${worktree.projectId}\u0000${worktree.branch}`);
          }
          return next;
        });
        const saved =
          removedWorktrees === 0 && deletedKeys.size === 0
            ? current
            : (yield* save({ ...current, worktrees })).task;
        return { task: saved, removedWorktrees, deletedBranches: deletedKeys.size };
      }),
    );
    if (failures.length > 0) {
      return yield* refuse(failures.join(" "));
    }
    return result satisfies TaskCleanupResult;
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
