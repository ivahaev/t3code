import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  Task,
  TaskId,
  TaskStatus,
  TaskWorktree,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { LinkIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useContext, useState } from "react";

import { isElectron } from "~/env";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "~/providerInstances";
import { useProjects, useThreadShells } from "~/state/entities";
import { formatEnvironmentQueryError } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { moveTaskToDone } from "./moveTaskToDone";
import { TaskAttachThreadDialog } from "./TaskAttachThreadDialog";
import { taskAttention, taskAttentionLabel } from "./taskAttention.logic";
import { TASK_STATUS_LABEL, TASK_STATUSES } from "./taskBoard.logic";
import { TaskCodeTab, type TaskWorktreeDiff } from "./TaskCodeTab";
import { toastTaskCommandFailure } from "./taskCommandToast";
import {
  groupTaskThreads,
  worktreeDiffInputs,
  worktreeDiffStat,
  type DiffStat,
  type TaskThreadGroup,
} from "./taskDetail.logic";
import { TaskEditorDialog } from "./TaskEditorDialog";
import { TaskNewThreadDialog } from "./TaskNewThreadDialog";
import { TaskStartDialog } from "./TaskStartDialog";

type DiffTarget = Parameters<typeof reviewEnvironment.diffPreview>[0];

// Every diff the task page shows, read as one atom so a task with any number of worktrees
// subscribes to the same `review.getDiffPreview` queries the diff panel uses.
const taskDiffPreviewsAtom = Atom.family((key: string) => {
  const targets = JSON.parse(key) as ReadonlyArray<DiffTarget>;
  return Atom.make((get) =>
    targets.map((target) => get(reviewEnvironment.diffPreview(target))),
  ).pipe(Atom.withLabel(`task-diff-previews:${key}`));
});

function worktreeKey(worktree: TaskWorktree): string {
  return `${worktree.projectId}\n${worktree.branch}`;
}

type Tab = "threads" | "code";

/** The task page: what the task is, which chats work on it and where, and the code they changed. */
export function TaskDetail({
  environmentId,
  taskId,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: TaskId;
}) {
  const list = useAtomValue(tasksEnvironment.tasksLive({ environmentId, input: {} }));
  const task = AsyncResult.getOrElse(list, () => null)?.tasks.find((entry) => entry.id === taskId);
  const title = task?.title ?? "Задача";
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Задача">
          <WorkspaceBreadcrumbItem>
            <Link to="/tasks">Задачи</Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{title}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {task ? (
        <TaskDetailBody environmentId={environmentId} task={task} />
      ) : (
        <p
          role="status"
          className="px-(--workspace-gutter-start) py-6 text-sm text-muted-foreground"
        >
          {list._tag === "Failure"
            ? formatEnvironmentQueryError(list.cause)
            : list._tag === "Initial" || list.waiting
              ? "Загрузка…"
              : "Задача не найдена. Возможно, её удалили."}
        </p>
      )}
    </SidebarInset>
  );
}

function TaskDetailBody({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
}) {
  const [tab, setTab] = useState<Tab>("threads");
  const [dialog, setDialog] = useState<"edit" | "start" | "new-thread" | "attach" | null>(null);
  const registry = useContext(RegistryContext);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "Проект недоступен";
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const shells = useThreadShells()
    .filter((shell) => shell.environmentId === environmentId)
    .map((shell) => ({
      ...shell,
      lastVisitedAt: resolveThreadLastVisitedAt(
        shell.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(environmentId, shell.id))],
      ),
    }));
  const groups = groupTaskThreads(task, shells, new Set(projects.map((project) => project.id)));
  const attention = taskAttentionLabel(
    taskAttention(shells.filter((shell) => task.threadIds.includes(shell.id))),
  );

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = new Map(
    providerInstanceEntriesFor(providers, settings, null).map((entry) => [entry.instanceId, entry]),
  );

  const liveWorktrees = task.worktrees.flatMap((worktree) => {
    const inputs = worktreeDiffInputs(worktree);
    return inputs ? [{ worktree, inputs }] : [];
  });
  const diffTargets = liveWorktrees.flatMap(({ inputs }): DiffTarget[] => [
    { environmentId, input: inputs.branch },
    { environmentId, input: inputs.workingTree },
  ]);
  const previews = useAtomValue(taskDiffPreviewsAtom(JSON.stringify(diffTargets)));
  const diffs: TaskWorktreeDiff[] = liveWorktrees.map(({ worktree }, index) => {
    const branch = previews[index * 2]!;
    const workingTree = previews[index * 2 + 1]!;
    const failure = [branch, workingTree].find((result) => result._tag === "Failure");
    return {
      key: worktreeKey(worktree),
      projectTitle: projectTitle(worktree.projectId),
      worktree,
      branch: AsyncResult.getOrElse(branch, () => null),
      workingTree: AsyncResult.getOrElse(workingTree, () => null),
      pending: branch.waiting || workingTree.waiting || branch._tag === "Initial",
      error: failure?._tag === "Failure" ? formatEnvironmentQueryError(failure.cause) : null,
    };
  });
  const statByWorktree = new Map(
    diffs.map((diff) => [diff.key, worktreeDiffStat([diff.branch, diff.workingTree])]),
  );
  const refreshDiffs = () => {
    for (const target of diffTargets) registry.refresh(reviewEnvironment.diffPreview(target));
  };

  const canEdit = useAtomValue(tasksEnvironment.setTaskStatus.permissionAtom(environmentId));
  const setTaskStatus = useAtomCommand(tasksEnvironment.setTaskStatus, {
    label: "task set status",
  });
  const detachTaskThread = useAtomCommand(tasksEnvironment.detachTaskThread, {
    label: "task detach thread",
  });
  const changeStatus = async (status: TaskStatus) => {
    if (status === task.status) return;
    // The same rule as the board: a task without chats starts through the dialog.
    if (task.status === "backlog" && status === "in_progress" && task.threadIds.length === 0) {
      setDialog("start");
      return;
    }
    const result =
      status === "done"
        ? await moveTaskToDone({ environmentId, task, deps: { setTaskStatus } })
        : await setTaskStatus({ environmentId, input: { id: task.id, status } });
    toastTaskCommandFailure("Не удалось перенести задачу", result);
  };
  const detach = async (threadId: EnvironmentThreadShell["id"]) => {
    const result = await detachTaskThread({ environmentId, input: { id: task.id, threadId } });
    toastTaskCommandFailure("Не удалось отвязать чат", result);
  };

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-(--workspace-gutter-start) pt-1 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={task.status}
            onValueChange={(next) => {
              if (next !== null) void changeStatus(next as TaskStatus);
            }}
          >
            <SelectTrigger size="sm" aria-label="Статус" className="w-auto" disabled={!canEdit}>
              <SelectValue>{TASK_STATUS_LABEL[task.status]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {TASK_STATUSES.map((status) => (
                <SelectItem key={status} value={status} label={TASK_STATUS_LABEL[status]}>
                  {TASK_STATUS_LABEL[status]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {attention ? (
            <span className="text-xs text-muted-foreground">
              {attention.glyph} {attention.text}
            </span>
          ) : null}
          {task.link ? <TaskLink link={task.link} /> : null}
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
            disabled={!canEdit}
            onClick={() => setDialog("edit")}
          >
            <PencilIcon />
            Изменить
          </Button>
        </div>
        {task.description.trim() !== "" ? (
          <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-muted-foreground">
            {task.description}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!canEdit} onClick={() => setDialog("new-thread")}>
            <PlusIcon />
            Новый чат
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => setDialog("attach")}
          >
            <LinkIcon />
            Привязать чат
          </Button>
          <div className="min-w-0 flex-1" />
          {tab === "code" && diffTargets.length > 0 ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Обновить дифф"
              onClick={refreshDiffs}
            >
              <RefreshCwIcon />
            </Button>
          ) : null}
          <ToggleGroup
            aria-label="Вкладка"
            variant="segmented"
            value={[tab]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "threads" || next === "code") setTab(next);
            }}
          >
            <Toggle value="threads">Чаты</Toggle>
            <Toggle value="code">Код</Toggle>
          </ToggleGroup>
        </div>
      </div>

      {tab === "threads" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-(--workspace-gutter-start) pb-6">
          {groups.map((group) => (
            <RepositoryBlock
              key={group.projectId}
              environmentId={environmentId}
              group={group}
              title={projectTitle(group.projectId)}
              statByWorktree={statByWorktree}
              providerEntries={providerEntries}
              canEdit={canEdit}
              onDetach={(threadId) => void detach(threadId)}
            />
          ))}
        </div>
      ) : (
        <TaskCodeTab diffs={diffs} />
      )}

      {dialog === "edit" ? (
        <TaskEditorDialog
          target={{ environmentId, task }}
          environments={[]}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "start" ? (
        <TaskStartDialog
          environmentId={environmentId}
          task={task}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "new-thread" ? (
        <TaskNewThreadDialog
          environmentId={environmentId}
          task={task}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "attach" ? (
        <TaskAttachThreadDialog
          environmentId={environmentId}
          task={task}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function TaskLink({ link }: { readonly link: string }) {
  const isUrl = /^https?:\/\//i.test(link);
  return isUrl ? (
    <a
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className="min-w-0 truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {link}
    </a>
  ) : (
    <span className="min-w-0 truncate text-xs text-muted-foreground">{link}</span>
  );
}

type TaskShell = Omit<EnvironmentThreadShell, "lastVisitedAt"> & {
  readonly lastVisitedAt: string | undefined;
};

function RepositoryBlock({
  environmentId,
  group,
  title,
  statByWorktree,
  providerEntries,
  canEdit,
  onDetach,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: TaskThreadGroup<TaskShell>;
  readonly title: string;
  readonly statByWorktree: ReadonlyMap<string, DiffStat | null>;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly canEdit: boolean;
  readonly onDetach: (threadId: TaskShell["id"]) => void;
}) {
  const shared = group.worktrees.find((entry) => entry.worktree.kind === "shared");
  const extras = group.worktrees.filter((entry) => entry !== shared);
  const rows = (threads: ReadonlyArray<TaskShell>) =>
    threads.map((thread) => (
      <TaskThreadRow
        key={thread.id}
        environmentId={environmentId}
        thread={thread}
        provider={providerEntries.get(thread.providerInstanceId) ?? null}
        canEdit={canEdit}
        onDetach={onDetach}
      />
    ));
  return (
    <section aria-label={title} className="rounded-lg border bg-card text-card-foreground">
      <header className="flex min-w-0 items-center gap-2 border-b px-3 py-2 text-sm">
        <h2 className={cn("font-medium", !group.available && "text-muted-foreground")}>{title}</h2>
        {shared ? (
          <WorktreeLabel
            worktree={shared.worktree}
            stat={statByWorktree.get(worktreeKey(shared.worktree)) ?? null}
          />
        ) : null}
      </header>
      <ul className="flex flex-col py-1">
        {shared ? rows(shared.threads) : null}
        {extras.map((extra) => (
          <li key={worktreeKey(extra.worktree)} className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5 pb-0.5 text-xs text-muted-foreground">
              <span aria-hidden>↳</span>
              <WorktreeLabel
                worktree={extra.worktree}
                stat={statByWorktree.get(worktreeKey(extra.worktree)) ?? null}
              />
            </div>
            <ul className="flex flex-col ps-4">{rows(extra.threads)}</ul>
          </li>
        ))}
        {group.rootThreads.length > 0 ? (
          <li className="flex flex-col">
            {group.worktrees.length > 0 ? (
              <div className="px-3 pt-1.5 pb-0.5 text-xs text-muted-foreground">
                Вне worktree задачи
              </div>
            ) : null}
            <ul className="flex flex-col">{rows(group.rootThreads)}</ul>
          </li>
        ) : null}
        {group.worktrees.every((entry) => entry.threads.length === 0) &&
        group.rootThreads.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">Чатов пока нет.</li>
        ) : null}
      </ul>
    </section>
  );
}

function WorktreeLabel({
  worktree,
  stat,
}: {
  readonly worktree: TaskWorktree;
  readonly stat: DiffStat | null;
}) {
  return (
    <>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {worktree.branch}
      </span>
      {worktree.removedAt !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground">· worktree удалён</span>
      ) : stat !== null ? (
        <DiffStatLabel
          additions={stat.additions}
          deletions={stat.deletions}
          layout="inline"
          className="ms-auto shrink-0 text-xs"
        />
      ) : null}
    </>
  );
}

function TaskThreadRow({
  environmentId,
  thread,
  provider,
  canEdit,
  onDetach,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: TaskShell;
  readonly provider: ProviderInstanceEntry | null;
  readonly canEdit: boolean;
  readonly onDetach: (threadId: TaskShell["id"]) => void;
}) {
  const pill = resolveThreadStatusPill({ thread });
  const agent = provider?.displayName ?? thread.runtime?.providerName ?? thread.providerInstanceId;
  return (
    <li className="group/task-thread flex min-w-0 items-center gap-1 pe-2 hover:bg-accent/50">
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-sm outline-none focus-visible:bg-accent"
      >
        <span className="flex w-28 shrink-0 items-center gap-1.5 truncate text-muted-foreground">
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              accentColor={provider.accentColor}
              acpRegistryAgentId={provider.acpRegistryAgentId}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              size="compact"
            />
          ) : null}
          <span className="truncate">{agent}</span>
        </span>
        <span className="max-w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {thread.branch ?? "корень проекта"}
        </span>
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {pill ? (
          <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", pill.colorClass)}>
            <span aria-hidden className={cn("size-1.5 rounded-full", pill.dotClass)} />
            {pill.label}
          </span>
        ) : null}
      </Link>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Действия: ${thread.title}`}
              disabled={!canEdit}
            />
          }
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => onDetach(thread.id)}>Отвязать от задачи</MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}
