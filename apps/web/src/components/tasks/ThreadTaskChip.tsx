import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";

import { tasksEnvironment } from "~/state/tasks";
import { Badge } from "../ui/badge";
import { taskChipLabel, threadTaskIndex } from "./threadTask.logic";

// One index per environment; every sidebar row selects its own chat from it, so a task
// update re-renders only the rows whose task id or title changed.
const threadTaskIndexAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    threadTaskIndex(
      AsyncResult.getOrElse(
        get(tasksEnvironment.tasksLive({ environmentId, input: {} })),
        () => null,
      )?.tasks ?? [],
    ),
  ).pipe(Atom.withLabel(`web-thread-task-index:${environmentId}`)),
);

/** The chat's task as a short chip that opens the task page. */
export function ThreadTaskChip({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const index = threadTaskIndexAtom(environmentId);
  const taskId = useAtomValue(index, (tasks) => tasks.get(threadId)?.id ?? null);
  const title = useAtomValue(index, (tasks) => tasks.get(threadId)?.title ?? null);
  if (taskId === null || title === null) return null;
  return (
    <Badge
      variant="outline"
      size="sm"
      title={`Задача: ${title}`}
      aria-label={`Задача: ${title}`}
      render={
        <Link
          to="/tasks/$environmentId/$taskId"
          params={{ environmentId, taskId }}
          // The row opens the chat; the chip opens the task instead, also by Enter or double-click.
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          // Only activation keys; arrows still move through the sidebar rows.
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        />
      }
    >
      {taskChipLabel(title)}
    </Badge>
  );
}
