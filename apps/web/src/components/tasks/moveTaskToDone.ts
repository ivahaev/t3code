import type {
  EnvironmentId,
  Task,
  TaskMutationResult,
  TaskSetStatusInput,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface MoveTaskToDoneDeps {
  readonly setTaskStatus: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: TaskSetStatusInput;
  }) => Promise<AtomCommandResult<TaskMutationResult, unknown>>;
}

/**
 * The one way the board moves a task to Done: dragging, the card menu and the `]` key all
 * come here, so the cleanup offer for the task's worktrees and branches has a single home.
 */
export function moveTaskToDone(input: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly deps: MoveTaskToDoneDeps;
}): Promise<AtomCommandResult<TaskMutationResult, unknown>> {
  return input.deps.setTaskStatus({
    environmentId: input.environmentId,
    input: { id: input.task.id, status: "done" },
  });
}
