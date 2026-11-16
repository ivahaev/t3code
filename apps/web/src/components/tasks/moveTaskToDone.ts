import type {
  EnvironmentId,
  Task,
  TaskCleanupInput,
  TaskCleanupMode,
  TaskCleanupPreview,
  TaskCleanupPreviewInput,
  TaskCleanupResult,
  TaskMutationResult,
  TaskSetStatusInput,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { requestConfirmDialog } from "~/confirmDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { autoCleanupPlan, cleanupSummary, isEmptyCleanupPreview } from "./taskCleanup.logic";
import { toastTaskCommandFailure } from "./taskCommandToast";

type Command<Input, Output> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<Output, unknown>>;

/** What the cleanup dialog needs to open: the task and the items to offer. */
export interface TaskCleanupRequest {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly preview: TaskCleanupPreview;
  /** False when the mode is already `always`, so the dialog hides «Делать так всегда». */
  readonly offerAlways: boolean;
}

export interface MoveTaskToDoneDeps {
  readonly setTaskStatus: Command<TaskSetStatusInput, TaskMutationResult>;
  readonly previewTaskCleanup: Command<TaskCleanupPreviewInput, TaskCleanupPreview>;
  readonly cleanupTask: Command<TaskCleanupInput, TaskCleanupResult>;
  readonly openCleanupDialog: (request: TaskCleanupRequest) => void;
}

export function toastCleanupDone(result: TaskCleanupResult): void {
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: cleanupSummary(result.removedWorktrees, result.deletedBranches),
    }),
  );
}

/**
 * The one way a task moves to Done: dragging, the card menu, the `]` key and the status
 * selector on the task page all come here, so the cleanup of the task's worktrees and
 * branches follows the environment's mode everywhere.
 */
export async function moveTaskToDone(input: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly cleanupMode: TaskCleanupMode;
  readonly deps: MoveTaskToDoneDeps;
}): Promise<AtomCommandResult<TaskMutationResult, unknown>> {
  const { environmentId, task, cleanupMode, deps } = input;
  const moved = await deps.setTaskStatus({
    environmentId,
    input: { id: task.id, status: "done" },
  });
  if (moved._tag !== "Success" || cleanupMode === "never") return moved;

  const preview = await deps.previewTaskCleanup({ environmentId, input: { id: task.id } });
  if (toastTaskCommandFailure("Не удалось проверить worktree задачи", preview)) return moved;
  if (preview._tag !== "Success" || isEmptyCleanupPreview(preview.value)) return moved;

  if (cleanupMode === "ask") {
    deps.openCleanupDialog({ environmentId, task, preview: preview.value, offerAlways: true });
    return moved;
  }
  const plan = autoCleanupPlan(preview.value);
  if (plan.silent.worktreePaths.length > 0 || plan.silent.branches.length > 0) {
    const cleaned = await deps.cleanupTask({
      environmentId,
      input: { id: task.id, ...plan.silent },
    });
    if (cleaned._tag === "Success") toastCleanupDone(cleaned.value);
    else toastTaskCommandFailure("Не удалось убрать за задачей", cleaned);
  }
  if (plan.needsDialog !== null) {
    deps.openCleanupDialog({ environmentId, task, preview: plan.needsDialog, offerAlways: false });
  }
  return moved;
}

/** Asks before a task leaves Done when the move recreates its deleted branch. */
export async function confirmLeavingDone(message: string): Promise<boolean> {
  return (await requestConfirmDialog(message)) ?? window.confirm(message);
}
