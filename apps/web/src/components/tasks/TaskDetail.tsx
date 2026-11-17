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
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  GitBranchIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SquareKanbanIcon,
} from "lucide-react";
import { useContext, useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "~/providerInstances";
import { useProjects, useThreadShells } from "~/state/entities";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { formatEnvironmentQueryError } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { RelativeTimeLabel } from "../sidebar/SidebarThreadRow";
import { resolveThreadTopStatus, TopStatusIcon } from "../sidebar/threadTopStatus";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { confirmLeavingDone } from "./moveTaskToDone";
import { leavingDoneConfirmation } from "./taskCleanup.logic";
import { TaskAttachThreadDialog } from "./TaskAttachThreadDialog";
import { taskAttentionStatus } from "./taskAttention.logic";
import { TASK_STATUS_LABEL, TASK_STATUSES } from "./taskBoard.logic";
import { useMoveTaskToDone } from "./TaskCleanupDialog";
import { TaskCodeTab, type TaskWorktreeDiff } from "./TaskCodeTab";
import { toastTaskCommandFailure, toastTaskStartBlocked } from "./taskCommandToast";
import {
  groupTaskThreads,
  taskDiffTargets,
  taskStartBlocker,
  worktreeDiffState,
  worktreeDiffStat,
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

/** The task page: what the task is, which threads work on it and where, and the code they changed. */
export function TaskDetail({
  environmentId,
  taskId,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: TaskId;
}) {
  const list = useAtomValue(tasksEnvironment.tasksLive({ environmentId, input: {} }));
  const task = AsyncResult.getOrElse(list, () => null)?.tasks.find((entry) => entry.id === taskId);
  const title = task?.title ?? "Task";
  const [tab, setTab] = useState<Tab>("threads");
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Task">
          <WorkspaceBreadcrumbItem>
            <Link to="/tasks">Tasks</Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{title}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {task ? (
          <ToggleGroup
            aria-label="Tab"
            variant="segmented"
            className="ms-auto"
            value={[tab]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "threads" || next === "code") setTab(next);
            }}
          >
            <Toggle value="threads">Threads</Toggle>
            <Toggle value="code">Code</Toggle>
          </ToggleGroup>
        ) : null}
      </WorkspacePageHeader>
      {task ? (
        <TaskDetailBody environmentId={environmentId} task={task} tab={tab} />
      ) : (
        <p
          role="status"
          className="px-(--workspace-gutter-start) py-6 text-sm text-muted-foreground"
        >
          {list._tag === "Failure"
            ? formatEnvironmentQueryError(list.cause)
            : list._tag === "Initial" || list.waiting
              ? "Loading…"
              : "Task not found. It may have been deleted."}
        </p>
      )}
    </SidebarInset>
  );
}

function TaskDetailBody({
  environmentId,
  task,
  tab,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly tab: Tab;
}) {
  const [dialog, setDialog] = useState<"edit" | "start" | "new-thread" | "attach" | null>(null);
  const registry = useContext(RegistryContext);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "Project unavailable";
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
  const availableProjectIds = new Set(projects.map((project) => project.id));
  const groups = groupTaskThreads(task, shells, availableProjectIds);
  const archived = task.archivedAt !== null;
  const startBlocker = taskStartBlocker(task, availableProjectIds);
  const attention = taskAttentionStatus(
    shells.filter((shell) => task.threadIds.includes(shell.id)),
  );

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = new Map(
    providerInstanceEntriesFor(providers, settings, null).map((entry) => [entry.instanceId, entry]),
  );

  const fileAccess = useFilesystemReadAccess(environmentId);
  const { worktrees: liveWorktrees, targets: diffTargets } = taskDiffTargets(
    environmentId,
    task,
    fileAccess.canReadFiles,
  );
  const previews = useAtomValue(taskDiffPreviewsAtom(JSON.stringify(diffTargets)));
  const diffs: TaskWorktreeDiff[] = liveWorktrees.map((worktree, index) => ({
    key: worktreeKey(worktree),
    projectTitle: projectTitle(worktree.projectId),
    worktree,
    ...worktreeDiffState(previews[index * 2]!, previews[index * 2 + 1]!, (failure) =>
      formatEnvironmentQueryError(failure.cause),
    ),
  }));
  const diffsUnavailable = fileAccess.canReadFiles
    ? null
    : fileAccess.isPending
      ? "Checking file access…"
      : (fileAccess.error ?? "This connection can't read local diffs.");
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
  const unarchiveTask = useAtomCommand(tasksEnvironment.unarchiveTask, {
    label: "task unarchive",
  });
  const { moveToDone, cleanupDialog } = useMoveTaskToDone();
  const changeStatus = async (status: TaskStatus) => {
    if (status === task.status) return;
    const leavingDone = leavingDoneConfirmation(task, status);
    if (leavingDone !== null && !(await confirmLeavingDone(leavingDone))) return;
    // The same rule as the board: a task without threads starts through the dialog.
    if (task.status === "backlog" && status === "in_progress" && task.threadIds.length === 0) {
      if (startBlocker === null) setDialog("start");
      else toastTaskStartBlocked(startBlocker);
      return;
    }
    const result =
      status === "done"
        ? await moveToDone(environmentId, task)
        : await setTaskStatus({ environmentId, input: { id: task.id, status } });
    toastTaskCommandFailure("Couldn't move task", result);
  };
  const detach = async (threadId: EnvironmentThreadShell["id"]) => {
    const result = await detachTaskThread({ environmentId, input: { id: task.id, threadId } });
    toastTaskCommandFailure("Couldn't detach thread", result);
  };

  const { scratchWorkspaceRootFor } = useScratchProject();
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  // The task's projects, minus the No project pseudo-project unless a thread runs there.
  const shownGroups = groups.filter((group) => {
    const project = projects.find((entry) => entry.id === group.projectId);
    return !(
      project !== undefined &&
      isScratchProject(project, scratchRoot) &&
      groupThreads(group).length === 0
    );
  });
  const threadGroups = shownGroups.filter((group) => groupThreads(group).length > 0);
  const editable = canEdit && !archived;

  return (
    <>
      {tab === "threads" ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          {/* Like a thread: the content lane centers on the page and the details card keeps to the right edge. */}
          <div className="flex flex-col gap-6 px-(--workspace-gutter-start) pt-3 pb-10 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,var(--chat-content-max-width))_minmax(calc(var(--thread-details-panel-width)+1.5rem),1fr)] lg:gap-0 lg:ps-(--workspace-gutter-start) lg:pe-3">
            <div className="flex min-w-0 flex-col gap-8 lg:col-start-2 lg:row-start-1 lg:pt-3">
              <div className="flex flex-col gap-3">
                <h2 className="text-xl font-semibold text-balance text-foreground">{task.title}</h2>
                {task.description.trim() !== "" ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/80">
                    {task.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No description.</p>
                )}
              </div>

              <section aria-labelledby="task-threads-heading" className="flex flex-col">
                <div className="flex min-h-8 items-center gap-1 px-2.5 pb-1">
                  <h3
                    id="task-threads-heading"
                    className="min-w-0 flex-1 text-2xs font-medium text-muted-foreground select-none"
                  >
                    Threads
                  </h3>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!editable}
                    onClick={() => setDialog("attach")}
                  >
                    <LinkIcon />
                    Attach
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!editable}
                    onClick={() => setDialog("new-thread")}
                  >
                    <PlusIcon />
                    New thread
                  </Button>
                </div>
                {threadGroups.length === 0 ? (
                  <p className="px-2.5 py-2 text-sm text-muted-foreground">
                    No threads yet. Start one here or attach an existing thread.
                  </p>
                ) : (
                  threadGroups.map((group) => {
                    const project = projects.find((entry) => entry.id === group.projectId);
                    return (
                      <section
                        key={group.projectId}
                        aria-label={projectTitle(group.projectId)}
                        className="flex flex-col pb-3"
                      >
                        {threadGroups.length > 1 || group.projectId !== task.primaryProjectId ? (
                          <h4 className="flex min-w-0 items-center gap-2 px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
                            {project ? (
                              <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                            ) : null}
                            <span className="truncate">{projectTitle(group.projectId)}</span>
                          </h4>
                        ) : null}
                        <ul className="flex flex-col gap-px">
                          {groupThreads(group).map((thread) => (
                            <TaskThreadRow
                              key={thread.id}
                              environmentId={environmentId}
                              thread={thread}
                              provider={providerEntries.get(thread.providerInstanceId) ?? null}
                              canEdit={editable}
                              onDetach={(threadId) => void detach(threadId)}
                            />
                          ))}
                        </ul>
                      </section>
                    );
                  })
                )}
              </section>
            </div>

            <aside
              aria-label="Task details"
              className="order-first w-full lg:sticky lg:top-3 lg:col-start-3 lg:row-start-1 lg:w-(--thread-details-panel-width) lg:justify-self-end lg:self-start"
            >
              <div className="dropdown-glass overflow-hidden rounded-2xl">
                <ThreadDetailsSection
                  headingId="task-details-status-heading"
                  title="Status"
                  separated={false}
                  showHeading={false}
                >
                  <div className="flex flex-col">
                    <Menu>
                      <MenuTrigger
                        render={<ThreadDetailsControl part="select" />}
                        disabled={!canEdit || archived}
                        aria-label={`Status: ${TASK_STATUS_LABEL[task.status]}`}
                      >
                        <SquareKanbanIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                        <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                          {TASK_STATUS_LABEL[task.status]}
                        </span>
                      </MenuTrigger>
                      <MenuPopup align="start" side="bottom" className="w-(--anchor-width)">
                        <MenuRadioGroup
                          value={task.status}
                          onValueChange={(next) => void changeStatus(next as TaskStatus)}
                        >
                          {TASK_STATUSES.map((status) => (
                            <MenuRadioItem key={status} value={status}>
                              {TASK_STATUS_LABEL[status]}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuPopup>
                    </Menu>
                    {attention ? (
                      <DetailsRow>
                        <TopStatusIcon
                          icon={attention.icon}
                          className={cn("size-4", attention.className)}
                        />
                        <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                          {attention.label}
                        </span>
                      </DetailsRow>
                    ) : null}
                    {archived ? (
                      <DetailsRow>
                        <ArchiveIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                        <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Archived</span>
                      </DetailsRow>
                    ) : null}
                    {task.link ? <TaskLinkRow link={task.link} /> : null}
                  </div>
                </ThreadDetailsSection>

                <ThreadDetailsSection
                  headingId="task-details-projects-heading"
                  title="Projects"
                  showHeading={false}
                >
                  <div className="flex flex-col">
                    {shownGroups.map((group) => {
                      const project = projects.find((entry) => entry.id === group.projectId);
                      return (
                        <DetailsRow key={group.projectId}>
                          {project ? (
                            <ProjectFavicon project={project} className="size-4 shrink-0" />
                          ) : (
                            <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                          )}
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              THREAD_DETAILS_PANEL_LABEL_CLASS,
                              !group.available && "text-muted-foreground",
                            )}
                          >
                            {projectTitle(group.projectId)}
                          </span>
                          {group.projectId === task.primaryProjectId && shownGroups.length > 1 ? (
                            <span className="shrink-0 text-xs font-normal text-muted-foreground">
                              Main
                            </span>
                          ) : null}
                        </DetailsRow>
                      );
                    })}
                  </div>
                </ThreadDetailsSection>

                {task.worktrees.length > 0 ? (
                  <ThreadDetailsSection
                    headingId="task-details-branches-heading"
                    title="Branches"
                    showHeading={false}
                  >
                    <div className="flex flex-col">
                      {task.worktrees.map((worktree) => {
                        const stat = statByWorktree.get(worktreeKey(worktree)) ?? null;
                        return (
                          <DetailsRow key={worktreeKey(worktree)}>
                            <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate",
                                THREAD_DETAILS_PANEL_LABEL_CLASS,
                              )}
                            >
                              {worktree.branch}
                            </span>
                            {worktree.removedAt !== null ? (
                              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                                Removed
                              </span>
                            ) : stat !== null ? (
                              <DiffStatLabel
                                additions={stat.additions}
                                deletions={stat.deletions}
                                layout="inline"
                                className="shrink-0 text-xs"
                              />
                            ) : null}
                          </DetailsRow>
                        );
                      })}
                    </div>
                  </ThreadDetailsSection>
                ) : null}

                <ThreadDetailsSection
                  headingId="task-details-actions-heading"
                  title="Actions"
                  showHeading={false}
                >
                  <div className="flex flex-col">
                    {archived ? (
                      <ThreadDetailsControl
                        disabled={!canEdit}
                        onClick={() =>
                          void unarchiveTask({ environmentId, input: { id: task.id } }).then(
                            (result) => toastTaskCommandFailure("Couldn't restore task", result),
                          )
                        }
                      >
                        <ArchiveRestoreIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                        <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Restore task</span>
                      </ThreadDetailsControl>
                    ) : (
                      <ThreadDetailsControl disabled={!canEdit} onClick={() => setDialog("edit")}>
                        <PencilIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                        <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Edit task</span>
                      </ThreadDetailsControl>
                    )}
                  </div>
                </ThreadDetailsSection>
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <TaskCodeTab diffs={diffs} unavailable={diffsUnavailable} onRefresh={refreshDiffs} />
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
      {cleanupDialog}
    </>
  );
}

function DetailsRow({ children }: { readonly children: ReactNode }) {
  return (
    <div className={THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS + " flex items-center"}>{children}</div>
  );
}

function TaskLinkRow({ link }: { readonly link: string }) {
  const content = (
    <>
      <LinkIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{link}</span>
    </>
  );
  return /^https?:\/\//i.test(link) ? (
    <ThreadDetailsControl render={<a href={link} target="_blank" rel="noreferrer noopener" />}>
      {content}
    </ThreadDetailsControl>
  ) : (
    <DetailsRow>{content}</DetailsRow>
  );
}

type TaskShell = Omit<EnvironmentThreadShell, "lastVisitedAt"> & {
  readonly lastVisitedAt: string | undefined;
};

/** A project's task threads, newest activity first, wherever they run. */
function groupThreads(group: TaskThreadGroup<TaskShell>): ReadonlyArray<TaskShell> {
  return [...group.worktrees.flatMap((entry) => entry.threads), ...group.rootThreads].toSorted(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
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
  const status = resolveThreadTopStatus({
    status: resolveSidebarRowStatus(thread),
    isUnread: hasUnseenCompletion(thread),
    isWoke: false,
    goalActive: thread.goal?.status === "active",
  });
  return (
    <li className="group/task-thread relative flex min-w-0 items-center rounded-lg hover:bg-black/[0.035] dark:hover:bg-white/[0.06]">
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 ps-2.5 pe-10 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm text-foreground">{thread.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{thread.branch ?? "Project checkout"}</span>
          </span>
        </span>
        {status ? (
          <span
            className={cn("flex shrink-0 items-center gap-1 text-xs font-medium", status.className)}
          >
            <TopStatusIcon icon={status.icon} className="size-3" />
            {status.label}
          </span>
        ) : null}
        {provider ? (
          <span className="flex shrink-0">
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              accentColor={provider.accentColor}
              acpRegistryAgentId={provider.acpRegistryAgentId}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              size="compact"
            />
          </span>
        ) : null}
        <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          <RelativeTimeLabel timestamp={thread.updatedAt} />
        </span>
      </Link>
      <span className="absolute end-1.5 flex opacity-0 group-hover/task-thread:opacity-100 has-focus-visible:opacity-100 has-data-popup-open:opacity-100">
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Actions for ${thread.title}`}
                disabled={!canEdit}
              />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onDetach(thread.id)}>Detach from task</MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}
