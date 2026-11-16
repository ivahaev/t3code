import { useDraggable } from "@dnd-kit/core";
import type { TaskStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlayIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { taskAttentionLabel, type TaskAttention } from "./taskAttention.logic";
import {
  boardTaskKey,
  chatCountLabel,
  neighborStatus,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  type BoardTask,
} from "./taskBoard.logic";

const ATTENTION_CLASS_NAME = {
  attention: "text-warning-foreground",
  failed: "text-destructive-foreground",
  unread: "text-success-foreground",
  working: "text-info-foreground",
} as const;

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
  attention,
  canEdit,
  refocus,
  actions,
}: {
  readonly entry: BoardTask;
  readonly projectNames: ReadonlyArray<string>;
  readonly attention: TaskAttention;
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
  const flag = taskAttentionLabel(attention);
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
        <p className="truncate text-xs text-muted-foreground">{projectNames.join(" ")}</p>
      ) : null}
      {task.threadIds.length > 0 || flag !== null || (task.status === "backlog" && !archived) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {task.threadIds.length > 0 ? <span>{chatCountLabel(task.threadIds.length)}</span> : null}
          {flag !== null && attention !== null ? (
            <span className={ATTENTION_CLASS_NAME[attention]}>
              {flag.glyph} {flag.text}
            </span>
          ) : null}
          {task.status === "backlog" && !archived ? (
            <Button
              size="xs"
              variant="outline"
              className="ms-auto"
              disabled={!canEdit}
              onClick={() => actions.onMove(entry, "in_progress")}
            >
              <PlayIcon />В работу
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
            aria-label={`Действия: ${task.title}`}
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
                Перенести в {TASK_STATUS_LABEL[status]}
              </MenuItem>
            ))}
        {archived ? null : <MenuItem onClick={() => actions.onEdit(entry)}>Изменить</MenuItem>}
        {archived ? null : <MenuSeparator />}
        {archived ? (
          <MenuItem onClick={() => actions.onUnarchive(entry)}>Вернуть из архива</MenuItem>
        ) : (
          <MenuItem onClick={() => actions.onArchive(entry)}>Архивировать</MenuItem>
        )}
        <MenuItem variant="destructive" onClick={() => actions.onDelete(entry)}>
          Удалить
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
