import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, Task } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState, type ReactNode } from "react";

import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
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
  plural,
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
  return `${count} ${plural(count, "uncommitted file", "uncommitted files")}`;
}

function unmergedLabel(count: number): string {
  if (count === 0) return "Not merged";
  return `${count} ${plural(count, "unmerged commit", "unmerged commits")}`;
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
      toastTaskCommandFailure("Couldn't save cleanup setting", result);
    }
    if (!nothingChecked) {
      const result = await cleanupTask({
        environmentId,
        input: { id: task.id, ...cleanupSelectionInput(preview, selection) },
      });
      if (toastTaskCommandFailure("Couldn't clean up task", result)) {
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
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Clean up after “{task.title}”?</DialogTitle>
          <DialogDescription>
            The task is done. Remove its worktrees and local branches. Remote branches and the
            task's threads stay.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {preview.worktrees.length > 0 ? (
              <CleanupGroup title="Worktrees">
                {preview.worktrees.map((worktree) => (
                  <CleanupRow
                    key={worktree.path}
                    checked={selection.worktrees.has(worktree.path)}
                    disabled={busy}
                    onToggle={() => setSelection(toggleWorktree(selection, preview, worktree.path))}
                    project={projectTitle(worktree.projectId)}
                    branch={worktree.branch}
                    status={
                      worktree.dirtyFileCount === 0 ? "Clean" : dirtyLabel(worktree.dirtyFileCount)
                    }
                    warning={worktree.dirtyFileCount > 0}
                  />
                ))}
              </CleanupGroup>
            ) : null}
            {preview.branches.length > 0 ? (
              <CleanupGroup title="Local branches">
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
                            ? `Merged into ${base}`
                            : "Merged"
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
                Always clean up finished tasks
              </label>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            Keep all
          </DialogClose>
          <Button
            size="sm"
            disabled={busy || (nothingChecked && !always)}
            onClick={() => void submit()}
          >
            Clean up selected
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
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border/50 rounded-xl border border-border/70">{children}</div>
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
    <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/50">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs">{branch}</span>
        <span className="truncate text-xs text-muted-foreground">{project}</span>
      </span>
      {warning ? (
        <Badge variant="warning" className="shrink-0">
          {status}
        </Badge>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      )}
    </label>
  );
}
