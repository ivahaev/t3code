import { useDraggable } from "@dnd-kit/core";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { TaskStatus, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlayIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";
import { TopStatusIcon, type ThreadTopStatus } from "../sidebar/threadTopStatus";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  boardTaskKey,
  chatCountLabel,
  neighborStatus,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  type BoardTask,
} from "./taskBoard.logic";

export interface TaskCardThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: ThreadTopStatus | null;
}

const VISIBLE_THREADS = 5;

export interface TaskCardActions {
  readonly onMove: (entry: BoardTask, status: TaskStatus) => void;
  readonly onKeyboardMove: (entry: BoardTask, status: TaskStatus) => void;
  /** The card the keyboard moved has its focus back; later remounts must not take it again. */
  readonly onRefocused: () => void;
  readonly onEdit: (entry: BoardTask) => void;
  readonly onArchive: (entry: BoardTask) => void;
  readonly onUnarchive: (entry: BoardTask) => void;
  readonly onDelete: (entry: BoardTask) => void;
}

export function TaskCard({
  entry,
  projectNames,
  threads,
  canEdit,
  refocus,
  actions,
}: {
  readonly entry: BoardTask;
  readonly projectNames: ReadonlyArray<string>;
  /** The task's threads this client has loaded, in task order. */
  readonly threads: ReadonlyArray<TaskCardThread>;
  readonly canEdit: boolean;
  /** Set on the card the keyboard just moved, which remounts in its new column. */
  readonly refocus: boolean;
  readonly actions: TaskCardActions;
}) {
  const { task } = entry;
  const archived = task.archivedAt !== null;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: boardTaskKey(entry),
    data: entry,
    disabled: !canEdit || archived,
  });
  const hiddenThreads = task.threadIds.length - Math.min(threads.length, VISIBLE_THREADS);
  const moveBy = (step: -1 | 1) => {
    const next = neighborStatus(task.status, step);
    if (next !== null) actions.onKeyboardMove(entry, next);
  };
  return (
    <article
      ref={(node) => {
        setNodeRef(node);
        // Focus returns only while it is lost with the remount, never taken from elsewhere.
        if (refocus && node !== null && document.activeElement === document.body) {
          node.focus();
          actions.onRefocused();
        }
      }}
      {...listeners}
      tabIndex={0}
      aria-label={task.title}
      aria-keyshortcuts="[ ]"
      data-dragging={isDragging || undefined}
      onKeyDown={(event) => {
        // Only the focused card itself: its buttons and menu keep their own keys.
        if (event.target !== event.currentTarget || !canEdit || archived) return;
        // Physical keys, so the shortcut also works on layouts where they type other letters.
        if (event.code === "BracketLeft" || event.code === "BracketRight") {
          event.preventDefault();
          moveBy(event.code === "BracketLeft" ? -1 : 1);
        }
      }}
      className={cn(
        "group/task-card flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-card-foreground shadow-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        canEdit && !archived && "cursor-grab",
        isDragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-1">
        <h3 className="min-w-0 flex-1 text-sm font-medium break-words">
          <Link
            to="/tasks/$environmentId/$taskId"
            params={{ environmentId: entry.environmentId, taskId: task.id }}
            className="hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {task.title}
          </Link>
        </h3>
        <TaskCardMenu entry={entry} canEdit={canEdit} actions={actions} />
      </div>
      {projectNames.length > 0 ? (
        <p className="truncate text-xs text-muted-foreground">{projectNames.join(" · ")}</p>
      ) : null}
      {threads.length > 0 ? (
        <ul className="-mx-1 flex flex-col">
          {threads.slice(0, VISIBLE_THREADS).map((thread) => (
            <li key={thread.id}>
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(entry.environmentId, thread.id))}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                {thread.status ? (
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 font-medium",
                      thread.status.className,
                    )}
                  >
                    <TopStatusIcon icon={thread.status.icon} className="size-3" />
                    {thread.status.label}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenThreads > 0 || (task.status === "backlog" && !archived) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {hiddenThreads > 0 ? (
            <Link
              to="/tasks/$environmentId/$taskId"
              params={{ environmentId: entry.environmentId, taskId: task.id }}
              className="hover:text-foreground hover:underline"
            >
              +{chatCountLabel(hiddenThreads)}
            </Link>
          ) : null}
          {task.status === "backlog" && !archived ? (
            <Button
              size="xs"
              variant="outline"
              className="ms-auto"
              disabled={!canEdit}
              onClick={() => actions.onMove(entry, "in_progress")}
            >
              <PlayIcon />
              Start
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TaskCardMenu({
  entry,
  canEdit,
  actions,
}: {
  readonly entry: BoardTask;
  readonly canEdit: boolean;
  readonly actions: TaskCardActions;
}) {
  const { task } = entry;
  const archived = task.archivedAt !== null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Actions for ${task.title}`}
            disabled={!canEdit}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {archived
          ? null
          : TASK_STATUSES.filter((status) => status !== task.status).map((status) => (
              <MenuItem key={status} onClick={() => actions.onMove(entry, status)}>
                Move to {TASK_STATUS_LABEL[status]}
              </MenuItem>
            ))}
        {archived ? null : <MenuItem onClick={() => actions.onEdit(entry)}>Edit</MenuItem>}
        {archived ? null : <MenuSeparator />}
        {archived ? (
          <MenuItem onClick={() => actions.onUnarchive(entry)}>Restore</MenuItem>
        ) : (
          <MenuItem onClick={() => actions.onArchive(entry)}>Archive</MenuItem>
        )}
        <MenuItem variant="destructive" onClick={() => actions.onDelete(entry)}>
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
