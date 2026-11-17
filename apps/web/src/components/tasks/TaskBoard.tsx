import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, TaskStatus } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { SquareKanbanIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { useProjects, useThreadShells } from "~/state/entities";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { formatEnvironmentQueryError } from "~/state/query";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { confirmLeavingDone } from "./moveTaskToDone";
import { leavingDoneConfirmation } from "./taskCleanup.logic";
import { TaskCard, type TaskCardActions, type TaskCardThread } from "./TaskCard";
import { useMoveTaskToDone } from "./TaskCleanupDialog";
import { toastTaskCommandFailure, toastTaskStartBlocked } from "./taskCommandToast";
import { taskStartBlocker } from "./taskDetail.logic";
import {
  orderCardThreads,
  taskAttention,
  threadRowStatus,
  type TaskAttention,
} from "./taskAttention.logic";
import {
  boardColumns,
  boardTaskKey,
  TASK_STATUS_LABEL,
  type BoardColumn,
  type BoardTask,
} from "./taskBoard.logic";
import { TaskEditorDialog, type TaskEditorTarget } from "./TaskEditorDialog";
import { TaskStartDialog } from "./TaskStartDialog";

export interface TasksSearch {
  readonly archived?: 1 | undefined;
  readonly environment?: EnvironmentId | undefined;
  readonly project?: ProjectId | undefined;
}

const ALL = "all";

const tasksListAtom = environmentAtomList("web-tasks-live", (environmentId) =>
  tasksEnvironment.tasksLive({ environmentId, input: {} }),
);
const taskEditPermissionsAtom = environmentAtomList(
  "web-task-edit-permissions",
  tasksEnvironment.setTaskStatus.permissionAtom,
);
const taskCreatePermissionsAtom = environmentAtomList(
  "web-task-create-permissions",
  tasksEnvironment.upsertTask.permissionAtom,
);

/** The task board: every connected environment's tasks in four status columns. */
export function TaskBoard({ search }: { readonly search: TasksSearch }) {
  const archived = search.archived === 1;
  const navigate = useNavigate();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const idsKey = environmentIdsKey(connectedIds);
  const results = useAtomValue(tasksListAtom(idsKey));
  const editPermissions = useAtomValue(taskEditPermissionsAtom(idsKey));
  const createPermissions = useAtomValue(taskCreatePermissionsAtom(idsKey));
  const projects = useProjects();
  const shells = useThreadShells();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId;
  const connectedEnvironments = connectedIds.map((environmentId) => ({
    environmentId,
    label: environmentLabel(environmentId),
  }));
  const entries: BoardTask[] = [];
  const errors: string[] = [];
  connectedIds.forEach((environmentId, index) => {
    const result = results[index]!;
    const data = AsyncResult.getOrElse(result, () => null);
    if (data !== null) {
      for (const task of data.tasks) entries.push({ environmentId, task });
    } else if (result._tag === "Failure") {
      errors.push(
        `${environmentLabel(environmentId)}: ${formatEnvironmentQueryError(result.cause)}`,
      );
    }
  });
  const canEditIn = (environmentId: EnvironmentId) =>
    editPermissions[connectedIds.indexOf(environmentId)] === true;
  const creatableEnvironments = connectedEnvironments.filter(
    (_entry, index) => createPermissions[index] === true,
  );

  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}\n${project.id}`, project.title]),
  );
  const shellsByKey = new Map(
    shells.map((shell) => [scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell]),
  );
  const attentionById: Record<string, TaskAttention> = {};
  const threadsById: Record<string, TaskCardThread[]> = {};
  for (const { environmentId, task } of entries) {
    const threads = task.threadIds.flatMap((threadId) => {
      const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
      const shell = shellsByKey.get(key);
      return shell
        ? [
            {
              ...shell,
              lastVisitedAt: resolveThreadLastVisitedAt(
                shell.lastVisitedAt,
                localLastVisitedAtById[key],
              ),
            },
          ]
        : [];
    });
    attentionById[task.id] = taskAttention(threads);
    threadsById[task.id] = orderCardThreads(
      threads.map((thread) => ({ thread, status: threadRowStatus(thread) })),
    ).map(({ thread, status }) => ({ id: thread.id, title: thread.title, status }));
  }
  const columns = boardColumns(entries, attentionById, {
    archived,
    environmentId: search.environment,
    projectId: search.project,
  });
  const projectOptions = [
    ...new Map(
      projects
        .filter(
          (project) =>
            connectedIds.includes(project.environmentId) &&
            (search.environment === undefined || project.environmentId === search.environment) &&
            project.archivedAt == null,
        )
        .map((project) => [project.id, project.title]),
    ),
  ];

  const [editor, setEditor] = useState<TaskEditorTarget | null>(null);
  const [starting, setStarting] = useState<BoardTask | null>(null);
  const [dragging, setDragging] = useState<BoardTask | null>(null);
  // A card moved with `[`/`]` remounts in its new column; this keeps the keyboard on it.
  const [keyboardMovedKey, setKeyboardMovedKey] = useState<string | null>(null);
  const setTaskStatus = useAtomCommand(tasksEnvironment.setTaskStatus, {
    label: "task set status",
  });
  const archiveTask = useAtomCommand(tasksEnvironment.archiveTask, { label: "task archive" });
  const unarchiveTask = useAtomCommand(tasksEnvironment.unarchiveTask, {
    label: "task unarchive",
  });
  const deleteTask = useAtomCommand(tasksEnvironment.deleteTask, { label: "task delete" });
  const { moveToDone, cleanupDialog } = useMoveTaskToDone();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const move = async (entry: BoardTask, status: TaskStatus) => {
    const { environmentId, task } = entry;
    if (status === task.status) return;
    // Checked before any await, so a move that needs no confirmation is sent at once.
    const leavingDone = leavingDoneConfirmation(task, status);
    if (leavingDone !== null && !(await confirmLeavingDone(leavingDone))) {
      setKeyboardMovedKey(null);
      return;
    }
    // A task without threads starts through the dialog; one that already has threads only moves.
    if (task.status === "backlog" && status === "in_progress" && task.threadIds.length === 0) {
      setKeyboardMovedKey(null);
      const blocker = taskStartBlocker(
        task,
        new Set(
          projects
            .filter((project) => project.environmentId === environmentId)
            .map((project) => project.id),
        ),
      );
      if (blocker === null) setStarting(entry);
      else toastTaskStartBlocked(blocker);
      return;
    }
    const result =
      status === "done"
        ? await moveToDone(environmentId, task)
        : await setTaskStatus({ environmentId, input: { id: task.id, status } });
    // A card that stays in its column keeps its focus; nothing remounts to take it back.
    if (toastTaskCommandFailure("Couldn't move task", result)) setKeyboardMovedKey(null);
  };
  const remove = async ({ environmentId, task }: BoardTask) => {
    const message = `Delete task “${task.title}”?\nIts threads, worktrees and branches stay.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deleteTask({ environmentId, input: { id: task.id } });
    toastTaskCommandFailure("Couldn't delete task", result);
  };
  const actions: TaskCardActions = {
    onMove: (entry, status) => void move(entry, status),
    onKeyboardMove: (entry, status) => {
      setKeyboardMovedKey(boardTaskKey(entry));
      void move(entry, status);
    },
    onRefocused: () => setKeyboardMovedKey(null),
    onEdit: (entry) => setEditor({ environmentId: entry.environmentId, task: entry.task }),
    onArchive: ({ environmentId, task }) =>
      void archiveTask({ environmentId, input: { id: task.id } }).then((result) =>
        toastTaskCommandFailure("Couldn't archive task", result),
      ),
    onUnarchive: ({ environmentId, task }) =>
      void unarchiveTask({ environmentId, input: { id: task.id } }).then((result) =>
        toastTaskCommandFailure("Couldn't restore task", result),
      ),
    onDelete: (entry) => void remove(entry),
  };
  const creationEnvironment =
    creatableEnvironments.find((entry) => entry.environmentId === search.environment) ??
    creatableEnvironments[0];
  const openCreate = () => {
    if (creationEnvironment) {
      setEditor({ environmentId: creationEnvironment.environmentId, task: null });
    }
  };
  const setFilter = (patch: Partial<TasksSearch>) =>
    void navigate({ to: "/tasks", search: { ...search, ...patch } });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Tasks">
          {archived ? (
            <>
              <WorkspaceBreadcrumbItem>
                <Link
                  to="/tasks"
                  search={{ environment: search.environment, project: search.project }}
                >
                  Tasks
                </Link>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Archived</h1>
              </WorkspaceBreadcrumbItem>
            </>
          ) : (
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Tasks</h1>
            </WorkspaceBreadcrumbItem>
          )}
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        <Select
          value={search.project ?? ALL}
          onValueChange={(value) =>
            setFilter({
              project: value === null || value === ALL ? undefined : (value as ProjectId),
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Project" className="w-auto max-w-48">
            <SelectValue>
              {search.project === undefined
                ? "Project: All"
                : `Project: ${projectOptions.find(([id]) => id === search.project)?.[1] ?? search.project}`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ALL} label="All projects">
              All projects
            </SelectItem>
            {projectOptions.map(([id, title]) => (
              <SelectItem key={id} value={id} label={title}>
                {title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {connectedEnvironments.length > 1 ? (
          <Select
            value={search.environment ?? ALL}
            onValueChange={(value) =>
              setFilter({
                environment: value === null || value === ALL ? undefined : (value as EnvironmentId),
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Environment" className="w-auto max-w-48">
              <SelectValue>
                {search.environment === undefined
                  ? "Environment: All"
                  : `Environment: ${environmentLabel(search.environment)}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL} label="All environments">
                All environments
              </SelectItem>
              {connectedEnvironments.map((entry) => (
                <SelectItem
                  key={entry.environmentId}
                  value={entry.environmentId}
                  label={entry.label}
                >
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button size="sm" disabled={!creationEnvironment} onClick={openCreate}>
          <PlusIcon />
          New task
        </Button>
      </WorkspacePageHeader>

      {connectedIds.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SquareKanbanIcon />
            </EmptyMedia>
            <EmptyTitle>No connected environments</EmptyTitle>
            <EmptyDescription>Tasks appear once an environment connects.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {errors.map((error) => (
            <p
              key={error}
              role="status"
              className="px-(--workspace-gutter-start) text-sm text-destructive"
            >
              {error}
            </p>
          ))}
          <DndContext
            sensors={sensors}
            onDragStart={(event) => {
              setKeyboardMovedKey(null);
              setDragging((event.active.data.current as BoardTask | undefined) ?? null);
            }}
            onDragCancel={() => setDragging(null)}
            onDragEnd={(event) => {
              setDragging(null);
              const entry = event.active.data.current as BoardTask | undefined;
              const status = event.over?.id as TaskStatus | undefined;
              if (entry && status) void move(entry, status);
            }}
          >
            {/* Narrow windows scroll the columns sideways instead of squeezing them. */}
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-(--workspace-gutter-start) pt-1 pb-4">
              {columns.map((column) => (
                <TaskColumn
                  key={column.status}
                  column={column}
                  search={search}
                  footer={
                    column.status === "backlog" && !archived ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={!creationEnvironment}
                        onClick={openCreate}
                      >
                        <PlusIcon />
                        Add task
                      </Button>
                    ) : null
                  }
                >
                  {column.entries.map((entry) => {
                    const key = boardTaskKey(entry);
                    return (
                      <TaskCard
                        key={key}
                        entry={entry}
                        projectNames={entry.task.projectIds.map(
                          (projectId) =>
                            projectTitles.get(`${entry.environmentId}\n${projectId}`) ?? projectId,
                        )}
                        threads={threadsById[entry.task.id] ?? []}
                        canEdit={canEditIn(entry.environmentId)}
                        refocus={keyboardMovedKey === key}
                        actions={actions}
                      />
                    );
                  })}
                </TaskColumn>
              ))}
            </div>
            {/* No drop animation: the card reappears in its column when the server confirms. */}
            <DragOverlay dropAnimation={null}>
              {dragging ? (
                <div className="w-68 rounded-lg border bg-card p-2.5 text-sm font-medium shadow-lg">
                  {dragging.task.title}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </>
      )}

      {editor ? (
        <TaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          target={editor}
          environments={creatableEnvironments}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {starting ? (
        <TaskStartDialog
          key={boardTaskKey(starting)}
          environmentId={starting.environmentId}
          task={starting.task}
          onClose={() => setStarting(null)}
        />
      ) : null}
      {cleanupDialog}
    </SidebarInset>
  );
}

function TaskColumn({
  column,
  search,
  footer,
  children,
}: {
  readonly column: BoardColumn;
  readonly search: TasksSearch;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  const archived = search.archived === 1;
  const label = TASK_STATUS_LABEL[column.status];
  const { setNodeRef, isOver } = useDroppable({ id: column.status, disabled: archived });
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      data-drop-target={isOver || undefined}
      className="flex max-h-full min-w-56 max-w-96 flex-1 basis-0 flex-col rounded-xl bg-muted/40 data-drop-target:bg-accent/60"
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <h2 className="text-sm font-medium">
          {label} <span className="text-muted-foreground tabular-nums">({column.total})</span>
        </h2>
        {column.status === "done" && !archived ? (
          <Link
            to="/tasks"
            search={{ ...search, archived: 1 }}
            className="ms-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Archive
          </Link>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {children}
        {footer ? <div className="flex">{footer}</div> : null}
      </div>
    </section>
  );
}
