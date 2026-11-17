import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { SquareKanbanIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { tasksEnvironment } from "~/state/tasks";
import { Badge } from "../ui/badge";
import { taskChipLabel, threadTaskIndex } from "./threadTask.logic";

// One index per environment; every sidebar row selects its own thread from it, so a task
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

/** The thread's task, or null; re-renders only when that task's id or title changes. */
export function useThreadTask(environmentId: EnvironmentId, threadId: ThreadId) {
  const index = threadTaskIndexAtom(environmentId);
  const taskId = useAtomValue(index, (tasks) => tasks.get(threadId)?.id ?? null);
  const title = useAtomValue(index, (tasks) => tasks.get(threadId)?.title ?? null);
  return taskId === null || title === null ? null : { id: taskId, title };
}

/** The thread's task as a link that opens the task page. */
export function ThreadTaskChip({
  environmentId,
  task,
  layout,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: { readonly id: TaskId; readonly title: string } | null;
  /** A short badge beside the title, or a full-width line of its own. */
  readonly layout: "chip" | "line";
}) {
  if (task === null) return null;
  const title = task.title;
  const linkProps = {
    to: "/tasks/$environmentId/$taskId",
    params: { environmentId, taskId: task.id },
    // The row opens the thread; the task link opens the task instead, also by Enter or double-click.
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
    // Only activation keys; arrows still move through the sidebar rows.
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    },
  } as const;
  if (layout === "line") {
    return (
      <Link
        {...linkProps}
        aria-label={`Task: ${title}`}
        className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        <SquareKanbanIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
      </Link>
    );
  }
  return (
    <Badge
      variant="outline"
      size="sm"
      title={`Task: ${title}`}
      aria-label={`Task: ${title}`}
      render={<Link {...linkProps} />}
    >
      {taskChipLabel(title)}
    </Badge>
  );
}
