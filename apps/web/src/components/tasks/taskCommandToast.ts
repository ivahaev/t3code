import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { taskErrorCode } from "./taskDetail.logic";

const WORKTREE_PREPARING_MESSAGE = "Worktree задачи ещё готовится, попробуйте через минуту";

/** Shows a failed task command; the server's `TaskError` messages are written for the user. */
export function toastTaskCommandFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag !== "Failure") return false;
  if (isAtomCommandInterrupted(result)) return true;
  const error = squashAtomCommandFailure(result);
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
