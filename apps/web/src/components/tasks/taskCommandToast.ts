import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { taskErrorCode } from "./taskDetail.logic";

const WORKTREE_PREPARING_MESSAGE =
  "The task's worktree is still being prepared. Try again in a minute.";

/** Shows a failed task command; the server's `TaskError` messages are written for the user. */
export function toastTaskCommandFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag !== "Failure") return false;
  if (isAtomCommandInterrupted(result)) return true;
  const error = squashAtomCommandFailure(result);
  // Not a failure: the first thread of the task started, and the requested one comes on retry.
  if (taskErrorCode(error) === "shared_worktree_started") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "The task's first thread already started",
        description: (error as Error).message,
      }),
    );
    return true;
  }
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        taskErrorCode(error) === "worktree_preparing"
          ? WORKTREE_PREPARING_MESSAGE
          : error instanceof Error
            ? error.message
            : String(error),
    }),
  );
  return true;
}

/** Says why a task cannot start, where the start dialog would otherwise open. */
export function toastTaskStartBlocked(reason: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't start task",
      description: reason,
    }),
  );
}
