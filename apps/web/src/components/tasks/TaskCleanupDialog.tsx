import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, Task } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState, type ReactNode } from "react";

import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { moveTaskToDone, toastCleanupDone, type TaskCleanupRequest } from "./moveTaskToDone";
import {
  cleanupBranchKey,
  cleanupSelectionInput,
  initialCleanupSelection,
  ruPlural,
  toggleBranch,
  toggleWorktree,
} from "./taskCleanup.logic";
import { toastTaskCommandFailure } from "./taskCommandToast";

/**
 * Moving a task to Done, with the cleanup dialog it may open. Both the board and the task
 * page use it, so every entry point follows the environment's cleanup mode.
 */
export function useMoveTaskToDone(): {
  readonly moveToDone: (
    environmentId: EnvironmentId,
    task: Task,
  ) => ReturnType<typeof moveTaskToDone>;
  readonly cleanupDialog: ReactNode;
} {
  const registry = useContext(RegistryContext);
  const [request, setRequest] = useState<TaskCleanupRequest | null>(null);
  const setTaskStatus = useAtomCommand(tasksEnvironment.setTaskStatus, {
    label: "task set status",
  });
  const previewTaskCleanup = useAtomCommand(tasksEnvironment.previewTaskCleanup, {
    label: "task cleanup preview",
  });
  const cleanupTask = useAtomCommand(tasksEnvironment.cleanupTask, { label: "task cleanup" });
  const moveToDone = (environmentId: EnvironmentId, task: Task) =>
    moveTaskToDone({
      environmentId,
      task,
      // The caller's page already subscribes to the list, so this reads its current value.
      cleanupMode:
        AsyncResult.getOrElse(
          registry.get(tasksEnvironment.tasksLive({ environmentId, input: {} })),
          () => null,
        )?.settings.cleanupMode ?? "ask",
      // The caller's page keeps this environment's session mounted for its own permissions.
      canCleanup: registry.get(tasksEnvironment.cleanupTask.permissionAtom(environmentId)),
      deps: { setTaskStatus, previewTaskCleanup, cleanupTask, openCleanupDialog: setRequest },
    });
  return {
    moveToDone,
    cleanupDialog: request ? (
      <TaskCleanupDialog
        key={`${request.environmentId}:${request.task.id}`}
        request={request}
        onClose={() => setRequest(null)}
      />
    ) : null,
  };
}

function dirtyLabel(count: number): string {
  return `⚠ ${count} ${ruPlural(count, ["незакоммиченный файл", "незакоммиченных файла", "незакоммиченных файлов"])}`;
}

function unmergedLabel(count: number): string {
  if (count === 0) return "⚠ не слита";
  return `⚠ ${count} ${ruPlural(count, ["коммит не слит", "коммита не слиты", "коммитов не слиты"])}`;
}

/** Offers to remove a finished task's worktrees and local branches. */
function TaskCleanupDialog({
  request,
  onClose,
}: {
  readonly request: TaskCleanupRequest;
  readonly onClose: () => void;
}) {
  const { environmentId, task, preview } = request;
  const [selection, setSelection] = useState(() => initialCleanupSelection(preview));
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const cleanupTask = useAtomCommand(tasksEnvironment.cleanupTask, { label: "task cleanup" });
  const setTaskCleanupMode = useAtomCommand(tasksEnvironment.setTaskCleanupMode, {
    label: "task set cleanup mode",
  });
  const canSetMode = useAtomValue(
    tasksEnvironment.setTaskCleanupMode.permissionAtom(environmentId),
  );
  const offerAlways = request.offerAlways && canSetMode;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  const baseName = (projectId: ProjectId, branch: string) =>
    task.worktrees
      .find((worktree) => worktree.projectId === projectId && worktree.branch === branch)
      ?.baseRef.replace(/^origin\//, "");
  const nothingChecked = selection.worktrees.size === 0 && selection.branches.size === 0;

  const submit = async () => {
    setBusy(true);
    if (always) {
      const result = await setTaskCleanupMode({ environmentId, input: { mode: "always" } });
      toastTaskCommandFailure("Не удалось сохранить настройку уборки", result);
    }
    if (!nothingChecked) {
      const result = await cleanupTask({
        environmentId,
        input: { id: task.id, ...cleanupSelectionInput(preview, selection) },
      });
      if (toastTaskCommandFailure("Не удалось убрать за задачей", result)) {
        setBusy(false);
        return;
      }
      if (result._tag === "Success") toastCleanupDone(result.value);
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Задача «{task.title}» готова. Убрать за ней?</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {preview.worktrees.length > 0 ? (
              <CleanupGroup title="worktree">
                {preview.worktrees.map((worktree) => (
                  <CleanupRow
                    key={worktree.path}
                    checked={selection.worktrees.has(worktree.path)}
                    disabled={busy}
                    onToggle={() => setSelection(toggleWorktree(selection, preview, worktree.path))}
                    project={projectTitle(worktree.projectId)}
                    branch={worktree.branch}
                    status={
                      worktree.dirtyFileCount === 0 ? "чисто" : dirtyLabel(worktree.dirtyFileCount)
                    }
                    warning={worktree.dirtyFileCount > 0}
                  />
                ))}
              </CleanupGroup>
            ) : null}
            {preview.branches.length > 0 ? (
              <CleanupGroup title="локальные ветки">
                {preview.branches.map((branch) => {
                  const key = cleanupBranchKey(branch.projectId, branch.branch);
                  const base = baseName(branch.projectId, branch.branch);
                  return (
                    <CleanupRow
                      key={key}
                      checked={selection.branches.has(key)}
                      disabled={busy}
                      onToggle={() => setSelection(toggleBranch(selection, preview, key))}
                      project={projectTitle(branch.projectId)}
                      branch={branch.branch}
                      status={
                        branch.merged
                          ? base
                            ? `слита в ${base}`
                            : "слита"
                          : unmergedLabel(branch.unmergedCommitCount)
                      }
                      warning={!branch.merged}
                    />
                  );
                })}
              </CleanupGroup>
            ) : null}
            {offerAlways ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={always}
                  disabled={busy}
                  onCheckedChange={(checked) => setAlways(checked === true)}
                />
                Делать так всегда
              </label>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={busy} />}>
            Оставить
          </DialogClose>
          <Button
            size="sm"
            disabled={busy || (nothingChecked && !always)}
            onClick={() => void submit()}
          >
            Убрать отмеченные
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CleanupGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function CleanupRow({
  checked,
  disabled,
  onToggle,
  project,
  branch,
  status,
  warning,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly project: string;
  readonly branch: string;
  readonly status: string;
  readonly warning: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <span className="w-24 shrink-0 truncate">{project}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch}</span>
      <span
        className={
          warning
            ? "shrink-0 text-xs text-warning-foreground"
            : "shrink-0 text-xs text-muted-foreground"
        }
      >
        {status}
      </span>
    </label>
  );
}
