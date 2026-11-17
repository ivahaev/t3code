import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, Task } from "@t3tools/contracts";
import { useState } from "react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useScratchProject } from "~/hooks/useScratchProject";

import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastTaskCommandFailure } from "./taskCommandToast";
import { TaskField } from "./taskDialogParts";

export interface TaskEditorTarget {
  readonly environmentId: EnvironmentId;
  /** Null creates a task in the backlog. */
  readonly task: Task | null;
}

export function TaskEditorDialog({
  target,
  environments,
  onClose,
}: {
  readonly target: TaskEditorTarget;
  /** Environments a new task can be created in; an existing task stays where it is. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <TaskEditorForm
          target={target}
          environments={environments}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

function TaskEditorForm({
  target,
  environments,
  saving,
  onSavingChange,
  onClose,
}: {
  readonly target: TaskEditorTarget;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const { task } = target;
  const [environmentId, setEnvironmentId] = useState(target.environmentId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [link, setLink] = useState(task?.link ?? "");
  // Selection order matters: the first project is where the task's first chat starts.
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>(
    task
      ? [task.primaryProjectId, ...task.projectIds.filter((id) => id !== task.primaryProjectId)]
      : [],
  );
  const { scratchWorkspaceRootFor } = useScratchProject();
  // "No project" has no repository, so a task can't make worktrees in it.
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !isScratchProject(project, scratchWorkspaceRootFor(environmentId)) &&
      (project.archivedAt == null || projectIds.includes(project.id)),
  );
  const canSave = useAtomValue(tasksEnvironment.upsertTask.permissionAtom(environmentId));
  const upsertTask = useAtomCommand(tasksEnvironment.upsertTask, { label: "task upsert" });
  const primaryProjectId = projectIds[0];
  const valid = title.trim().length > 0 && primaryProjectId !== undefined;

  const submit = async () => {
    if (!valid || saving || !canSave) return;
    onSavingChange(true);
    const result = await upsertTask({
      environmentId,
      input: {
        ...(task ? { id: task.id } : {}),
        title: title.trim(),
        description,
        link: link.trim() === "" ? null : link.trim(),
        primaryProjectId,
        projectIds,
      },
    });
    onSavingChange(false);
    if (toastTaskCommandFailure("Couldn't save task", result)) return;
    onClose();
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
        <DialogDescription>
          {task
            ? "Changes apply to the task card. Its threads keep their own titles."
            : "The task starts in Backlog. Start it to open its first thread."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {task === null && environments.length > 1 ? (
            <TaskField label="Environment" htmlFor="task-environment">
              <Select
                value={environmentId}
                onValueChange={(next) => {
                  if (next === null || next === environmentId) return;
                  setEnvironmentId(next);
                  setProjectIds([]);
                }}
              >
                <SelectTrigger id="task-environment" size="sm">
                  <SelectValue>
                    {environments.find((entry) => entry.environmentId === environmentId)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
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
            </TaskField>
          ) : null}
          <TaskField label="Title" htmlFor="task-title">
            <Input
              id="task-title"
              autoFocus
              placeholder="What needs to be done"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </TaskField>
          <TaskField
            label="Description"
            hint="Sent to the agent on start"
            htmlFor="task-description"
          >
            <Textarea
              id="task-description"
              className="max-h-64 overflow-y-auto"
              placeholder="Context, acceptance criteria, links"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </TaskField>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 flex w-full items-baseline justify-between text-sm font-medium">
              <span>Projects</span>
              <span className="font-normal text-2xs text-muted-foreground/80">
                The first one is where the task starts
              </span>
            </legend>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">No projects in this environment.</p>
            ) : (
              <ul className="max-h-48 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/70">
                {projects.map((project) => {
                  const checked = projectIds.includes(project.id);
                  return (
                    <li key={project.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/50">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            setProjectIds((current) =>
                              next
                                ? [...current.filter((id) => id !== project.id), project.id]
                                : current.filter((id) => id !== project.id),
                            )
                          }
                        />
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{project.title}</span>
                        {project.id === primaryProjectId ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            Starts here
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <TaskField label="Link" hint="Optional" htmlFor="task-link">
            <Input
              id="task-link"
              type="url"
              placeholder="https://"
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </TaskField>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button type="submit" size="sm" disabled={!valid || saving || !canSave}>
          {task ? "Save task" : "Create task"}
        </Button>
      </DialogFooter>
    </form>
  );
}
