import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export { TaskId };

export const TaskStatus = Schema.Literals(["backlog", "in_progress", "review", "done"]);
export type TaskStatus = typeof TaskStatus.Type;

export const TaskWorktreeKind = Schema.Literals(["shared", "extra"]);
export type TaskWorktreeKind = typeof TaskWorktreeKind.Type;

export const TaskWorktree = Schema.Struct({
  projectId: ProjectId,
  branch: Schema.String,
  baseRef: Schema.String,
  kind: TaskWorktreeKind,
  worktreePath: Schema.NullOr(Schema.String),
  removedAt: Schema.NullOr(IsoDateTime),
  branchDeletedAt: Schema.NullOr(IsoDateTime),
});
export type TaskWorktree = typeof TaskWorktree.Type;

export const Task = Schema.Struct({
  id: TaskId,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  link: Schema.NullOr(Schema.String),
  status: TaskStatus,
  primaryProjectId: ProjectId,
  projectIds: Schema.Array(ProjectId),
  worktrees: Schema.Array(TaskWorktree),
  threadIds: Schema.Array(ThreadId),
  sortKey: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Task = typeof Task.Type;

export const TaskCleanupMode = Schema.Literals(["ask", "always", "never"]);
export type TaskCleanupMode = typeof TaskCleanupMode.Type;

export const TaskListInput = Schema.Struct({});
export type TaskListInput = typeof TaskListInput.Type;

export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(Task),
  settings: Schema.Struct({ cleanupMode: TaskCleanupMode }),
});
export type TaskListResult = typeof TaskListResult.Type;

export const TaskUpsertInput = Schema.Struct({
  id: Schema.optional(TaskId),
  title: TrimmedNonEmptyString,
  description: Schema.String,
  link: Schema.NullOr(Schema.String),
  primaryProjectId: ProjectId,
  projectIds: Schema.Array(ProjectId),
});
export type TaskUpsertInput = typeof TaskUpsertInput.Type;

export const TaskSetStatusInput = Schema.Struct({
  id: TaskId,
  status: TaskStatus,
  sortKey: Schema.optional(Schema.Number),
});
export type TaskSetStatusInput = typeof TaskSetStatusInput.Type;

export const TaskIdInput = Schema.Struct({ id: TaskId });
export type TaskIdInput = typeof TaskIdInput.Type;

export const TaskStartInput = Schema.Struct({
  id: TaskId,
  commandId: CommandId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type TaskStartInput = typeof TaskStartInput.Type;

export const TaskNewThreadInput = Schema.Struct({
  id: TaskId,
  commandId: CommandId,
  projectId: ProjectId,
  workspace: Schema.Literals(["shared", "extra", "root"]),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  text: Schema.String,
});
export type TaskNewThreadInput = typeof TaskNewThreadInput.Type;

export const TaskAttachThreadInput = Schema.Struct({
  id: TaskId,
  threadId: ThreadId,
  moveFromOtherTask: Schema.Boolean,
});
export type TaskAttachThreadInput = typeof TaskAttachThreadInput.Type;

export const TaskDetachThreadInput = Schema.Struct({ id: TaskId, threadId: ThreadId });
export type TaskDetachThreadInput = typeof TaskDetachThreadInput.Type;

export const TaskAddProjectInput = Schema.Struct({ id: TaskId, projectId: ProjectId });
export type TaskAddProjectInput = typeof TaskAddProjectInput.Type;

export const TaskCleanupPreviewInput = Schema.Struct({ id: TaskId });
export type TaskCleanupPreviewInput = typeof TaskCleanupPreviewInput.Type;

export const TaskCleanupInput = Schema.Struct({
  id: TaskId,
  worktreePaths: Schema.Array(Schema.String),
  branches: Schema.Array(
    Schema.Struct({ projectId: ProjectId, branch: Schema.String, force: Schema.Boolean }),
  ),
});
export type TaskCleanupInput = typeof TaskCleanupInput.Type;

export const TaskSetCleanupModeInput = Schema.Struct({ mode: TaskCleanupMode });
export type TaskSetCleanupModeInput = typeof TaskSetCleanupModeInput.Type;

export const TaskMutationResult = Schema.Struct({ task: Task });
export type TaskMutationResult = typeof TaskMutationResult.Type;

export const TaskThreadResult = Schema.Struct({ task: Task, threadId: ThreadId });
export type TaskThreadResult = typeof TaskThreadResult.Type;

export const TaskCleanupPreview = Schema.Struct({
  worktrees: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      path: Schema.String,
      branch: Schema.String,
      dirtyFileCount: NonNegativeInt,
    }),
  ),
  branches: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      branch: Schema.String,
      merged: Schema.Boolean,
      unmergedCommitCount: NonNegativeInt,
    }),
  ),
});
export type TaskCleanupPreview = typeof TaskCleanupPreview.Type;

export const TaskCleanupResult = Schema.Struct({
  task: Task,
  removedWorktrees: NonNegativeInt,
  deletedBranches: NonNegativeInt,
});
export type TaskCleanupResult = typeof TaskCleanupResult.Type;

export class TaskError extends Schema.TaggedError<TaskError>()("TaskError", {
  message: Schema.String,
  taskId: Schema.optional(TaskId),
  code: Schema.optional(Schema.Literals(["already_attached", "worktree_preparing", "not_found"])),
  cause: Schema.optional(Schema.Defect()),
}) {}
